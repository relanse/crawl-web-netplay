using System;
using System.IO;
using System.Security.Cryptography;

// Transport-independent staging buffer. It never changes a live world or grants
// control. The caller must parse/validate the verified body and atomically
// install its replica before acknowledging BaselineInstalled.
public sealed class CrawlBaselineAssembler
{
    public const int ChunkBytes = 16 * 1024;
    public const int MaxBytes = 8 * 1024 * 1024;
    public const int MaxChunks = 512;
    public const double TimeoutSeconds = 30;
    private readonly string matchId;
    private readonly uint connectionEpoch;
    private uint sceneEpoch, highestId;
    private byte[] buffer, digest;
    private bool[] received;
    private int receivedCount;
    private double deadline;
    public int BufferedBytes { get { return buffer == null ? 0 : buffer.Length; } }
    public int ReceivedChunks { get { return receivedCount; } }
    public uint BaselineId { get { return highestId; } }
    public bool Complete { get { return received != null && receivedCount == received.Length; } }

    public CrawlBaselineAssembler(string match, uint connection, uint scene)
    {
        if (match == null || match.Length != 32 || connection == 0 || scene == 0) throw new ArgumentException("Invalid baseline binding.");
        foreach (char c in match) if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) throw new ArgumentException("Invalid match ID.");
        matchId = match; connectionEpoch = connection; sceneEpoch = scene;
    }
    public void AdvanceScene(uint scene)
    {
        if (scene <= sceneEpoch) throw new ArgumentOutOfRangeException("scene");
        sceneEpoch = scene; Cancel(); // Baseline IDs remain monotonic within a match.
    }
    public bool Begin(string match, uint connection, uint scene, uint id, int totalBytes, int chunks, byte[] sha256, double now)
    {
        CheckTime(now);
        if (match != matchId || connection != connectionEpoch) throw new InvalidDataException("BASELINE_BINDING");
        if (scene < sceneEpoch || id < highestId) return false;
        if (scene != sceneEpoch || id == 0) throw new InvalidDataException("BASELINE_SCENE");
        if (totalBytes < 1 || totalBytes > MaxBytes || chunks < 1 || chunks > MaxChunks ||
            chunks != (totalBytes + ChunkBytes - 1) / ChunkBytes || sha256 == null || sha256.Length != 32)
            throw new InvalidDataException("BASELINE_LIMIT");
        if (id == highestId)
        {
            if (buffer == null) return false; // Already installed or canceled; never restart an old ID.
            if (buffer.Length != totalBytes || received.Length != chunks || !Equal(digest, sha256))
                throw new InvalidDataException("BASELINE_CONFLICT");
            Expire(now); return false; // Duplicate begin cannot extend the deadline.
        }
        // Validate every limit before allocating or replacing the active staging buffer.
        buffer = new byte[totalBytes]; received = new bool[chunks]; digest = (byte[])sha256.Clone();
        receivedCount = 0; highestId = id; deadline = now + TimeoutSeconds;
        return true;
    }
    public bool Add(string match, uint connection, uint scene, uint id, int index, ArraySegment<byte> bytes, double now)
    {
        CheckTime(now);
        if (match != matchId || connection != connectionEpoch) throw new InvalidDataException("BASELINE_BINDING");
        if (scene < sceneEpoch || id < highestId) return false;
        if (scene != sceneEpoch || id != highestId) throw new InvalidDataException("BASELINE_REQUIRED");
        if (buffer == null) return false;
        Expire(now);
        if (index < 0 || index >= received.Length || bytes.Array == null ||
            bytes.Count != Math.Min(ChunkBytes, buffer.Length - index * ChunkBytes)) throw new InvalidDataException("BASELINE_CHUNK");
        int offset = index * ChunkBytes;
        if (received[index])
        {
            for (int i = 0; i < bytes.Count; i++) if (buffer[offset + i] != bytes.Array[bytes.Offset + i])
                throw new InvalidDataException("BASELINE_CONFLICT");
            return false;
        }
        Buffer.BlockCopy(bytes.Array, bytes.Offset, buffer, offset, bytes.Count);
        received[index] = true; receivedCount++; return true;
    }
    public byte[] TakeVerified(uint id, double now)
    {
        CheckTime(now); Expire(now);
        if (id != highestId || !Complete) throw new InvalidDataException("BASELINE_INCOMPLETE");
        byte[] actual; using (var hash = SHA256.Create()) actual = hash.ComputeHash(buffer);
        if (!Equal(actual, digest)) { Cancel(); throw new InvalidDataException("BASELINE_HASH"); }
        byte[] result = buffer; Cancel(); return result;
    }
    public void Expire(double now)
    {
        CheckTime(now);
        if (buffer != null && now >= deadline) { Cancel(); throw new InvalidDataException("RESYNC_TIMEOUT"); }
    }
    public void Cancel() { buffer = null; digest = null; received = null; receivedCount = 0; deadline = 0; }
    private static void CheckTime(double now)
    { if (double.IsNaN(now) || double.IsInfinity(now) || now < 0 || now > double.MaxValue - TimeoutSeconds) throw new ArgumentOutOfRangeException("now"); }
    private static bool Equal(byte[] a, byte[] b)
    {
        if (a.Length != b.Length) return false;
        int different = 0; for (int i = 0; i < a.Length; i++) different |= a[i] ^ b[i];
        return different == 0;
    }
}
