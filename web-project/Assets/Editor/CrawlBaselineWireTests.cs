using System;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using Mirror;
using UnityEngine;

public static class CrawlBaselineWireTests
{
    private static int checks;
    private static void Check(bool value, string message) { checks++; if (!value) throw new Exception(message); }
    private static byte[] Hash(byte[] body) { using (var sha = SHA256.Create()) return sha.ComputeHash(body); }
    private static void Reject(Action action, string code)
    {
        bool rejected = false; try { action(); } catch (InvalidDataException e) { rejected = e.Message == code; }
        Check(rejected, "Expected " + code);
    }
    // Use Mirror's generated generic delegates as well as explicit codecs:
    // this fails if Weaver silently selects an unbounded default serializer.
    private static T Roundtrip<T>(T message) where T : struct, NetworkMessage
    {
        var writer = new NetworkWriter(); NetworkMessages.Pack(message, writer);
        var reader = new NetworkReader(writer.ToArray()); ushort id;
        if (!NetworkMessages.UnpackId(reader, out id) || id != NetworkMessageId<T>.Id) throw new Exception("Wrong message ID");
        T result = reader.Read<T>(); if (reader.Remaining != 0) throw new Exception("Unread message bytes");
        return result;
    }
    public static void Run()
    {
        checks = 0;
        // Batch executeMethod does not enter Play Mode. Invoke the actual
        // Weaver-generated runtime initializer, never assign test delegates.
        var generated = typeof(CrawlBaselineBegin).Assembly.GetType("Mirror.GeneratedNetworkCode", true);
        generated.GetMethod("InitReadWriters").Invoke(null, null);
        Check(Writer<CrawlBaselineBegin>.write.Method.DeclaringType == typeof(CrawlBaselineWire) &&
            Reader<CrawlBaselineChunk>.read.Method.DeclaringType == typeof(CrawlBaselineWire), "Weaver did not select the bounded codecs");
        var binding = new CrawlBaselineBinding { protocolVersion = 1, matchId = new string('b', 32), connectionEpoch = 2, sceneEpoch = 3, baselineId = 4 };
        byte[] body = Enumerable.Range(0, CrawlBaselineAssembler.ChunkBytes + 7).Select(i => (byte)(i % 251)).ToArray();
        var begin = Roundtrip(new CrawlBaselineBegin { binding = binding, totalBytes = body.Length, chunks = 2, sha256 = Hash(body) });
        Check(begin.totalBytes == body.Length && begin.chunks == 2 && begin.sha256.SequenceEqual(Hash(body)) &&
            begin.binding.matchId == binding.matchId && begin.binding.connectionEpoch == 2 && begin.binding.sceneEpoch == 3 && begin.binding.baselineId == 4,
            "Begin changed its binding or digest");
        var assembler = new CrawlBaselineAssembler(binding.matchId, 2, 3);
        assembler.Begin(begin.binding.matchId, 2, 3, 4, begin.totalBytes, begin.chunks, begin.sha256, 0);
        for (int index = 1; index >= 0; index--)
        {
            int offset = index * CrawlBaselineAssembler.ChunkBytes;
            var chunk = Roundtrip(new CrawlBaselineChunk { binding = binding, index = (ushort)index,
                bytes = new ArraySegment<byte>(body, offset, Math.Min(CrawlBaselineAssembler.ChunkBytes, body.Length - offset)) });
            assembler.Add(chunk.binding.matchId, chunk.binding.connectionEpoch, chunk.binding.sceneEpoch, chunk.binding.baselineId, chunk.index, chunk.bytes, 1);
            // Network readers borrow pooled buffers; assembler must own a copy.
            Array.Clear(chunk.bytes.Array, chunk.bytes.Offset, chunk.bytes.Count);
        }
        var end = Roundtrip(new CrawlBaselineEnd { binding = binding, queuedAt = 123.125 });
        Check(end.queuedAt == 123.125, "Snapshot queue time changed");
        byte[] verified = assembler.TakeVerified(end.binding.baselineId, 2);
        Check(verified.SequenceEqual(body), "Decoded chunks retained the borrowed network buffer");
        var installed = Roundtrip(new CrawlBaselineInstalled { binding = binding, sha256 = Hash(verified) });
        Check(installed.binding.baselineId == 4 && installed.sha256.SequenceEqual(begin.sha256), "Installed receipt changed");

        var writer = new NetworkWriter(); writer.WriteCrawlBaselineBinding(binding);
        int headerBytes = writer.Position;
        writer.WriteInt(CrawlBaselineAssembler.MaxBytes + 1); writer.WriteUShort(513);
        // Deliberately no hash: limit rejection must precede even hash reading.
        Reject(() => new NetworkReader(writer.ToArray()).ReadCrawlBaselineBegin(), "BASELINE_LIMIT");
        writer.Reset(); writer.WriteCrawlBaselineBinding(binding); writer.WriteInt(1); writer.WriteUShort(2);
        Reject(() => new NetworkReader(writer.ToArray()).ReadCrawlBaselineBegin(), "BASELINE_LIMIT");
        writer.Reset(); writer.WriteCrawlBaselineBinding(binding); writer.WriteUShort(0); writer.WriteUShort(65535);
        Reject(() => new NetworkReader(writer.ToArray()).ReadCrawlBaselineChunk(), "BASELINE_CHUNK");
        writer.Reset(); writer.WriteCrawlBaselineBinding(binding); writer.WriteUShort(512); writer.WriteUShort(1);
        Reject(() => new NetworkReader(writer.ToArray()).ReadCrawlBaselineChunk(), "BASELINE_CHUNK");
        writer.Reset(); writer.WriteCrawlBaselineBinding(binding); writer.WriteUShort(0); writer.WriteUShort(0);
        Reject(() => new NetworkReader(writer.ToArray()).ReadCrawlBaselineChunk(), "BASELINE_CHUNK");

        writer.Reset(); writer.WriteCrawlBaselineBegin(begin); byte[] valid = writer.ToArray();
        byte[] changed = (byte[])valid.Clone(); changed[0] = 2;
        Reject(() => new NetworkReader(changed).ReadCrawlBaselineBegin(), "VERSION_MISMATCH");
        changed = (byte[])valid.Clone(); changed[2] = (byte)'Z';
        Reject(() => new NetworkReader(changed).ReadCrawlBaselineBegin(), "BASELINE_BINDING");
        changed = (byte[])valid.Clone(); Array.Clear(changed, headerBytes - 4, 4);
        Reject(() => new NetworkReader(changed).ReadCrawlBaselineBegin(), "BASELINE_BINDING");
        bool allTruncated = true;
        for (int count = 0; count < valid.Length; count++)
        {
            try { new NetworkReader(new ArraySegment<byte>(valid, 0, count)).ReadCrawlBaselineBegin(); allTruncated = false; }
            catch (EndOfStreamException) { }
        }
        Check(allTruncated, "Truncated begin accepted");
        writer.Reset(); writer.WriteCrawlBaselineChunk(new CrawlBaselineChunk { binding = binding, index = 0, bytes = new ArraySegment<byte>(body, 0, 7) });
        valid = writer.ToArray(); allTruncated = true;
        for (int count = 0; count < valid.Length; count++)
        {
            try { new NetworkReader(new ArraySegment<byte>(valid, 0, count)).ReadCrawlBaselineChunk(); allTruncated = false; }
            catch (EndOfStreamException) { }
        }
        Check(allTruncated, "Truncated chunk accepted");
        Reject(() => Roundtrip(new CrawlBaselineChunk { binding = binding, bytes = new ArraySegment<byte>(body) }), "BASELINE_CHUNK");
        Reject(() => Roundtrip(new CrawlBaselineInstalled { binding = binding, sha256 = new byte[33] }), "BASELINE_HASH");

        // The largest legal baseline uses bounded messages, not one 8 MiB packet.
        byte[] largest = new byte[CrawlBaselineAssembler.MaxBytes];
        for (int i = 0; i < largest.Length; i++) largest[i] = (byte)(i % 251);
        binding.baselineId++;
        begin = Roundtrip(new CrawlBaselineBegin { binding = binding, totalBytes = largest.Length, chunks = 512, sha256 = Hash(largest) });
        assembler.Begin(binding.matchId, 2, 3, 5, begin.totalBytes, begin.chunks, begin.sha256, 3);
        int largestPacket = 0;
        for (int i = 511; i >= 0; i--)
        {
            writer.Reset(); NetworkMessages.Pack(new CrawlBaselineChunk { binding = binding, index = (ushort)i,
                bytes = new ArraySegment<byte>(largest, i * CrawlBaselineAssembler.ChunkBytes, CrawlBaselineAssembler.ChunkBytes) }, writer);
            largestPacket = Math.Max(largestPacket, writer.Position);
            var reader = new NetworkReader(writer.ToArray()); reader.ReadUShort(); var chunk = reader.Read<CrawlBaselineChunk>();
            assembler.Add(binding.matchId, 2, 3, 5, chunk.index, chunk.bytes, 4);
        }
        Check(largestPacket < 64 * 1024 && assembler.TakeVerified(5, 5).SequenceEqual(largest), "Largest legal baseline failed bounded transfer");
        File.WriteAllText(Path.Combine(System.Environment.GetEnvironmentVariable("CRAWL_TEST_OUTPUT"), "baseline-wire-tests.json"),
            "{\"passed\":true,\"checks\":" + checks + ",\"largestPacket\":" + largestPacket +
            ",\"scope\":\"Mirror generic serialization and bounded assembly; no world installation or socket integration yet\"}");
        Debug.Log("Crawl baseline wire tests passed: " + checks);
    }
}
