using System;
using System.IO;
using System.Linq;
using Mirror;
using UnityEngine;

public static class CrawlWorldFrameTests
{
    private static int checks;
    private static void Check(bool value, string message) { checks++; if (!value) throw new Exception(message); }
    private static void Reject(Action action, string code)
    { bool rejected = false; try { action(); } catch (InvalidDataException e) { rejected = e.Message == code; } Check(rejected, "Expected " + code); }
    public static void Run()
    {
        checks = 0; string hash = new string('a', 64);
        var frame = new CrawlWorldFrame { contentHash = hash, sceneEpoch = 1, netTick = 30, simTick = 28, currentRoom = 1,
            view = Matrix4x4.identity, projection = Matrix4x4.identity, background = Color.black,
            entities = new[] { new CrawlWorldFrame.Entity { id = 2, prefab = 3, active = true, state = "Attack", health = 4, maxHealth = 8, position = new Vector3(7, 8, 9) } },
            rooms = new[] { new CrawlWorldFrame.RoomState { id = 1, seen = true, doors = new[] { new CrawlWorldFrame.DoorState { direction = 2, open = true } } } },
            actors = Enumerable.Range(0, 4).Select(i => new CrawlWorldFrame.Actor { entity = i == 0 ? 2u : 0, revision = 1 }).ToArray(),
            palettes = new CrawlWorldFrame.Palette[0], sprites = new[] { new CrawlWorldFrame.Sprite { id = 1, entity = 2, texture = 1, shader = 1,
                renderQueue = -1, vertices = new[] { Vector3.zero, Vector3.right, Vector3.up, Vector3.one },
                uv = new[] { Vector2.zero, Vector2.right, Vector2.up, Vector2.one }, colors = Enumerable.Repeat((Color32)Color.white, 4).ToArray(), textureST = new Vector4(1, 1, 0, 0) } } };
        byte[] bytes = CrawlWorldFrameCodec.Encode(frame); var copy = CrawlWorldFrameCodec.Decode(bytes, hash);
        var pixels = new Color32[256 * 64];
        pixels[0] = new Color32(11, 22, 33, 44);
        pixels[pixels.Length - 1] = new Color32(155, 166, 177, 188);
        frame.palettes = new[] { new CrawlWorldFrame.Palette { id = 1, width = 256, height = 64, pixels = pixels } };
        var paletteBytes = new ArraySegment<byte>(CrawlWorldFrameCodec.Encode(frame));
        var oldPaletteFrame = CrawlWorldFrameCodec.Decode(paletteBytes, hash, null);
        var decodedPixels = oldPaletteFrame.palettes[0].pixels;
        Check(decodedPixels.SequenceEqual(pixels), "Bulk palette decode changed RGBA bytes");
        Check(ReferenceEquals(decodedPixels, CrawlWorldFrameCodec.Decode(paletteBytes, hash, oldPaletteFrame).palettes[0].pixels),
            "Unchanged palette was allocated again");
        pixels[0] = new Color32(1, 2, 3, 4);
        var changedPixels = CrawlWorldFrameCodec.Decode(new ArraySegment<byte>(CrawlWorldFrameCodec.Encode(frame)), hash, oldPaletteFrame)
            .palettes[0].pixels;
        Check(!ReferenceEquals(decodedPixels, changedPixels) && changedPixels[0].Equals(pixels[0]), "Palette update was lost");
        frame.palettes = Array.Empty<CrawlWorldFrame.Palette>();
        byte[] packed = CrawlWorldCompression.Pack(bytes);
        Check(CrawlWorldCompression.Unpack(packed).SequenceEqual(bytes), "Compressed world changed bytes");
        var movedBytes = bytes.Concat(new byte[] { 2, 3, 4 }).ToArray();
        movedBytes[37] ^= 0xf0;
        byte[] scratch = new byte[movedBytes.Length + 64];
        byte[] originalScratch = scratch;
        var delta = CrawlWorldCompression.PackDelta(movedBytes, 7, bytes, ref scratch);
        Check(CrawlWorldCompression.Unpack(delta, 7, bytes).SequenceEqual(movedBytes), "Delta lost changed bytes or the extended tail");
        var previousRaw = new ArraySegment<byte>(new byte[bytes.Length + 64], 0, bytes.Length);
        bytes.CopyTo(previousRaw.Array, 0);
        byte[] spare = new byte[movedBytes.Length + 64];
        byte[] originalSpare = spare;
        var decodedDelta = CrawlWorldCompression.UnpackInto(delta, 7, previousRaw, ref spare);
        Check(ReferenceEquals(scratch, originalScratch) && ReferenceEquals(decodedDelta.Array, originalSpare) &&
            decodedDelta.Count == movedBytes.Length && decodedDelta.SequenceEqual(movedBytes),
            "Delta buffer reuse changed the frame length or payload");
        Reject(() => CrawlWorldCompression.Unpack(delta), "WORLD_DELTA_BASELINE");
        Reject(() => CrawlWorldCompression.Unpack(delta, 6, bytes), "WORLD_DELTA_BASELINE");
        Check(CrawlWorldCompression.Unpack(packed, 7, movedBytes).SequenceEqual(bytes), "Full snapshot depended on a previous frame");
        byte[] excessive = (byte[])packed.Clone(); Buffer.BlockCopy(BitConverter.GetBytes(CrawlBaselineAssembler.MaxBytes + 1), 0, excessive, 0, 4);
        Reject(() => CrawlWorldCompression.Unpack(excessive), "WORLD_LIMIT");
        byte[] shortOutput = (byte[])packed.Clone(); Buffer.BlockCopy(BitConverter.GetBytes(bytes.Length - 1), 0, shortOutput, 0, 4);
        Reject(() => CrawlWorldCompression.Unpack(shortOutput), "WORLD_COMPRESSION");
        Check(copy.entities[0].position == frame.entities[0].position && copy.entities[0].state == "Attack" && copy.rooms[0].doors[0].open && copy.actors[0].entity == 2 && copy.sprites[0].vertices[3] == Vector3.one,
            "World frame changed game/visual state");
        Reject(() => CrawlWorldFrameCodec.Decode(bytes, new string('b', 64)), "VERSION_MISMATCH");
        Reject(() => CrawlWorldFrameCodec.Decode(bytes.Concat(new byte[1]).ToArray(), hash), "WORLD_TRAILING_BYTES");
        bool truncated = false; try { CrawlWorldFrameCodec.Decode(bytes.Take(bytes.Length - 1).ToArray(), hash); } catch (EndOfStreamException) { truncated = true; }
        Check(truncated, "Truncated sprite accepted");
        var reader = new NetworkReader(bytes); reader.ReadUInt(); reader.ReadString(); reader.ReadBytesSegment(4 * 4 + 1 + 16 * 4 * 2 + 4 * 4);
        byte[] huge = (byte[])bytes.Clone(); Buffer.BlockCopy(BitConverter.GetBytes(int.MaxValue), 0, huge, reader.Position, 4);
        Reject(() => CrawlWorldFrameCodec.Decode(huge, hash), "WORLD_LIMIT");
        frame.sprites[0].vertices[0].x = float.NaN;
        Reject(() => CrawlWorldFrameCodec.Decode(CrawlWorldFrameCodec.Encode(frame), hash), "WORLD_NUMBER"); frame.sprites[0].vertices[0] = Vector3.zero;

        var catalog = ScriptableObject.CreateInstance<CrawlVisualCatalog>(); catalog.textures = new Texture2D[0]; catalog.shaders = new[] { Shader.Find("ex2D/Alpha Blended") };
        var queueMaterial = new Material(catalog.shaders[0]); queueMaterial.renderQueue = 3123;
        Check(CrawlWorldCapture.GetRawRenderQueue(queueMaterial) == 3123, "Explicit render queue override lost");
        queueMaterial.renderQueue = -1;
        Check(CrawlWorldCapture.GetRawRenderQueue(queueMaterial) == -1, "Inherited queue was resolved through a headless fallback");
        UnityEngine.Object.DestroyImmediate(queueMaterial);
        using (var replica = new CrawlWorldReplica(catalog))
        {
            replica.Apply(copy);
            var root = GameObject.Find("Authoritative world replica");
            Check(replica.SpriteCount == 1 && root != null && root.GetComponentsInChildren<MonoBehaviour>(true).Length == 0 && root.GetComponentsInChildren<Collider>(true).Length == 0 && root.GetComponentsInChildren<Rigidbody>(true).Length == 0,
                "Replica installed gameplay components");
            var before = CrawlWorldFrameCodec.Decode(bytes, hash);
            before.cameras = new[] { new CrawlWorldFrame.CameraState { view = before.view, projection = before.projection, clearFlags = 3 } };
            replica.Apply(before, 10);
            var step = CrawlWorldFrameCodec.Decode(bytes, hash);
            step.netTick += 3;
            step.actors[0].alive = true;
            step.entities[0].state = "Run";
            step.entities[0].position += Vector3.right * 4;
            step.sprites[0].pivot += Vector3.right * 4;
            step.view = Matrix4x4.Translate(Vector3.left * 2);
            step.cameras = new[] { new CrawlWorldFrame.CameraState { view = step.view, projection = step.projection, clearFlags = 3 } };
            replica.Apply(step, 10.05);
            replica.PresentMovement(1, Vector2.zero, false, false, 10.075, 1 / 60f, out _);
            var sprite = root.transform.GetChild(0);
            var renderCamera = GameObject.Find("Replica view 0").GetComponent<Camera>();
            replica.PresentMovement(1, Vector2.zero, false, false, 10.1, 1 / 60f, out _);
            float midpoint = sprite.position.x;
            Check(midpoint > 0 && midpoint < 4, "Character skipped the intermediate position");
            Check(Mathf.Abs(renderCamera.transform.position.x - midpoint * .5f) < .01f, "Camera and character used different playback times");
            replica.PresentMovement(1, Vector2.zero, false, false, 10.118, 1 / 60f, out _);
            Check(sprite.position.x > midpoint && sprite.position.x < 4, "Movement stopped while waiting for a late snapshot");
            var late = CrawlWorldFrameCodec.Decode(bytes, hash);
            late.netTick += 6;
            late.actors[0].alive = true;
            late.entities[0].state = "Run";
            late.entities[0].position += Vector3.right * 8;
            late.sprites[0].pivot += Vector3.right * 8;
            float beforeArrival = sprite.position.x;
            replica.Apply(late, 10.125);
            replica.PresentMovement(1, Vector2.zero, false, false, 10.13, 1 / 60f, out _);
            Check(sprite.position.x > beforeArrival && sprite.position.x < late.sprites[0].pivot.x, "Late arrival jumped directly to the new position");
            Check(replica.PresentMovement(0, Vector2.right, false, true, 10.131, 1 / 60f, out var predicted) &&
                predicted.x > late.entities[0].position.x && sprite.position.x > late.sprites[0].pivot.x,
                "Local control waited for interpolation");

            replica.PresentMovement(1, Vector2.zero, false, false, 10.25, 1 / 60f, out _);
            Check(sprite.position.x > late.sprites[0].pivot.x && sprite.position.x <= late.sprites[0].pivot.x + 2.1f,
                "Movement held immediately or extrapolated past its limit");
            var teleport = CrawlWorldFrameCodec.Decode(bytes, hash);
            teleport.netTick += 9;
            teleport.entities[0].position += Vector3.right * 30;
            teleport.sprites[0].pivot += Vector3.right * 30;
            replica.Apply(teleport, 10.26);
            replica.PresentMovement(1, Vector2.zero, false, false, 10.261, 1 / 60f, out _);
            Check(sprite.position.Equals(teleport.sprites[0].pivot), "Teleport was interpolated across the world");
            var room = CrawlWorldFrameCodec.Decode(bytes, hash);
            room.netTick += 12;
            room.currentRoom = 2;
            room.rooms[0].id = 2;
            room.entities[0].position = teleport.entities[0].position + Vector3.right;
            room.sprites[0].pivot = teleport.sprites[0].pivot + Vector3.right;
            replica.Apply(room, 10.31);
            replica.PresentMovement(1, Vector2.zero, false, false, 10.311, 1 / 60f, out _);
            Check(sprite.position.Equals(room.sprites[0].pivot), "Room transition retained the previous room motion");
            replica.Apply(copy);
            var invalid = CrawlWorldFrameCodec.Decode(bytes, hash); invalid.sprites = new[] { invalid.sprites[0], invalid.sprites[0] };
            Reject(() => replica.Apply(invalid), "WORLD_SPRITE");
            Check(ReferenceEquals(replica.Current, copy) && replica.SpriteCount == 1, "Rejected snapshot replaced the live world");
            invalid = CrawlWorldFrameCodec.Decode(bytes, hash); invalid.actors[0].entity = 999;
            Reject(() => replica.Apply(invalid), "WORLD_OWNER");
            invalid = CrawlWorldFrameCodec.Decode(bytes, hash); invalid.rooms[0].doors[0].target = 999;
            Reject(() => replica.Apply(invalid), "WORLD_DOOR");
            invalid = CrawlWorldFrameCodec.Decode(bytes, hash); invalid.sprites = new CrawlWorldFrame.Sprite[0]; replica.Apply(invalid);
            Check(replica.SpriteCount == 0 && root.GetComponentsInChildren<MeshRenderer>(true).Length == 0, "Full active set did not remove an old sprite");
            catalog.fonts = new[] { UnityEditor.AssetDatabase.LoadAssetAtPath<Font>("Assets/Font/CrawlSmall.ttf") };
            invalid.texts = new[] { new CrawlWorldFrame.TextState { id = 1, font = 1, text = "HP 8", scale = Vector3.one, rotation = Quaternion.identity, layer = 17,
                characterSize = 1, lineSpacing = 1, fontSize = 16, color = Color.white, materials = new[] { new CrawlWorldFrame.TextMaterial { renderQueue = -1 } } } };
            invalid.cameras = new[] { new CrawlWorldFrame.CameraState { view = Matrix4x4.identity, projection = Matrix4x4.identity, mask = 1 << 17, clearFlags = 3, rect = new Vector4(0, 0, 1, 1), depth = 2 } };
            invalid.actors[0].entity = 0; invalid.actors[0].menu = true;
            var ui = CrawlWorldFrameCodec.Decode(CrawlWorldFrameCodec.Encode(invalid), hash); replica.Apply(ui);
            Check(root.GetComponentsInChildren<TextMesh>(true).Single().text == "HP 8" && ui.actors[0].menu && ui.cameras[0].mask == 1 << 17, "Menu, font or HUD camera state lost");
            ui.texts = new CrawlWorldFrame.TextState[0]; replica.Apply(ui);
            Check(root.GetComponentsInChildren<TextMesh>(true).Length == 0, "Old text survived a full snapshot");
        }
        UnityEngine.Object.DestroyImmediate(catalog);
        File.WriteAllText(Path.Combine(System.Environment.GetEnvironmentVariable("CRAWL_TEST_OUTPUT"), "world-frame-tests.json"),
            "{\"passed\":true,\"checks\":" + checks + ",\"scope\":\"World presentation codec and gameplay-free replica lifecycle; visual browser parity tested separately\"}");
        Debug.Log("Crawl world frame tests passed: " + checks);
    }
}
