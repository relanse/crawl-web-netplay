using System;
using System.IO;
using UnityEditor;
using UnityEditor.Build.Reporting;
using UnityEditor.SceneManagement;
using UnityEngine;

public static class CrawlTransportProbeBuild
{
    public static void BuildWeb()
    {
        string output = System.Environment.GetEnvironmentVariable("CRAWL_WEB_OUTPUT");
        if (string.IsNullOrEmpty(output) || !Path.IsPathRooted(output)) throw new ArgumentException("Isolated absolute CRAWL_WEB_OUTPUT required.");
        Directory.CreateDirectory("Assets/NetplayTests");
        var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
        // Shader.Find alone does not preserve a shader during player stripping.
        const string materialPath = "Assets/NetplayTests/ProbeMarker.mat";
        Material material = AssetDatabase.LoadAssetAtPath<Material>(materialPath);
        if (material == null)
        {
            material = new Material(Shader.Find("Unlit/Color"));
            AssetDatabase.CreateAsset(material, materialPath);
        }
        var reference = GameObject.CreatePrimitive(PrimitiveType.Quad);
        reference.name = "Probe shader build reference";
        reference.GetComponent<Renderer>().sharedMaterial = material;
        reference.SetActive(false);
        string path = "Assets/NetplayTests/TransportProbe.unity";
        EditorSceneManager.SaveScene(scene, path);
        PlayerSettings.WebGL.compressionFormat = WebGLCompressionFormat.Disabled;
        PlayerSettings.WebGL.exceptionSupport = WebGLExceptionSupport.FullWithStacktrace;
        string contentHash = CrawlCatalogBuild.Generate();
        BuildReport report = BuildPipeline.BuildPlayer(new BuildPlayerOptions {
            scenes = new[] { path }, locationPathName = output, target = BuildTarget.WebGL,
            extraScriptingDefines = new[] { "CRAWL_TRANSPORT_PROBE" }, options = BuildOptions.Development
        });
        if (report.summary.result != BuildResult.Succeeded) throw new Exception("Web transport probe build failed.");
        File.WriteAllText(Path.Combine(output, "probe-build.json"), "{\"result\":\"Succeeded\",\"contentHash\":\"" + contentHash + "\",\"scope\":\"Mirror WebGL transport fixture, not the production client\"}");
    }
}
