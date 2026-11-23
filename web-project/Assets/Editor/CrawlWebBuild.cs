using System;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEngine;

// Build the isolated recovery project. A successful build still needs browser QA.
public static class CrawlWebBuild
{
	[MenuItem("Crawl/Build WebGL candidate")]
	public static void Build()
	{
		string project = Directory.GetParent(Application.dataPath).FullName;
		string output = System.Environment.GetEnvironmentVariable("CRAWL_WEB_OUTPUT");
		if (string.IsNullOrEmpty(output))
		{
			output = Path.GetFullPath(Path.Combine(project, "../build"));
		}
		string[] scenes = EditorBuildSettings.scenes.Where(s => s.enabled).Select(s => s.path).ToArray();
		if (scenes.Length == 0)
		{
			throw new InvalidOperationException("No recovered game scenes in Build Settings.");
		}
		int placeholders = Directory.GetFiles(Application.dataPath, "*.shader", SearchOption.AllDirectories)
			.Count(p => File.ReadAllText(p).Contains("DummyShaderTextExporter"));
		if (placeholders > 0)
		{
			Debug.LogWarning("Recovered shaders still contain " + placeholders +
				" placeholders. This candidate does not establish visual fidelity.");
		}
		PlayerSettings.runInBackground = true;
		// Keep the original memory budget; allow the browser heap to grow as needed.
#if UNITY_2021_2_OR_NEWER
		PlayerSettings.WebGL.initialMemorySize = 512;
		PlayerSettings.WebGL.maximumMemorySize = 2048;
		PlayerSettings.WebGL.compressionFormat = WebGLCompressionFormat.Disabled;
		PlayerSettings.WebGL.dataCaching = true;
		PlayerSettings.WebGL.exceptionSupport = WebGLExceptionSupport.FullWithStacktrace;
#else
		PlayerSettings.SetPropertyInt("memorySize", 512, BuildTargetGroup.WebGL);
#endif
		Directory.CreateDirectory(output);
#if UNITY_2018_1_OR_NEWER
		UnityEditor.Build.Reporting.BuildReport report = BuildPipeline.BuildPlayer(scenes, output, BuildTarget.WebGL, BuildOptions.None);
		string error = report.summary.result == UnityEditor.Build.Reporting.BuildResult.Succeeded ? string.Empty : report.summary.result.ToString();
#else
		string error = BuildPipeline.BuildPlayer(scenes, output, BuildTarget.WebGL, BuildOptions.None);
#endif
		if (!string.IsNullOrEmpty(error))
		{
			throw new InvalidOperationException(error);
		}
		if (!File.Exists(Path.Combine(output, "index.html")))
		{
			throw new InvalidOperationException("WebGL build did not produce index.html.");
		}
		Debug.Log("Crawl WebGL candidate written to " + output);
	}
}
