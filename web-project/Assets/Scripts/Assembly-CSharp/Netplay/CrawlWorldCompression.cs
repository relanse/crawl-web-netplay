using System;
using System.IO;
using System.IO.Compression;
using System.Runtime.InteropServices;

public static class CrawlWorldCompression
{
    public static byte[] Pack(byte[] body) { return Compress(body, body.Length, 0); }

    public static byte[] PackDelta(byte[] body, uint baseId, byte[] baseline)
    {
        byte[] scratch = null;
        return PackDelta(body, baseId, baseline, ref scratch);
    }

    public static byte[] PackDelta(byte[] body, uint baseId, byte[] baseline, ref byte[] scratch)
    {
        if (baseId == 0 || baseline == null) throw new ArgumentException("A delta needs a baseline.");
        if (scratch == null || scratch.Length < body.Length) scratch = new byte[body.Length];
        Buffer.BlockCopy(body, 0, scratch, 0, body.Length);
        ApplyDifference(scratch.AsSpan(0, body.Length), baseline);
        return Compress(scratch, body.Length, baseId);
    }

    private static byte[] Compress(byte[] body, int length, uint baseId)
    {
        using (var output = new MemoryStream())
        {
            int size = baseId == 0 ? length : length | int.MinValue;
            output.Write(BitConverter.GetBytes(size), 0, 4);
            if (baseId != 0) output.Write(BitConverter.GetBytes(baseId), 0, 4);
            using (var compressor = new DeflateStream(output, CompressionLevel.Fastest, true)) compressor.Write(body, 0, length);
            return output.ToArray();
        }
    }
    public static byte[] Unpack(byte[] packet, uint baseId = 0, byte[] baseline = null)
    {
        byte[] buffer = null;
        return UnpackInto(packet, baseId, baseline == null ? default : new ArraySegment<byte>(baseline), ref buffer).Array;
    }

    // Decode into the spare of two buffers. The other buffer still holds the
    // previous frame needed to reconstruct a delta.
    public static ArraySegment<byte> UnpackInto(byte[] packet, uint baseId, ArraySegment<byte> baseline, ref byte[] buffer)
    {
        if (packet == null || packet.Length < 5) throw new InvalidDataException("WORLD_COMPRESSION");
        int size = BitConverter.ToInt32(packet, 0);
        int length = size & int.MaxValue;
        if (length < 1 || length > CrawlBaselineAssembler.MaxBytes) throw new InvalidDataException("WORLD_LIMIT");
        int offset = 4;
        if (size < 0)
        {
            if (packet.Length < 9 || baseId == 0 || baseline.Array == null || BitConverter.ToUInt32(packet, 4) != baseId)
                throw new InvalidDataException("WORLD_DELTA_BASELINE");
            offset = 8;
        }
        if (buffer == null || buffer.Length < length) buffer = new byte[length];
        using (var input = new MemoryStream(packet, offset, packet.Length - offset))
        using (var decompressor = new DeflateStream(input, CompressionMode.Decompress))
        {
            int position = 0, count;
            while (position < length && (count = decompressor.Read(buffer, position, length - position)) > 0) position += count;
            if (position != length || decompressor.ReadByte() != -1) throw new InvalidDataException("WORLD_COMPRESSION");
        }
        if (size < 0) ApplyDifference(buffer.AsSpan(0, length), baseline.AsSpan());
        return new ArraySegment<byte>(buffer, 0, length);
    }

    private static void ApplyDifference(Span<byte> body, ReadOnlySpan<byte> baseline)
    {
        int shared = Math.Min(body.Length, baseline.Length);
        Span<ulong> words = MemoryMarshal.Cast<byte, ulong>(body.Slice(0, shared));
        ReadOnlySpan<ulong> baseWords = MemoryMarshal.Cast<byte, ulong>(baseline.Slice(0, shared));
        for (int i = 0; i < words.Length; i++) words[i] ^= baseWords[i];
        for (int i = words.Length * sizeof(ulong); i < shared; i++) body[i] ^= baseline[i];
    }
}
