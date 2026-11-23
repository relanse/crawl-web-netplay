using System;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEditor.Build.Reporting;
using UnityEngine;

public static class CrawlServerBuild
{
    public static void TestAndBuildWindowsProbe()
    {
        CrawlNetplayTests.RunStorage();
        BuildWindowsProbe();
    }
    public static void BuildWindowsProbe()
    { Build(true); }
    public static void BuildWindowsServer()
    { CrawlNetplayTests.RunStorage(); Build(false); }
    public static void BuildLinuxServer() { Build(false, true); }
    private static void Build(bool probe, bool linux = false)
    {
        string output = System.Environment.GetEnvironmentVariable("CRAWL_SERVER_OUTPUT");
        if (string.IsNullOrWhiteSpace(output) || !Path.IsPathRooted(output))
            throw new InvalidOperationException("Set an isolated absolute CRAWL_SERVER_OUTPUT directory.");
        Directory.CreateDirectory(output);
        string contentHash = CrawlCatalogBuild.Generate();
        string[] scenes = EditorBuildSettings.scenes.Where(s => s.enabled).Select(s => s.path)
            .OrderBy(s => s.EndsWith("/SceneMenuMain.unity") ? 0 : 1).ToArray();
        BuildReport report = BuildPipeline.BuildPlayer(new BuildPlayerOptions {
            scenes = scenes,
            locationPathName = Path.Combine(output, linux ? "CrawlServer.x86_64" : probe ? "CrawlAuthorityProbe.exe" : "CrawlServer.exe"),
            target = linux ? BuildTarget.StandaloneLinux64 : BuildTarget.StandaloneWindows64,
            subtarget = (int)StandaloneBuildSubtarget.Player,
            extraScriptingDefines = probe ? new[] { "CRAWL_AUTHORITY", "CRAWL_NETPLAY_TESTS", "CRAWL_TRANSPORT_PROBE" } : new[] { "CRAWL_AUTHORITY", "CRAWL_GAME_SERVER" },
            options = probe ? BuildOptions.Development : BuildOptions.None
        });
        File.WriteAllText(Path.Combine(output, "build-report.json"), JsonUtility.ToJson(new Result {
            result = report.summary.result.ToString(), errors = (int)report.summary.totalErrors,
            bytes = report.summary.totalSize.ToString(), target = linux ? "Linux x86_64 Mono (CPU Mesa)" : probe ? "Windows native headless probe" : "Windows native authority",
            unity = Application.unityVersion, contentHash = contentHash, kind = probe ? "probe" : "authority"
        }, true));
        var problems = report.steps.SelectMany(step => step.messages
            .Where(message => message.type == LogType.Error || message.type == LogType.Exception || message.type == LogType.Assert)
            .Select(message => step.name + ": " + message.type + ": " + message.content)).ToArray();
        File.WriteAllLines(Path.Combine(output, "build-problems.txt"), problems);
        if (report.summary.result != BuildResult.Succeeded) throw new InvalidOperationException("Authority probe build failed.");
    }
    [Serializable] private class Result { public string result, bytes, target, unity, contentHash, kind; public int errors; }
}
