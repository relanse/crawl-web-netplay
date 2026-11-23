using System;
using System.IO;
using Mirror;

// The binding belongs to one authenticated connection. Release/content and
// world schema validation happen outside this framing, before installation.
public struct CrawlBaselineBinding
{
    public ushort protocolVersion;
    public string matchId;
    public uint connectionEpoch, sceneEpoch, baselineId;
}
public struct CrawlBaselineBegin : NetworkMessage
{
    public CrawlBaselineBinding binding;
    public int totalBytes;
    public ushort chunks;
    public byte[] sha256;
}
public struct CrawlBaselineChunk : NetworkMessage
{
    public CrawlBaselineBinding binding;
    public ushort index;
    // Reader borrows the message buffer. Consume synchronously through
    // CrawlBaselineAssembler.Add (which copies); never retain this segment.
    public ArraySegment<byte> bytes;
}
public struct CrawlBaselineEnd : NetworkMessage { public CrawlBaselineBinding binding; public double queuedAt; }
public struct CrawlBaselineInstalled : NetworkMessage
{
    public CrawlBaselineBinding binding;
    public byte[] sha256;
}

public static class CrawlBaselineWire
{
    public const ushort ProtocolVersion = 1;
    private static void Validate(CrawlBaselineBinding binding)
    {
        if (binding.protocolVersion != ProtocolVersion) throw new InvalidDataException("VERSION_MISMATCH");
        if (binding.matchId == null || binding.matchId.Length != 32 || binding.connectionEpoch == 0 ||
            binding.sceneEpoch == 0 || binding.baselineId == 0) throw new InvalidDataException("BASELINE_BINDING");
        foreach (char c in binding.matchId)
            if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) throw new InvalidDataException("BASELINE_BINDING");
    }
    public static void WriteCrawlBaselineBinding(this NetworkWriter writer, CrawlBaselineBinding binding)
    {
        Validate(binding);
        writer.WriteUShort(binding.protocolVersion);
        // Fixed ASCII, no attacker-controlled string length or encoding.
        foreach (char c in binding.matchId) writer.WriteByte((byte)c);
        writer.WriteUInt(binding.connectionEpoch); writer.WriteUInt(binding.sceneEpoch); writer.WriteUInt(binding.baselineId);
    }
    public static CrawlBaselineBinding ReadCrawlBaselineBinding(this NetworkReader reader)
    {
        ushort version = reader.ReadUShort();
        if (version != ProtocolVersion) throw new InvalidDataException("VERSION_MISMATCH");
        var match = new char[32]; for (int i = 0; i < match.Length; i++) match[i] = (char)reader.ReadByte();
        var binding = new CrawlBaselineBinding { protocolVersion = version, matchId = new string(match),
            connectionEpoch = reader.ReadUInt(), sceneEpoch = reader.ReadUInt(), baselineId = reader.ReadUInt() };
        Validate(binding); return binding;
    }
    private static void ValidateBegin(CrawlBaselineBegin message)
    {
        if (message.totalBytes < 1 || message.totalBytes > CrawlBaselineAssembler.MaxBytes || message.chunks < 1 ||
            message.chunks > CrawlBaselineAssembler.MaxChunks ||
            message.chunks != (message.totalBytes + CrawlBaselineAssembler.ChunkBytes - 1) / CrawlBaselineAssembler.ChunkBytes)
            throw new InvalidDataException("BASELINE_LIMIT");
    }
    private static void WriteHash(NetworkWriter writer, byte[] hash)
    {
        if (hash == null || hash.Length != 32) throw new InvalidDataException("BASELINE_HASH");
        writer.WriteBytes(hash, 0, 32);
    }
    private static byte[] ReadHash(NetworkReader reader)
    {
        var bytes = reader.ReadBytesSegment(32); var copy = new byte[32];
        Buffer.BlockCopy(bytes.Array, bytes.Offset, copy, 0, 32); return copy;
    }
    public static void WriteCrawlBaselineBegin(this NetworkWriter writer, CrawlBaselineBegin message)
    {
        ValidateBegin(message); writer.WriteCrawlBaselineBinding(message.binding);
        writer.WriteInt(message.totalBytes); writer.WriteUShort(message.chunks); WriteHash(writer, message.sha256);
    }
    public static CrawlBaselineBegin ReadCrawlBaselineBegin(this NetworkReader reader)
    {
        var message = new CrawlBaselineBegin { binding = reader.ReadCrawlBaselineBinding(), totalBytes = reader.ReadInt(), chunks = reader.ReadUShort() };
        ValidateBegin(message); message.sha256 = ReadHash(reader); return message;
    }
    public static void WriteCrawlBaselineChunk(this NetworkWriter writer, CrawlBaselineChunk message)
    {
        if (message.index >= CrawlBaselineAssembler.MaxChunks || message.bytes.Array == null ||
            message.bytes.Count < 1 || message.bytes.Count > CrawlBaselineAssembler.ChunkBytes) throw new InvalidDataException("BASELINE_CHUNK");
        writer.WriteCrawlBaselineBinding(message.binding); writer.WriteUShort(message.index);
        writer.WriteUShort((ushort)message.bytes.Count); writer.WriteBytes(message.bytes.Array, message.bytes.Offset, message.bytes.Count);
    }
    public static CrawlBaselineChunk ReadCrawlBaselineChunk(this NetworkReader reader)
    {
        var message = new CrawlBaselineChunk { binding = reader.ReadCrawlBaselineBinding(), index = reader.ReadUShort() };
        int length = reader.ReadUShort();
        if (message.index >= CrawlBaselineAssembler.MaxChunks || length < 1 || length > CrawlBaselineAssembler.ChunkBytes)
            throw new InvalidDataException("BASELINE_CHUNK");
        // Check the bounded length before slicing. No array allocation from a
        // peer-supplied length; truncated payloads fail in ReadBytesSegment.
        message.bytes = reader.ReadBytesSegment(length); return message;
    }
    public static void WriteCrawlBaselineEnd(this NetworkWriter writer, CrawlBaselineEnd message)
    { writer.WriteCrawlBaselineBinding(message.binding); writer.WriteDouble(message.queuedAt); }
    public static CrawlBaselineEnd ReadCrawlBaselineEnd(this NetworkReader reader)
    { return new CrawlBaselineEnd { binding = reader.ReadCrawlBaselineBinding(), queuedAt = reader.ReadDouble() }; }
    public static void WriteCrawlBaselineInstalled(this NetworkWriter writer, CrawlBaselineInstalled message)
    { writer.WriteCrawlBaselineBinding(message.binding); WriteHash(writer, message.sha256); }
    public static CrawlBaselineInstalled ReadCrawlBaselineInstalled(this NetworkReader reader)
    { return new CrawlBaselineInstalled { binding = reader.ReadCrawlBaselineBinding(), sha256 = ReadHash(reader) }; }
}
