using System;
using System.IO;
using System.Runtime.InteropServices;
using Mirror;
using UnityEngine;

// Full presentation state, not a prediction/rollback save. Original combat
// stays on the authority. Every frame contains the complete active visual set.
public sealed class CrawlWorldFrame
{
    public string contentHash;
    public uint sceneEpoch, netTick, simTick, currentRoom;
    public bool paused;
    public Matrix4x4 view, projection;
    public Color background;
    public Entity[] entities;
    public RoomState[] rooms;
    public Actor[] actors;
    public Palette[] palettes;
    public Sprite[] sprites;
    public CameraState[] cameras = new CameraState[0];
    public TextState[] texts = new TextState[0];
    public AudioState[] audio = new AudioState[0];
    public sealed class AudioState { public uint id, clip; public float offset, volume, pitch; public bool loop, music; }
    public sealed class CameraState { public Matrix4x4 view, projection; public Color background; public int mask, clearFlags; public float depth; public Vector4 rect; }
    public sealed class TextMaterial { public uint texture, shader; public int renderQueue; public float offsetY; }
    public sealed class TextState
    {
        public uint id, font; public string text; public Vector3 position, scale; public Quaternion rotation;
        public int layer, sortingLayer, sortingOrder, fontSize, fontStyle, anchor, alignment;
        public float characterSize, lineSpacing, offsetZ, tabSize; public bool richText; public Color color;
        public TextMaterial[] materials;
    }
    public sealed class Entity { public uint id, prefab; public bool active; public Vector3 position, velocity; public float health, maxHealth; public string state; }
    public sealed class RoomState { public uint id; public Vector3 position; public bool seen; public DoorState[] doors; }
    public sealed class DoorState { public uint target; public Vector2 position; public byte direction; public bool open, blocked; }
    public sealed class Actor { public uint entity, revision; public bool active, alive, hero, menu; }
    public sealed class Palette { public uint id; public ushort width, height; public Color32[] pixels; }
    public sealed class Sprite
    {
        public uint id, entity, texture, shader, palette;
        public Vector3 pivot;
        public int layer, sortingLayer, sortingOrder, renderQueue;
        public Vector3[] vertices;
        public Vector2[] uv;
        public Color32[] colors;
        public Color tint;
        public Vector4 textureST;
        public bool clipped;
        public Vector4 clipRect;
        public Matrix4x4 clipMatrix;
    }
}

public static class CrawlWorldFrameCodec
{
    public const int MaxEntities = 8192, MaxSprites = 8192, MaxRooms = 256, MaxPalettes = 32;
    private static int Count(NetworkReader r, int max) { int n = r.ReadInt(); if (n < 0 || n > max) throw new InvalidDataException("WORLD_LIMIT"); return n; }
    private static float Number(NetworkReader r) { float n = r.ReadFloat(); if (float.IsNaN(n) || float.IsInfinity(n)) throw new InvalidDataException("WORLD_NUMBER"); return n; }
    private static Vector2 V2(NetworkReader r) { return new Vector2(Number(r), Number(r)); }
    private static Vector3 V3(NetworkReader r) { return new Vector3(Number(r), Number(r), Number(r)); }
    private static Vector4 V4(NetworkReader r) { return new Vector4(Number(r), Number(r), Number(r), Number(r)); }
    private static Matrix4x4 Matrix(NetworkReader r) { var m = new Matrix4x4(); for (int i = 0; i < 16; i++) m[i] = Number(r); return m; }
    private static void Matrix(NetworkWriter w, Matrix4x4 m) { for (int i = 0; i < 16; i++) w.WriteFloat(m[i]); }
    private static Color32 Pixel(NetworkReader r) { return new Color32(r.ReadByte(), r.ReadByte(), r.ReadByte(), r.ReadByte()); }
    private static void Pixel(NetworkWriter w, Color32 c) { w.WriteByte(c.r); w.WriteByte(c.g); w.WriteByte(c.b); w.WriteByte(c.a); }
    public static byte[] Encode(CrawlWorldFrame f)
    {
        using var w = NetworkWriterPool.Get();
        w.WriteUInt(0x43574631); w.WriteString(f.contentHash);
        w.WriteUInt(f.sceneEpoch); w.WriteUInt(f.netTick); w.WriteUInt(f.simTick); w.WriteUInt(f.currentRoom); w.WriteBool(f.paused);
        Matrix(w, f.view); Matrix(w, f.projection); w.WriteColor(f.background);
        w.WriteInt(f.entities.Length);
        foreach (var e in f.entities) { w.WriteUInt(e.id); w.WriteUInt(e.prefab); w.WriteBool(e.active); w.WriteVector3(e.position); w.WriteVector3(e.velocity); w.WriteFloat(e.health); w.WriteFloat(e.maxHealth); w.WriteString(e.state); }
        w.WriteInt(f.rooms.Length);
        foreach (var room in f.rooms)
        {
            w.WriteUInt(room.id); w.WriteVector3(room.position); w.WriteBool(room.seen); w.WriteInt(room.doors.Length);
            foreach (var d in room.doors) { w.WriteUInt(d.target); w.WriteVector2(d.position); w.WriteByte(d.direction); w.WriteBool(d.open); w.WriteBool(d.blocked); }
        }
        w.WriteInt(f.actors.Length);
        foreach (var a in f.actors) { w.WriteUInt(a.entity); w.WriteUInt(a.revision); w.WriteBool(a.active); w.WriteBool(a.alive); w.WriteBool(a.hero); w.WriteBool(a.menu); }
        w.WriteInt(f.palettes.Length);
        foreach (var p in f.palettes)
        {
            w.WriteUInt(p.id); w.WriteUShort(p.width); w.WriteUShort(p.height);
            w.WriteBytes(MemoryMarshal.AsBytes(p.pixels.AsSpan()));
        }
        w.WriteInt(f.sprites.Length);
        foreach (var s in f.sprites)
        {
            w.WriteUInt(s.id); w.WriteUInt(s.entity); w.WriteUInt(s.texture); w.WriteUInt(s.shader); w.WriteUInt(s.palette); w.WriteVector3(s.pivot);
            w.WriteInt(s.layer); w.WriteInt(s.sortingLayer); w.WriteInt(s.sortingOrder); w.WriteInt(s.renderQueue); w.WriteColor(s.tint); w.WriteVector4(s.textureST); w.WriteBool(s.clipped);
            if (s.clipped) { w.WriteVector4(s.clipRect); Matrix(w, s.clipMatrix); }
            for (int i = 0; i < 4; i++) { w.WriteVector3(s.vertices[i]); w.WriteVector2(s.uv[i]); Pixel(w, s.colors[i]); }
        }
        w.WriteInt(f.cameras.Length);
        foreach (var c in f.cameras) { Matrix(w, c.view); Matrix(w, c.projection); w.WriteColor(c.background); w.WriteInt(c.mask); w.WriteInt(c.clearFlags); w.WriteFloat(c.depth); w.WriteVector4(c.rect); }
        w.WriteInt(f.texts.Length);
        foreach (var t in f.texts)
        {
            w.WriteUInt(t.id); w.WriteUInt(t.font); w.WriteString(t.text); w.WriteVector3(t.position); w.WriteVector3(t.scale); w.WriteQuaternion(t.rotation);
            w.WriteInt(t.layer); w.WriteInt(t.sortingLayer); w.WriteInt(t.sortingOrder); w.WriteInt(t.fontSize); w.WriteInt(t.fontStyle); w.WriteInt(t.anchor); w.WriteInt(t.alignment);
            w.WriteFloat(t.characterSize); w.WriteFloat(t.lineSpacing); w.WriteFloat(t.offsetZ); w.WriteFloat(t.tabSize); w.WriteBool(t.richText); w.WriteColor(t.color);
            w.WriteInt(t.materials.Length); foreach (var m in t.materials) { w.WriteUInt(m.texture); w.WriteUInt(m.shader); w.WriteInt(m.renderQueue); w.WriteFloat(m.offsetY); }
        }
        w.WriteInt(f.audio.Length);
        foreach (var a in f.audio) { w.WriteUInt(a.id); w.WriteUInt(a.clip); w.WriteFloat(a.offset); w.WriteFloat(a.volume); w.WriteFloat(a.pitch); w.WriteBool(a.loop); w.WriteBool(a.music); }
        if (w.Position > CrawlBaselineAssembler.MaxBytes) throw new InvalidDataException("WORLD_LIMIT");
        return w.ToArray();
    }
    public static CrawlWorldFrame Decode(byte[] body, string expectedHash)
    { return Decode(body == null ? default : new ArraySegment<byte>(body), expectedHash, null); }

    public static CrawlWorldFrame Decode(ArraySegment<byte> body, string expectedHash, CrawlWorldFrame previous)
    {
        if (body.Array == null || body.Count > CrawlBaselineAssembler.MaxBytes) throw new InvalidDataException("WORLD_LIMIT");
        var r = new NetworkReader(body); if (r.ReadUInt() != 0x43574631) throw new InvalidDataException("WORLD_VERSION");
        var f = new CrawlWorldFrame { contentHash = r.ReadString() };
        if (f.contentHash != expectedHash) throw new InvalidDataException("VERSION_MISMATCH");
        f.sceneEpoch = r.ReadUInt(); f.netTick = r.ReadUInt(); f.simTick = r.ReadUInt(); f.currentRoom = r.ReadUInt(); f.paused = r.ReadBool();
        f.view = Matrix(r); f.projection = Matrix(r); f.background = (Color)V4(r);
        f.entities = new CrawlWorldFrame.Entity[Count(r, MaxEntities)];
        foreach (int i in Indices(f.entities.Length)) f.entities[i] = new CrawlWorldFrame.Entity { id = r.ReadUInt(), prefab = r.ReadUInt(), active = r.ReadBool(), position = V3(r), velocity = V3(r), health = Number(r), maxHealth = Number(r), state = r.ReadString() };
        f.rooms = new CrawlWorldFrame.RoomState[Count(r, MaxRooms)];
        for (int i = 0; i < f.rooms.Length; i++)
        {
            var room = new CrawlWorldFrame.RoomState { id = r.ReadUInt(), position = V3(r), seen = r.ReadBool(), doors = new CrawlWorldFrame.DoorState[Count(r, 32)] };
            for (int j = 0; j < room.doors.Length; j++) room.doors[j] = new CrawlWorldFrame.DoorState { target = r.ReadUInt(), position = V2(r), direction = r.ReadByte(), open = r.ReadBool(), blocked = r.ReadBool() };
            f.rooms[i] = room;
        }
        int actors = Count(r, 4); if (actors != 4) throw new InvalidDataException("WORLD_ACTORS");
        f.actors = new CrawlWorldFrame.Actor[actors];
        for (int i = 0; i < actors; i++) f.actors[i] = new CrawlWorldFrame.Actor { entity = r.ReadUInt(), revision = r.ReadUInt(), active = r.ReadBool(), alive = r.ReadBool(), hero = r.ReadBool(), menu = r.ReadBool() };
        f.palettes = new CrawlWorldFrame.Palette[Count(r, MaxPalettes)];
        var previousPalettes = previous?.sceneEpoch == f.sceneEpoch ? previous.palettes : null;
        for (int i = 0; i < f.palettes.Length; i++)
        {
            var p = new CrawlWorldFrame.Palette { id = r.ReadUInt(), width = r.ReadUShort(), height = r.ReadUShort() };
            if (p.width != 256 || p.height != 64) throw new InvalidDataException("WORLD_PALETTE");
            var rgba = r.ReadBytesSegment(p.width * p.height * 4);
            var data = rgba.AsSpan();
            if (previousPalettes != null)
                foreach (var existing in previousPalettes)
                    if (existing.id == p.id && data.SequenceEqual(MemoryMarshal.AsBytes(existing.pixels.AsSpan())))
                    {
                        p.pixels = existing.pixels;
                        break;
                    }
            if (p.pixels == null)
            {
                p.pixels = new Color32[p.width * p.height];
                data.CopyTo(MemoryMarshal.AsBytes(p.pixels.AsSpan()));
            }
            f.palettes[i] = p;
        }
        f.sprites = new CrawlWorldFrame.Sprite[Count(r, MaxSprites)];
        for (int i = 0; i < f.sprites.Length; i++)
        {
            var s = new CrawlWorldFrame.Sprite { id = r.ReadUInt(), entity = r.ReadUInt(), texture = r.ReadUInt(), shader = r.ReadUInt(), palette = r.ReadUInt(), pivot = V3(r),
                layer = r.ReadInt(), sortingLayer = r.ReadInt(), sortingOrder = r.ReadInt(), renderQueue = r.ReadInt(), tint = (Color)V4(r), textureST = V4(r), clipped = r.ReadBool() };
            if (s.clipped) { s.clipRect = V4(r); s.clipMatrix = Matrix(r); }
            s.vertices = new Vector3[4]; s.uv = new Vector2[4]; s.colors = new Color32[4];
            for (int j = 0; j < 4; j++) { s.vertices[j] = V3(r); s.uv[j] = V2(r); s.colors[j] = Pixel(r); }
            f.sprites[i] = s;
        }
        f.cameras = new CrawlWorldFrame.CameraState[Count(r, 8)];
        for (int i = 0; i < f.cameras.Length; i++) f.cameras[i] = new CrawlWorldFrame.CameraState { view = Matrix(r), projection = Matrix(r), background = (Color)V4(r), mask = r.ReadInt(), clearFlags = r.ReadInt(), depth = Number(r), rect = V4(r) };
        f.texts = new CrawlWorldFrame.TextState[Count(r, 512)];
        for (int i = 0; i < f.texts.Length; i++)
        {
            var t = new CrawlWorldFrame.TextState { id = r.ReadUInt(), font = r.ReadUInt(), text = r.ReadString(), position = V3(r), scale = V3(r) };
            Vector4 q = V4(r); t.rotation = new Quaternion(q.x, q.y, q.z, q.w);
            t.layer = r.ReadInt(); t.sortingLayer = r.ReadInt(); t.sortingOrder = r.ReadInt(); t.fontSize = r.ReadInt(); t.fontStyle = r.ReadInt(); t.anchor = r.ReadInt(); t.alignment = r.ReadInt();
            t.characterSize = Number(r); t.lineSpacing = Number(r); t.offsetZ = Number(r); t.tabSize = Number(r); t.richText = r.ReadBool(); t.color = (Color)V4(r);
            t.materials = new CrawlWorldFrame.TextMaterial[Count(r, 32)];
            for (int j = 0; j < t.materials.Length; j++) t.materials[j] = new CrawlWorldFrame.TextMaterial { texture = r.ReadUInt(), shader = r.ReadUInt(), renderQueue = r.ReadInt(), offsetY = Number(r) };
            f.texts[i] = t;
        }
        f.audio = new CrawlWorldFrame.AudioState[Count(r, 128)];
        for (int i = 0; i < f.audio.Length; i++) f.audio[i] = new CrawlWorldFrame.AudioState { id = r.ReadUInt(), clip = r.ReadUInt(), offset = Number(r), volume = Number(r), pitch = Number(r), loop = r.ReadBool(), music = r.ReadBool() };
        if (r.Remaining != 0) throw new InvalidDataException("WORLD_TRAILING_BYTES");
        return f;
    }
    private static System.Collections.Generic.IEnumerable<int> Indices(int count) { for (int i = 0; i < count; i++) yield return i; }
}
