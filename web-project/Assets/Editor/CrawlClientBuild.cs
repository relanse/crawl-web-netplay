using System;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEditor.Build.Reporting;
using UnityEditor.SceneManagement;
using UnityEngine;

public static class CrawlClientBuild
{
    [Serializable] private class Files { public string loader, data, framework, wasm; }
    [Serializable] private class Manifest { public string kind = "client", releaseId = "crawl-online-v1", contentHash; public Files files; }
    public static void Build()
    {
        string output = System.Environment.GetEnvironmentVariable("CRAWL_WEB_OUTPUT");
        if (string.IsNullOrEmpty(output) || !Path.IsPathRooted(output)) throw new ArgumentException("Absolute CRAWL_WEB_OUTPUT required.");
        Directory.CreateDirectory("Assets/NetplayTests");
        var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
        const string scenePath = "Assets/NetplayTests/NetworkClient.unity";
        EditorSceneManager.SaveScene(scene, scenePath);
        PlayerSettings.WebGL.compressionFormat = WebGLCompressionFormat.Brotli;
        PlayerSettings.WebGL.exceptionSupport = WebGLExceptionSupport.FullWithStacktrace;
        string hash = CrawlCatalogBuild.Generate();
        var catalog = AssetDatabase.LoadAssetAtPath<CrawlPrefabCatalog>(CrawlCatalogBuild.CatalogPath);
        byte[] authorityCatalog = File.ReadAllBytes(CrawlCatalogBuild.CatalogPath);
        BuildReport report;
        try
        {
            // The client needs the shared content identity and visual/audio
            // assets, not the original gameplay prefab graph.
            catalog.entries = new CrawlPrefabCatalog.Entry[0]; EditorUtility.SetDirty(catalog); AssetDatabase.SaveAssets();
            report = BuildPipeline.BuildPlayer(new BuildPlayerOptions {
                scenes = new[] { scenePath }, locationPathName = output, target = BuildTarget.WebGL,
                extraScriptingDefines = new[] { "CRAWL_NETWORK_CLIENT" }, options = BuildOptions.None
            });
        }
        finally { File.WriteAllBytes(CrawlCatalogBuild.CatalogPath, authorityCatalog); AssetDatabase.ImportAsset(CrawlCatalogBuild.CatalogPath, ImportAssetOptions.ForceSynchronousImport); }
        if (report.summary.result != BuildResult.Succeeded) throw new Exception("Network client build failed.");
        string[] files = Directory.GetFiles(Path.Combine(output, "Build")).Select(p => "Build/" + Path.GetFileName(p)).ToArray();
        File.WriteAllText(Path.Combine(output, "client-build.json"), JsonUtility.ToJson(new Manifest { contentHash = hash,
            files = new Files { loader = files.Single(p => p.EndsWith(".loader.js")), data = files.Single(p => p.EndsWith(".data.br")),
                framework = files.Single(p => p.EndsWith(".framework.js.br")), wasm = files.Single(p => p.EndsWith(".wasm.br")) } }, true));
    }
}
