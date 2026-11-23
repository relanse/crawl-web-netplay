using System;
using System.IO;
using Mirror;
using UnityEngine;

public static class CrawlInputWireTests
{
    private static void Check(bool value, string message) { if (!value) throw new Exception(message); }
    private static void Reject(Action read, string message)
    {
        bool rejected = false;
        try { read(); } catch (InvalidDataException) { rejected = true; }
        Check(rejected, message);
    }
    public static void Run()
    {
        var batch = new CrawlInputBatch { protocolVersion = 1, matchId = new string('a', 32), sceneEpoch = 3, connectionEpoch = 2,
            batchSequence = 9, samples = new[] { new CrawlInputSample { sequence = 18, targetNetTick = 103,
                controlledEntityId = 42, ownershipRevision = 4, moveX = -.5f, heldButtons = 1,
                actions = new[] { new CrawlDiscreteAction { actionId = 7, kind = 1 } } } } };
        var writer = new NetworkWriter(); writer.WriteCrawlInputBatch(batch);
        byte[] valid = writer.ToArray();
        var reader = new NetworkReader(valid); var decoded = reader.ReadCrawlInputBatch();
        Check(reader.Remaining == 0 && decoded.matchId == batch.matchId && decoded.sceneEpoch == 3 && decoded.connectionEpoch == 2 &&
            decoded.samples[0].moveX == -.5f && decoded.samples[0].actions[0].actionId == 7, "Input wire roundtrip changed values");
        writer.Reset(); writer.WriteUShort(1); writer.WriteString(batch.matchId);
        writer.WriteUInt(3); writer.WriteUInt(2); writer.WriteUInt(9);
        int countOffset = writer.Position;
        byte[] tooMany = (byte[])valid.Clone(); tooMany[countOffset] = 255;
        Reject(() => new NetworkReader(tooMany).ReadCrawlInputBatch(), "Unbounded sample count accepted");
        byte[] empty = (byte[])valid.Clone(); empty[countOffset] = 0;
        Reject(() => new NetworkReader(empty).ReadCrawlInputBatch(), "Empty input batch accepted");
        byte[] actions = (byte[])valid.Clone(); actions[countOffset + 1 + 4 * 8 + 2] = 255;
        Reject(() => new NetworkReader(actions).ReadCrawlInputBatch(), "Unbounded action count accepted");
        bool truncated = false;
        try { new NetworkReader(new ArraySegment<byte>(valid, 0, valid.Length - 1)).ReadCrawlInputBatch(); }
        catch (EndOfStreamException) { truncated = true; }
        Check(truncated, "Truncated action accepted");
        batch.samples = new CrawlInputSample[9];
        Reject(() => new NetworkWriter().WriteCrawlInputBatch(batch), "Writer accepted oversized input");
        string root = System.Environment.GetEnvironmentVariable("CRAWL_TEST_OUTPUT");
        File.WriteAllText(Path.Combine(root, "input-wire-tests.json"), "{\"passed\":true,\"checks\":6}");
        Debug.Log("Netplay input wire tests passed.");
    }
}
