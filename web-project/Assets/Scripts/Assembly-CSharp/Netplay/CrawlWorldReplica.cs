using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using UnityEngine;
using Object = UnityEngine.Object;

// This is the entire client world: camera, meshes and materials. No original
// Player, Health, Collider, Rigidbody, exSprite or animation event component.
public sealed class CrawlWorldReplica : IDisposable
{
    private static readonly int[] quadIndices = { 0, 1, 2, 2, 1, 3 };
    private sealed class Visual
    {
        public GameObject gameObject;
        public Mesh mesh;
        public MeshRenderer renderer;
        public Material material;
        public Texture2D palette;
        public Vector3 displayedPosition;
        public CrawlWorldFrame.Sprite previous;
    }
    private readonly CrawlVisualCatalog assets;
    private readonly Dictionary<uint, Visual> visuals = new Dictionary<uint, Visual>();
    private sealed class PaletteVisual { public Texture2D texture; public Color32[] pixels; }
    private readonly Dictionary<uint, PaletteVisual> palettes = new Dictionary<uint, PaletteVisual>();
    private sealed class TextVisual
    {
        public TextMesh text;
        public MeshRenderer renderer;
        public Material[] materials;
        public CrawlWorldFrame.TextState previous;
    }
    private readonly Dictionary<uint, TextVisual> texts = new Dictionary<uint, TextVisual>();
    private readonly List<Camera> extraCameras = new List<Camera>();
    private readonly List<Camera> worldCameras = new List<Camera>();
    private const double PresentationDelayTicks = 5;
    private const double MaxCoastTicks = 3;
    private readonly PositionHistory cameraMotion = new PositionHistory();
    private Vector3 renderedCameraPosition;
    private double playbackTick, lastPresentationAt, holdStartedAt, peakHold;
    private sealed class PositionHistory
    {
        private readonly List<(uint tick, Vector3 position)> samples = new List<(uint, Vector3)>(8);
        public Vector3 Target { get { return samples[samples.Count - 1].position; } }

        public void Add(Vector3 position, uint tick, bool continuous)
        {
            if (!continuous || (samples.Count > 0 && (position - Target).sqrMagnitude > 144))
                samples.Clear();
            if (samples.Count == 8) samples.RemoveAt(0);
            samples.Add((tick, position));
        }

        public Vector3 At(double tick, bool coast)
        {
            for (int i = 1; i < samples.Count; i++)
            {
                var left = samples[i - 1];
                var right = samples[i];
                if (tick <= right.tick)
                    return Vector3.Lerp(left.position, right.position, (float)((tick - left.tick) / (right.tick - left.tick)));
            }
            if (coast && samples.Count >= 2 && tick > samples[samples.Count - 1].tick)
            {
                var newest = samples[samples.Count - 1];
                var previous = samples[samples.Count - 2];
                double lead = Math.Min(tick - newest.tick, MaxCoastTicks);
                float eased = (float)(lead * (1 - .5 * lead / MaxCoastTicks) / (newest.tick - previous.tick));
                return newest.position + (newest.position - previous.position) * eased;
            }
            return Target;
        }
    }
    private sealed class ActorVisual
    {
        public CrawlWorldFrame.Entity entity;
        public uint revision;
        public bool canCoast;
        public readonly PositionHistory motion = new PositionHistory();
        public readonly List<Visual> sprites = new List<Visual>();
        public Vector3 appliedOffset;
    }
    private readonly ActorVisual[] actors = { new ActorVisual(), new ActorVisual(), new ActorVisual(), new ActorVisual() };
    private readonly Dictionary<uint, ActorVisual> actorsById = new Dictionary<uint, ActorVisual>();
    private readonly CrawlAudioReplica audio;
    private GameObject root, cameraHost;
    private Camera camera;
    private uint scene;
    public CrawlWorldFrame Current { get; private set; }
    public int SpriteCount { get { return visuals.Count; } }
    private uint movingEntity, movementTick, movementScene, movementRoom, movementRevision;
    private Vector2 shown, confirmed, lastIntent;
    private float unchangedTime, speed = 45;
    // Predict only the local walking visual. Combat and collision outcomes
    // arrive with the next authority frame. Never move the simulation entity.
    public bool PresentMovement(int slot, Vector2 intent, bool mouse, bool canControl, double now, float dt, out Vector2 position)
    {
        position = Vector2.zero;
        if (Current == null) return false;
        double available = Current.netTick - playbackTick;
        double pace = 1 + Math.Max(-.1, Math.Min(.1, (available - PresentationDelayTicks) * .025));
        bool inRoom = !Current.paused && Current.currentRoom != 0;
        double limit = Current.netTick + (inRoom ? MaxCoastTicks : 0);
        playbackTick = Math.Min(limit, playbackTick + Math.Max(0, now - lastPresentationAt) * 60 * pace);
        if (inRoom && playbackTick >= limit)
        {
            if (holdStartedAt == 0) holdStartedAt = now;
            peakHold = Math.Max(peakHold, now - holdStartedAt);
        }
        else holdStartedAt = 0;
        lastPresentationAt = now;
        if (!canControl) movingEntity = 0;
        bool predicted = canControl && PredictMovement(slot, intent, mouse, dt, out position);
        foreach (var visual in actorsById.Values)
        {
            Vector3 origin = visual.entity.position;
            Vector3 offset = predicted && visual.entity.id == movingEntity
                ? (Vector3)(position - (Vector2)origin)
                : visual.motion.At(playbackTick, inRoom && visual.canCoast) - origin;
            if (offset.Equals(visual.appliedOffset)) continue;
            foreach (var sprite in visual.sprites) SetPosition(sprite, sprite.previous.pivot + offset);
            visual.appliedOffset = offset;
        }
        if (worldCameras.Count != 0)
        {
            Vector3 cameraPosition = cameraMotion.At(playbackTick, inRoom);
            if (!cameraPosition.Equals(renderedCameraPosition))
            {
                Matrix4x4 view = Current.view * Matrix4x4.Translate(cameraMotion.Target - cameraPosition);
                foreach (var worldCamera in worldCameras)
                {
                    worldCamera.transform.position = cameraPosition;
                    worldCamera.worldToCameraMatrix = view;
                }
                renderedCameraPosition = cameraPosition;
            }
        }
        return predicted;
    }
    public double ReadAndResetPeakHold() { double duration = peakHold; peakHold = 0; return duration; }

    private static void SetPosition(Visual visual, Vector3 position)
    {
        if (visual.displayedPosition.Equals(position)) return;
        visual.gameObject.transform.position = position;
        visual.displayedPosition = position;
    }
    private bool PredictMovement(int slot, Vector2 intent, bool mouse, float dt, out Vector2 position)
    {
        position = Vector2.zero;
        var actor = Current.actors[slot];
        var entity = actors[slot].entity;
        if (entity == null) { movingEntity = 0; return false; }
        Vector2 origin = entity.position;
        if (Current.paused || actor.menu || !actor.alive || (entity.state != "Idle" && entity.state != "Run" && entity.state != "Move" && entity.state != "CutsceneInterruptible"))
        { movingEntity = 0; position = origin; return false; }
        intent = mouse ? PointerDirection(intent, entity.position) : Vector2.ClampMagnitude(intent, 1);
        if (movingEntity != entity.id || movementScene != Current.sceneEpoch || movementRoom != Current.currentRoom ||
            movementRevision != actor.revision || Current.netTick < movementTick || (origin - confirmed).sqrMagnitude > 144)
        {
            movingEntity = entity.id; movementScene = Current.sceneEpoch; movementRoom = Current.currentRoom;
            movementRevision = actor.revision; movementTick = Current.netTick;
            shown = confirmed = origin; unchangedTime = 0; speed = 45;
        }
        if ((intent - lastIntent).sqrMagnitude > .04f) unchangedTime = 0;
        if (movementTick != Current.netTick)
        {
            float elapsed = Mathf.Max(1, Current.netTick - movementTick) / 60f;
            Vector2 step = origin - confirmed;
            if (step.sqrMagnitude > .01f) { speed = Mathf.Clamp(step.magnitude / elapsed, 20, 100); unchangedTime = 0; }
            else unchangedTime += elapsed;
            movementTick = Current.netTick; confirmed = origin;
        }
        lastIntent = intent;
        if (unchangedTime > .20f || intent == Vector2.zero)
            shown = Vector2.MoveTowards(shown, origin, 120 * dt);
        else {
            shown += intent * speed * Mathf.Min(dt, .035f);
            Vector2 offset = shown - origin;
            shown = Vector2.Dot(offset, intent) < 0
                ? Vector2.MoveTowards(shown, origin, 120 * dt)
                : origin + Vector2.ClampMagnitude(offset, 3);
        }
        position = shown;
        return true;
    }
    private Vector2 PointerDirection(Vector2 screen, Vector3 origin)
    {
        Ray ray = camera.ViewportPointToRay(new Vector3(screen.x, 1 - screen.y, 0));
        var plane = new Plane(Vector3.forward, origin);
        if (!plane.Raycast(ray, out float distance)) return Vector2.zero;
        Vector2 offset = ray.GetPoint(distance) - origin;
        float magnitude = offset.magnitude;
        // Keep speculative movement within the existing presentation limit.
        return magnitude <= 8 ? Vector2.zero : offset / magnitude * Mathf.Lerp(.2f, 1, Mathf.InverseLerp(8, 20, magnitude));
    }
    public CrawlWorldReplica(CrawlVisualCatalog catalog)
    {
        assets = catalog;
        audio = new CrawlAudioReplica(catalog);
        cameraHost = new GameObject("Replica camera"); camera = cameraHost.AddComponent<Camera>();
        camera.orthographic = true; camera.cullingMask = 1; camera.clearFlags = CameraClearFlags.SolidColor;
        camera.backgroundColor = Color.black;
    }
    public void Apply(CrawlWorldFrame frame) { Apply(frame, Time.realtimeSinceStartupAsDouble); }
    public void Apply(CrawlWorldFrame frame, double now)
    {
        Validate(frame);
        if (root == null || scene != frame.sceneEpoch)
        {
            ClearWorld(); root = new GameObject("Authoritative world replica"); root.SetActive(false); scene = frame.sceneEpoch;
        }
        bool continuous = Current != null && Current.currentRoom == frame.currentRoom && frame.currentRoom != 0 &&
            !Current.paused && !frame.paused && frame.netTick > Current.netTick && frame.netTick - Current.netTick <= 18;
        if (!continuous) { playbackTick = frame.netTick - PresentationDelayTicks; lastPresentationAt = now; holdStartedAt = 0; }
        PrepareActors(frame, continuous);
        foreach (var p in frame.palettes)
        {
            if (!palettes.TryGetValue(p.id, out var palette))
            {
                Texture2D source = assets.Texture(p.id);
                var texture = new Texture2D(p.width, p.height, TextureFormat.RGBA32, false, !UnityEngine.Experimental.Rendering.GraphicsFormatUtility.IsSRGBFormat(source.graphicsFormat));
                texture.filterMode = source.filterMode; texture.wrapMode = source.wrapMode;
                palette = new PaletteVisual { texture = texture };
                palettes.Add(p.id, palette);
            }
            if (palette.pixels != null && SameData(palette.pixels, p.pixels)) continue;
            palette.texture.SetPixels32(p.pixels); palette.texture.Apply(false, false);
            palette.pixels = p.pixels;
        }
        var active = new HashSet<uint>();
        foreach (var s in frame.sprites)
        {
            active.Add(s.id); Visual v;
            bool created = !visuals.TryGetValue(s.id, out v);
            if (created)
            {
                v = new Visual { gameObject = new GameObject("Visual " + s.id), mesh = new Mesh() };
                v.gameObject.transform.SetParent(root.transform, false);
                v.gameObject.AddComponent<MeshFilter>().sharedMesh = v.mesh;
                v.renderer = v.gameObject.AddComponent<MeshRenderer>();
                v.renderer.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off; v.renderer.receiveShadows = false;
                v.mesh.MarkDynamic(); visuals.Add(s.id, v);
            }
            SetPosition(v, s.pivot);
            var previous = v.previous;
            if (created || previous.layer != s.layer) v.gameObject.layer = s.layer;
            bool geometryChanged = created || !SameData(previous.vertices, s.vertices);
            if (geometryChanged) v.mesh.vertices = s.vertices;
            if (created || !SameData(previous.uv, s.uv)) v.mesh.uv = s.uv;
            if (created || !SameData(previous.colors, s.colors)) v.mesh.colors32 = s.colors;
            if (created) v.mesh.triangles = quadIndices;
            if (geometryChanged) v.mesh.RecalculateBounds();
            if (created || previous.sortingLayer != s.sortingLayer) v.renderer.sortingLayerID = s.sortingLayer;
            if (created || previous.sortingOrder != s.sortingOrder) v.renderer.sortingOrder = s.sortingOrder;
            ApplyMaterial(v, s);
            v.previous = s;
            if (actorsById.TryGetValue(s.entity, out var actor)) actor.sprites.Add(v);
        }
        foreach (uint id in visuals.Keys.Where(id => !active.Contains(id)).ToArray()) { DestroyVisual(visuals[id]); visuals.Remove(id); }
        var paletteIds = new HashSet<uint>(frame.palettes.Select(p => p.id));
        foreach (uint id in palettes.Keys.Where(id => !paletteIds.Contains(id)).ToArray()) { Release(palettes[id].texture); palettes.Remove(id); }
        var textSet = new HashSet<uint>();
        foreach (var t in frame.texts)
        {
            textSet.Add(t.id); TextVisual v;
            if (!texts.TryGetValue(t.id, out v))
            {
                var host = new GameObject("Text " + t.id); host.transform.SetParent(root.transform, false);
                v = new TextVisual { text = host.AddComponent<TextMesh>() }; v.renderer = host.GetComponent<MeshRenderer>(); texts.Add(t.id, v);
            }
            ApplyText(v, t);
        }
        foreach (uint id in texts.Keys.Where(id => !textSet.Contains(id)).ToArray()) { DestroyText(texts[id]); texts.Remove(id); }
        Matrix4x4 inverse = frame.view.inverse;
        camera.transform.position = inverse.GetColumn(3);
        camera.transform.rotation = Quaternion.LookRotation(inverse.MultiplyVector(Vector3.back), inverse.MultiplyVector(Vector3.up));
        camera.worldToCameraMatrix = frame.view; camera.projectionMatrix = frame.projection; camera.backgroundColor = frame.background;
        camera.enabled = frame.cameras.Length == 0;
        bool hadWorldCamera = worldCameras.Count != 0;
        worldCameras.Clear();
        while (extraCameras.Count < frame.cameras.Length) { var host = new GameObject("Replica view " + extraCameras.Count); extraCameras.Add(host.AddComponent<Camera>()); }
        for (int i = 0; i < extraCameras.Count; i++)
        {
            Camera view = extraCameras[i]; view.enabled = i < frame.cameras.Length; if (!view.enabled) continue;
            var c = frame.cameras[i]; Matrix4x4 inv = c.view.inverse;
            view.transform.position = inv.GetColumn(3); view.transform.rotation = Quaternion.LookRotation(inv.MultiplyVector(Vector3.back), inv.MultiplyVector(Vector3.up));
            view.orthographic = true; view.worldToCameraMatrix = c.view; view.projectionMatrix = c.projection; view.backgroundColor = c.background;
            view.cullingMask = c.mask; view.clearFlags = (CameraClearFlags)c.clearFlags; view.depth = c.depth; view.rect = new Rect(c.rect.x, c.rect.y, c.rect.z, c.rect.w);
            if (c.view.Equals(frame.view) && c.projection.Equals(frame.projection)) worldCameras.Add(view);
        }
        renderedCameraPosition = inverse.GetColumn(3);
        cameraMotion.Add(renderedCameraPosition, frame.netTick, hadWorldCamera && worldCameras.Count != 0 && continuous);
        audio.Apply(frame.audio); Current = frame; root.SetActive(true);
    }
    private void PrepareActors(CrawlWorldFrame frame, bool continuous)
    {
        actorsById.Clear();
        for (int slot = 0; slot < actors.Length; slot++)
        {
            var visual = actors[slot];
            var actor = frame.actors[slot];
            var previous = visual.entity;
            visual.sprites.Clear(); visual.appliedOffset = Vector3.zero;
            visual.entity = actor.entity == 0 ? null : Array.Find(frame.entities, entity => entity.id == actor.entity);
            if (visual.entity == null) continue;
            bool sameActor = previous != null && previous.id == actor.entity && visual.revision == actor.revision;
            visual.motion.Add(visual.entity.position, frame.netTick, sameActor && continuous && !actor.menu);
            visual.revision = actor.revision;
            visual.canCoast = actor.alive && !actor.menu && (visual.entity.state == "Run" || visual.entity.state == "Move");
            actorsById[actor.entity] = visual;
        }
    }
    private static bool SameData<T>(T[] previous, T[] current) where T : struct
    {
        return ReferenceEquals(previous, current) || MemoryMarshal.AsBytes(new ReadOnlySpan<T>(previous))
            .SequenceEqual(MemoryMarshal.AsBytes(new ReadOnlySpan<T>(current)));
    }
    private void ApplyMaterial(Visual v, CrawlWorldFrame.Sprite sprite)
    {
        var previous = v.previous;
        bool created = previous == null || previous.shader != sprite.shader;
        if (created)
        {
            if (v.material != null) Release(v.material);
            v.material = new Material(assets.Shader(sprite.shader));
            v.renderer.sharedMaterial = v.material;
        }
        var material = v.material;
        if (created || previous.texture != sprite.texture) material.mainTexture = assets.Texture(sprite.texture);
        if (created || previous.renderQueue != sprite.renderQueue) material.renderQueue = sprite.renderQueue;
        if (created || !previous.textureST.Equals(sprite.textureST))
        {
            material.mainTextureScale = new Vector2(sprite.textureST.x, sprite.textureST.y);
            material.mainTextureOffset = new Vector2(sprite.textureST.z, sprite.textureST.w);
        }
        if ((created || !previous.tint.Equals(sprite.tint)) && material.HasProperty("_Tint"))
            material.SetColor("_Tint", sprite.tint);
        Texture2D palette = null;
        if (sprite.palette != 0)
            palette = palettes.TryGetValue(sprite.palette, out var visual) ? visual.texture : assets.Texture(sprite.palette);
        if (created ? palette != null : palette != v.palette) material.SetTexture("_ColorRamp", palette);
        v.palette = palette;
        if (sprite.clipped && (created || !previous.clipped || !previous.clipRect.Equals(sprite.clipRect) || !previous.clipMatrix.Equals(sprite.clipMatrix)))
        {
            material.SetVector("_ClipRect", sprite.clipRect);
            material.SetMatrix("_ClipMatrix", sprite.clipMatrix);
        }
    }
    private void ApplyText(TextVisual v, CrawlWorldFrame.TextState state)
    {
        var text = v.text;
        var previous = v.previous;
        bool created = previous == null;
        if (created || previous.layer != state.layer) text.gameObject.layer = state.layer;
        if (created || !previous.position.Equals(state.position)) text.transform.position = state.position;
        if (created || !previous.rotation.Equals(state.rotation)) text.transform.rotation = state.rotation;
        if (created || !previous.scale.Equals(state.scale)) text.transform.localScale = state.scale;
        if (created || previous.font != state.font) text.font = assets.Font(state.font);
        if (created || previous.fontSize != state.fontSize) text.fontSize = state.fontSize;
        if (created || previous.fontStyle != state.fontStyle) text.fontStyle = (FontStyle)state.fontStyle;
        if (created || previous.anchor != state.anchor) text.anchor = (TextAnchor)state.anchor;
        if (created || previous.alignment != state.alignment) text.alignment = (TextAlignment)state.alignment;
        if (created || previous.characterSize != state.characterSize) text.characterSize = state.characterSize;
        if (created || previous.lineSpacing != state.lineSpacing) text.lineSpacing = state.lineSpacing;
        if (created || previous.offsetZ != state.offsetZ) text.offsetZ = state.offsetZ;
        if (created || previous.tabSize != state.tabSize) text.tabSize = state.tabSize;
        if (created || previous.richText != state.richText) text.richText = state.richText;
        if (created || !previous.color.Equals(state.color)) text.color = state.color;
        if (created || previous.text != state.text) text.text = state.text;
        bool materialsChanged = created || previous.font != state.font || v.materials.Length != state.materials.Length;
        for (int i = 0; !materialsChanged && i < v.materials.Length; i++)
            materialsChanged = v.materials[i].shader != TextShader(state, state.materials[i]);
        if (materialsChanged)
        {
            if (v.materials != null) foreach (var material in v.materials) Release(material);
            v.materials = state.materials.Select(m => new Material(TextShader(state, m))).ToArray();
            v.renderer.sharedMaterials = v.materials;
        }
        for (int i = 0; i < v.materials.Length; i++)
        {
            var material = v.materials[i]; var source = state.materials[i];
            var texture = source.texture == 0 ? text.font.material.mainTexture : assets.Texture(source.texture);
            if (material.mainTexture != texture) material.mainTexture = texture;
            if (materialsChanged || previous.materials[i].renderQueue != source.renderQueue) material.renderQueue = source.renderQueue;
            if ((materialsChanged || previous.materials[i].offsetY != source.offsetY) && material.HasProperty("_OffsetY"))
                material.SetFloat("_OffsetY", source.offsetY);
        }
        if (created || previous.sortingLayer != state.sortingLayer) v.renderer.sortingLayerID = state.sortingLayer;
        if (created || previous.sortingOrder != state.sortingOrder) v.renderer.sortingOrder = state.sortingOrder;
        v.previous = state;
    }
    private void Validate(CrawlWorldFrame f)
    {
        if (f.sceneEpoch == 0) throw new InvalidDataException("WORLD_SCENE");
        var entities = new HashSet<uint>(); var rooms = new HashSet<uint>(); var sprites = new HashSet<uint>(); var paletteIds = new HashSet<uint>();
        foreach (var e in f.entities)
            if (e.id == 0 || e.prefab == 0 || !entities.Add(e.id) || e.state == null || e.state.Length > 64) throw new InvalidDataException("WORLD_ENTITY");
        foreach (var r in f.rooms) if (r.id == 0 || !rooms.Add(r.id)) throw new InvalidDataException("WORLD_ROOM");
        if (f.currentRoom != 0 && !rooms.Contains(f.currentRoom)) throw new InvalidDataException("WORLD_ROOM");
        foreach (var r in f.rooms) foreach (var d in r.doors)
            if ((d.target != 0 && !rooms.Contains(d.target)) || d.direction > 3) throw new InvalidDataException("WORLD_DOOR");
        foreach (var a in f.actors) if (a.revision == 0 || (a.entity != 0 && !entities.Contains(a.entity))) throw new InvalidDataException("WORLD_OWNER");
        foreach (var p in f.palettes) { assets.Texture(p.id); if (!paletteIds.Add(p.id)) throw new InvalidDataException("WORLD_PALETTE"); }
        foreach (var s in f.sprites)
        {
            if (s.id == 0 || !sprites.Add(s.id) || (s.entity != 0 && !entities.Contains(s.entity)) ||
                s.layer < 0 || s.layer > 31) throw new InvalidDataException("WORLD_SPRITE");
            if (s.palette != 0 && !paletteIds.Contains(s.palette))
            {
                Texture2D source = assets.Texture(s.palette);
                if (source.isReadable && source.width == 256 && source.height == 64) throw new InvalidDataException("WORLD_PALETTE");
            }
            assets.Texture(s.texture); assets.Shader(s.shader);
        }
        var textIds = new HashSet<uint>();
        foreach (var t in f.texts)
        {
            if (t.id == 0 || !textIds.Add(t.id) || t.text == null || t.text.Length > 8192 || t.layer < 0 || t.layer > 31 || t.anchor < 0 || t.anchor > 8 || t.alignment < 0 || t.alignment > 2 || t.fontStyle < 0 || t.fontStyle > 3 || t.fontSize < 0 || t.fontSize > 512 || t.materials.Length == 0) throw new InvalidDataException("WORLD_TEXT");
            assets.Font(t.font); foreach (var m in t.materials) { TextShader(t, m); if (m.texture != 0) assets.Texture(m.texture); }
        }
        foreach (var c in f.cameras) if (c.clearFlags < 1 || c.clearFlags > 4 || c.rect.z < 0 || c.rect.w < 0) throw new InvalidDataException("WORLD_CAMERA");
        var audioIds = new HashSet<uint>();
        foreach (var a in f.audio) { if (a.id == 0 || !audioIds.Add(a.id) || a.offset < 0 || a.volume < 0 || a.volume > 1 || a.pitch < .01f || a.pitch > 3) throw new InvalidDataException("WORLD_AUDIO"); assets.Audio(a.clip); }
    }
    private static void Release(Object value) { if (Application.isPlaying) Object.Destroy(value); else Object.DestroyImmediate(value); }
    private Shader TextShader(CrawlWorldFrame.TextState text, CrawlWorldFrame.TextMaterial material)
    { return material.shader == 0 ? assets.Font(text.font).material.shader : assets.Shader(material.shader); }
    private static void DestroyVisual(Visual v) { v.gameObject.SetActive(false); Release(v.mesh); Release(v.material); Release(v.gameObject); }
    private static void DestroyText(TextVisual v) { v.text.gameObject.SetActive(false); if (v.materials != null) foreach (var m in v.materials) Release(m); Release(v.text.gameObject); }
    private void ClearWorld()
    {
        actorsById.Clear(); worldCameras.Clear();
        foreach (var actor in actors) { actor.entity = null; actor.sprites.Clear(); }
        foreach (var v in visuals.Values) DestroyVisual(v); visuals.Clear();
        foreach (var p in palettes.Values) Release(p.texture); palettes.Clear();
        foreach (var t in texts.Values) DestroyText(t); texts.Clear();
        if (root != null) { root.SetActive(false); Release(root); } root = null; Current = null;
    }
    public void Dispose() { ClearWorld(); audio.Dispose(); if (cameraHost != null) Release(cameraHost); foreach (var c in extraCameras) Release(c.gameObject); extraCameras.Clear(); }
}
