using System;
using System.Collections.Generic;
using System.Linq;
using UnityEngine;

public sealed class CrawlWorldCapture
{
    // Unity 2022 exposes the resolved queue publicly but keeps the raw override
    // internal. Bind the pinned getter so null-graphics fallbacks cannot leak
    // their queue into the WebGL renderer.
    private static readonly Func<Material, int> rawQueue = (Func<Material, int>)Delegate.CreateDelegate(typeof(Func<Material, int>),
        typeof(Material).GetMethod("get_rawRenderQueue", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.NonPublic));
    public static int GetRawRenderQueue(Material material) { return rawQueue(material); }
    private readonly CrawlVisualCatalog catalog;
    private readonly string contentHash;
    private readonly Dictionary<exSprite, uint> spriteIds = new Dictionary<exSprite, uint>();
    private readonly Dictionary<Room, uint> roomIds = new Dictionary<Room, uint>();
    private readonly Dictionary<TextMesh, uint> textIds = new Dictionary<TextMesh, uint>();
    private uint lastSprite, lastRoom, lastText;
    public CrawlWorldCapture(CrawlVisualCatalog assets, string hash) { catalog = assets; contentHash = hash; }
    public CrawlWorldFrame Capture()
    {
        var registry = CrawlEntityRegistry.Current; var input = CrawlAuthorityInput.Current;
        Camera camera = Singleton<SystemMain>.HasInstance() ? SystemMain.GetCameraMain() : null;
        // Unity's destroyed-object null differs from CLR null. The main camera
        // is destroyed when entering evolution; ?? would keep that dead object.
        if (camera == null && Singleton<SystemMain>.HasInstance()) camera = SystemMain.GetCameraMenu();
        if (registry == null || input == null || camera == null) return null;
        // Called only after CrawlHeadlessSpriteCommit; exporting is read-only.
        input.PrepareStatus(); registry.PruneDestroyed();
        var frame = new CrawlWorldFrame { contentHash = contentHash, sceneEpoch = input.SceneEpoch, netTick = input.NetTick,
            simTick = input.SimTick, paused = SystemTime.Paused, view = camera.worldToCameraMatrix, projection = camera.projectionMatrix, background = camera.backgroundColor };
        Camera[] cameras = UnityEngine.Object.FindObjectsOfType<Camera>().Where(c => c.enabled && c.targetTexture == null).OrderBy(c => c.depth).ToArray();
        frame.cameras = cameras.Select(c => new CrawlWorldFrame.CameraState { view = c.worldToCameraMatrix, projection = c.projectionMatrix,
            background = c.backgroundColor, mask = c.cullingMask, clearFlags = (int)c.clearFlags, depth = c.depth, rect = new Vector4(c.rect.x, c.rect.y, c.rect.width, c.rect.height) }).ToArray();
        int visibleMask = cameras.Aggregate(0, (mask, c) => mask | c.cullingMask);
        frame.entities = registry.Entities.Where(e => e.ready && e.instance != null).OrderBy(e => e.entityId).Select(e => {
            var health = e.instance.GetComponent<Health>(); var player = e.instance.GetComponent<Player>(); var rigidbody = e.instance.GetComponent<Rigidbody>();
            return new CrawlWorldFrame.Entity { id = e.entityId, prefab = e.prefabId, active = e.instance.activeInHierarchy,
                position = e.instance.transform.position, velocity = rigidbody == null ? Vector3.zero : rigidbody.velocity,
                health = health == null ? 0 : health.GetHealthCurrent(), maxHealth = health == null ? 0 : health.GetHealthMax(), state = player == null ? "" : player.GetState().ToString() };
        }).ToArray();
        foreach (var key in roomIds.Keys.Where(k => k == null).ToArray()) roomIds.Remove(key);
        Room[] rooms = UnityEngine.Object.FindObjectsOfType<Room>(true);
        foreach (var room in rooms) if (!roomIds.ContainsKey(room)) roomIds.Add(room, Allocate(ref lastRoom));
        Room current = Singleton<SystemLevel>.HasInstance() ? SystemLevel.GetCurrentRoom() : null;
        frame.currentRoom = current == null ? 0 : roomIds[current];
        frame.rooms = rooms.OrderBy(room => roomIds[room]).Select(room => new CrawlWorldFrame.RoomState { id = roomIds[room],
            position = room.transform.position, seen = room.GetSeenRoom(), doors = (room.m_doors ?? new List<DoorData>()).Select(d => new CrawlWorldFrame.DoorState {
                target = d.m_room == null ? 0 : roomIds[d.m_room], position = d.m_position, direction = (byte)d.m_direction,
                open = d.m_doorObject != null && d.m_doorObject.GetOpen(), blocked = d.m_doorObject != null && d.m_doorObject.GetBlocked() }).ToArray() }).ToArray();
        frame.actors = new CrawlWorldFrame.Actor[4];
        for (int i = 0; i < 4; i++)
        {
            var data = SystemPlayers.GetPlayer(i); var slot = input.GetSlot(i);
            frame.actors[i] = new CrawlWorldFrame.Actor { entity = slot.entityId, revision = slot.revision,
                active = data != null && data.IsActive, alive = data != null && data.IsAlive, hero = data != null && data.IsHero, menu = slot.menu };
        }
        foreach (var key in spriteIds.Keys.Where(k => k == null).ToArray()) spriteIds.Remove(key);
        var sprites = new List<CrawlWorldFrame.Sprite>(); var palettes = new Dictionary<uint, CrawlWorldFrame.Palette>();
        foreach (var sprite in UnityEngine.Object.FindObjectsOfType<exSprite>())
        {
            var renderer = sprite.GetComponent<Renderer>();
            // renderCamera selects the ex2D commit manager, not visibility.
            if (renderer == null || !renderer.enabled || (visibleMask & (1 << sprite.gameObject.layer)) == 0) continue;
            Mesh mesh = sprite.meshFilter == null ? null : sprite.meshFilter.sharedMesh;
            Material material = renderer.sharedMaterial;
            if (mesh == null || mesh.vertexCount == 0 || material == null) continue; // Cleared/unfinished sprites do not draw.
            if (mesh.vertexCount != 4) throw new InvalidOperationException("Unexpected exSprite geometry: " + sprite.name);
            uint visualId;
            if (!spriteIds.TryGetValue(sprite, out visualId)) { visualId = Allocate(ref lastSprite); spriteIds.Add(sprite, visualId); }
            Vector3[] vertices = mesh.vertices; Vector2[] uv = mesh.uv; Color32[] colors = mesh.colors32;
            if (uv.Length != 4 || colors.Length != 4) throw new InvalidOperationException("Uncommitted exSprite geometry: " + sprite.name);
            Vector3 pivot = sprite.transform.position;
            for (int i = 0; i < 4; i++) vertices[i] = sprite.transform.TransformPoint(vertices[i]) - pivot;
            uint entity = 0;
            for (Transform parent = sprite.transform; parent != null && entity == 0; parent = parent.parent) entity = registry.FindId(parent.gameObject);
            var state = new CrawlWorldFrame.Sprite { id = visualId, entity = entity, texture = catalog.TextureId(material.mainTexture), shader = catalog.ShaderId(material.shader),
                // Null graphics resolves unsupported GLSL shaders through a
                // fallback (hero reports 2000). Preserve the explicit override
                // instead; -1 lets WebGL use the real shader's transparent queue.
                layer = sprite.gameObject.layer, sortingLayer = renderer.sortingLayerID, sortingOrder = renderer.sortingOrder, renderQueue = GetRawRenderQueue(material),
                pivot = pivot, vertices = vertices, uv = uv, colors = colors, tint = material.HasProperty("_Tint") ? material.GetColor("_Tint") : Color.clear,
                clipped = material.HasProperty("_ClipRect") };
            Vector2 scale = material.mainTextureScale, offset = material.mainTextureOffset;
            state.textureST = new Vector4(scale.x, scale.y, offset.x, offset.y);
            if (state.clipped) { state.clipRect = material.GetVector("_ClipRect"); state.clipMatrix = material.GetMatrix("_ClipMatrix"); }
            if (material.HasProperty("_ColorRamp"))
            {
                var texture = material.GetTexture("_ColorRamp") as Texture2D;
                if (texture != null)
                {
                    state.palette = catalog.TextureId(texture);
                    if (texture.isReadable && texture.width == 256 && texture.height == 64 && !palettes.ContainsKey(state.palette))
                    {
                        // Only mutable game palettes need their pixels sent. Other
                        // ramps still resolve to their original catalog texture.
                        palettes.Add(state.palette, new CrawlWorldFrame.Palette { id = state.palette, width = 256, height = 64, pixels = texture.GetPixels32() });
                    }
                }
            }
            sprites.Add(state);
        }
        frame.sprites = sprites.OrderBy(s => s.id).ToArray(); frame.palettes = palettes.Values.OrderBy(p => p.id).ToArray();
        foreach (var key in textIds.Keys.Where(k => k == null).ToArray()) textIds.Remove(key);
        var texts = new List<CrawlWorldFrame.TextState>();
        foreach (var text in UnityEngine.Object.FindObjectsOfType<TextMesh>())
        {
            var renderer = text.GetComponent<Renderer>();
            if (renderer == null || !renderer.enabled || string.IsNullOrEmpty(text.text) || (visibleMask & (1 << text.gameObject.layer)) == 0) continue;
            uint id; if (!textIds.TryGetValue(text, out id)) { id = Allocate(ref lastText); textIds.Add(text, id); }
            var materials = renderer.sharedMaterials.Select((m, index) => new CrawlWorldFrame.TextMaterial {
                texture = index == 0 ? 0 : catalog.TextureId(m.mainTexture), shader = index == 0 ? 0 : catalog.ShaderId(m.shader), renderQueue = GetRawRenderQueue(m),
                offsetY = m.HasProperty("_OffsetY") ? m.GetFloat("_OffsetY") : 0 }).ToArray();
            texts.Add(new CrawlWorldFrame.TextState { id = id, font = catalog.FontId(text.font), text = text.text, position = text.transform.position,
                rotation = text.transform.rotation, scale = text.transform.lossyScale, layer = text.gameObject.layer, sortingLayer = renderer.sortingLayerID, sortingOrder = renderer.sortingOrder,
                fontSize = text.fontSize, fontStyle = (int)text.fontStyle, anchor = (int)text.anchor, alignment = (int)text.alignment,
                characterSize = text.characterSize, lineSpacing = text.lineSpacing, offsetZ = text.offsetZ, tabSize = text.tabSize, richText = text.richText, color = text.color, materials = materials });
        }
        frame.texts = texts.OrderBy(t => t.id).ToArray(); frame.audio = CrawlAudioCapture.Capture();
        if (frame.entities.Length > CrawlWorldFrameCodec.MaxEntities || frame.sprites.Length > CrawlWorldFrameCodec.MaxSprites ||
            frame.rooms.Length > CrawlWorldFrameCodec.MaxRooms || frame.palettes.Length > CrawlWorldFrameCodec.MaxPalettes) throw new InvalidOperationException("World exceeds the agreed snapshot limits.");
        return frame;
    }
    private static uint Allocate(ref uint previous)
    { if (previous == uint.MaxValue) throw new InvalidOperationException("World identity exhausted."); return ++previous; }
}
