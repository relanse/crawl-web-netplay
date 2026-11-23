using System;
using System.Collections.Generic;
using System.IO;
using UnityEngine;

public static class CrawlNetplayTests
{
    [Serializable] private class Report { public bool passed; public string unity; public string[] checks; }
    private static void Check(bool condition, string message) { if (!condition) throw new Exception(message); }
    public static void RunStorage()
    {
        string root = System.Environment.GetEnvironmentVariable("CRAWL_TEST_OUTPUT");
        if (string.IsNullOrEmpty(root) || !Path.IsPathRooted(root)) throw new Exception("CRAWL_TEST_OUTPUT must be absolute.");
        Directory.CreateDirectory(root);
        string directory = Path.Combine(root, "store-" + Guid.NewGuid().ToString("N"));
        var checks = new List<string>();
        var first = new CrawlServerSaveStrategy(directory);
        Check(first.GetSuccess() && !first.HasKey("gold"), "Empty store failed");
        first.SetInt("gold", 123); first.SetFloat("speed", 1.25f); first.SetString("name", "测试玩家"); first.Save();
        Check(first.GetSuccess(), first.GetLog());
        var second = new CrawlServerSaveStrategy(directory);
        Check(second.GetInt("gold") == 123 && second.GetFloat("speed") == 1.25f && second.GetString("name") == "测试玩家", "Typed roundtrip failed");
        Check(second.GetString("gold") == "", "Type confusion");
        checks.Add("Typed values roundtrip without PlayerPrefs or original save files");
        second.SetInt("gold", 456); second.Save();
        Check(new CrawlServerSaveStrategy(directory).GetString("name") == "测试玩家", "New transaction lost unrelated keys");
        checks.Add("Fresh transaction preserves unrelated keys");
        bool rejected = false;
        try { second.SetFloat("invalid", float.NaN); } catch (InvalidDataException) { rejected = true; }
        Check(rejected, "Accepted NaN");
        checks.Add("Non-finite values rejected");
        string file = Path.Combine(directory, "server-profile.v1.json");
        string valid = File.ReadAllText(file);
        using (var locked = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read))
        { second.SetInt("gold", 999); second.Save(); Check(!second.GetSuccess(), "Locked destination should fail atomically"); }
        Check(File.ReadAllText(file) == valid, "Failed transaction changed last good profile");
        checks.Add("Failed atomic replacement preserves last good profile");
        File.WriteAllText(file, "{\"version\":999,\"entries\":[]}");
        var corrupt = new CrawlServerSaveStrategy(directory);
        Check(corrupt.GetCorrupt() && !corrupt.GetSuccess(), "Unknown schema accepted");
        corrupt.SetInt("gold", 1); corrupt.Save();
        Check(!corrupt.GetSuccess() && File.ReadAllText(file).Contains("999"), "Corrupt profile silently overwritten");
        checks.Add("Corrupt/future schema refuses destructive overwrite");
        File.WriteAllText(file, "{\"version\":1,\"entries\":[{\"key\":\"x\",\"kind\":\"int\"},{\"key\":\"x\",\"kind\":\"int\"}]}");
        Check(new CrawlServerSaveStrategy(directory).GetCorrupt(), "Duplicate key accepted");
        checks.Add("Duplicate keys rejected");
        File.WriteAllText(file, valid);
        var cleared = new CrawlServerSaveStrategy(directory); cleared.DeleteKey("name"); cleared.Save();
        Check(!new CrawlServerSaveStrategy(directory).HasKey("name"), "DeleteKey did not persist");
        cleared.DeleteAll(); Check(cleared.GetSuccess() && !new CrawlServerSaveStrategy(directory).HasKey("gold"), "DeleteAll did not persist");
        checks.Add("Explicit deletion stays inside the isolated profile");
        File.WriteAllText(Path.Combine(root, "storage-tests.json"), JsonUtility.ToJson(new Report { passed = true, unity = Application.unityVersion, checks = checks.ToArray() }, true));
        Debug.Log("Netplay storage tests passed: " + checks.Count);
        CrawlInputBufferTests.Run();
        CrawlInputWireTests.Run();
        CrawlEntityRegistryTests.Run();
        CrawlPrefabCatalogTests.Run();
        CrawlHeadlessSpriteTests.Run();
        CrawlBaselineAssemblerTests.Run();
        CrawlBaselineWireTests.Run();
        CrawlWorldFrameTests.Run();
    }
}
