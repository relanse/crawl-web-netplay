using System;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using UnityEngine;

public static class CrawlBaselineAssemblerTests
{
    private static int checks;
    private static readonly string Match = new string('a', 32);
    private static void Check(bool value, string message) { checks++; if (!value) throw new Exception(message); }
    private static void Reject(Action action, string code)
    {
        bool rejected = false; try { action(); } catch (InvalidDataException error) { rejected = error.Message == code; }
        Check(rejected, "Expected " + code);
    }
    private static byte[] Hash(byte[] bytes) { using (var sha = SHA256.Create()) return sha.ComputeHash(bytes); }
    public static void Run()
    {
        checks = 0;
        byte[] body = Enumerable.Range(0, CrawlBaselineAssembler.ChunkBytes + 7).Select(i => (byte)(i % 251)).ToArray();
        var assembler = new CrawlBaselineAssembler(Match, 2, 3);
        Reject(() => assembler.Begin(Match, 2, 3, 1, CrawlBaselineAssembler.MaxBytes + 1, 513, Hash(body), 0), "BASELINE_LIMIT");
        Check(assembler.BufferedBytes == 0, "Oversized begin allocated memory");
        Reject(() => assembler.Begin(Match, 2, 3, 1, body.Length, 1, Hash(body), 0), "BASELINE_LIMIT");
        Reject(() => assembler.Begin(Match, 1, 3, 1, body.Length, 2, Hash(body), 0), "BASELINE_BINDING");
        byte[] digest = Hash(body);
        Check(assembler.Begin(Match, 2, 3, 1, body.Length, 2, digest, 0), "Valid begin rejected");
        digest[0] ^= 1; // Caller cannot mutate the admitted hash.
        var last = new ArraySegment<byte>(body, CrawlBaselineAssembler.ChunkBytes, 7);
        Check(assembler.Add(Match, 2, 3, 1, 1, last, 1), "Out-of-order chunk rejected");
        Reject(() => assembler.TakeVerified(1, 1), "BASELINE_INCOMPLETE");
        Check(!assembler.Add(Match, 2, 3, 1, 1, last, 2) && assembler.ReceivedChunks == 1, "Duplicate counted twice");
        Reject(() => assembler.Add(Match, 2, 3, 1, 1, new ArraySegment<byte>(new byte[7]), 2), "BASELINE_CONFLICT");
        Reject(() => assembler.Add(Match, 2, 3, 1, 0, last, 2), "BASELINE_CHUNK");
        assembler.Add(Match, 2, 3, 1, 0, new ArraySegment<byte>(body, 0, CrawlBaselineAssembler.ChunkBytes), 3);
        Check(assembler.Complete && assembler.TakeVerified(1, 3).SequenceEqual(body) && assembler.BufferedBytes == 0,
            "Verified body changed or staging buffer was retained");
        Check(!assembler.Begin(Match, 2, 3, 1, body.Length, 2, Hash(body), 4), "Installed ID restarted");
        assembler.Begin(Match, 2, 3, 2, body.Length, 2, Hash(body), 4);
        assembler.Begin(Match, 2, 3, 3, body.Length, 2, Hash(body), 5);
        Check(!assembler.Add(Match, 2, 3, 2, 0, new ArraySegment<byte>(body, 0, CrawlBaselineAssembler.ChunkBytes), 6) && assembler.ReceivedChunks == 0,
            "Old baseline contaminated its replacement");
        assembler.Begin(Match, 2, 3, 3, body.Length, 2, Hash(body), 34);
        Reject(() => assembler.Expire(35), "RESYNC_TIMEOUT");
        Check(assembler.BufferedBytes == 0, "Timed-out assembly retained memory");
        byte[] tiny = { 1, 2, 3 }; assembler.Begin(Match, 2, 3, 4, 3, 1, Hash(tiny), 36);
        assembler.Add(Match, 2, 3, 4, 0, new ArraySegment<byte>(new byte[] { 1, 2, 4 }), 37);
        Reject(() => assembler.TakeVerified(4, 37), "BASELINE_HASH");
        Check(assembler.BufferedBytes == 0, "Invalid body survived hash failure");
        assembler.Begin(Match, 2, 3, 5, 3, 1, Hash(tiny), 38); assembler.AdvanceScene(4);
        Check(!assembler.Add(Match, 2, 3, 5, 0, new ArraySegment<byte>(tiny), 39) && assembler.BufferedBytes == 0, "Old scene chunk accepted");
        assembler.Begin(Match, 2, 4, 6, 3, 1, Hash(tiny), 40);
        assembler.Add(Match, 2, 4, 6, 0, new ArraySegment<byte>(tiny), 41); tiny[0] = 9;
        Check(assembler.TakeVerified(6, 41)[0] == 1, "Caller mutation changed a received chunk");
        File.WriteAllText(Path.Combine(System.Environment.GetEnvironmentVariable("CRAWL_TEST_OUTPUT"), "baseline-tests.json"),
            "{\"passed\":true,\"checks\":" + checks + ",\"scope\":\"Bounded atomic byte staging only; world parsing and transport not wired\"}");
        Debug.Log("Crawl baseline assembler tests passed: " + checks);
    }
}
