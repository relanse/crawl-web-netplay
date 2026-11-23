using System;
using System.IO;
using System.Linq;
using System.Text;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

// Run in batch mode to inspect recovered resource links without opening a window.
public static class CrawlWebAudit
{
    public static void Scan()
    {
        StringBuilder report = new StringBuilder();
        int missing = 0;
        foreach (string guid in AssetDatabase.FindAssets("t:Prefab", new[] { "Assets" }))
        {
            string path = AssetDatabase.GUIDToAssetPath(guid);
            GameObject root = AssetDatabase.LoadAssetAtPath<GameObject>(path);
            if (root == null) { report.AppendLine("INVALID PREFAB " + path); missing++; continue; }
            foreach (Transform transform in root.GetComponentsInChildren<Transform>(true))
            {
                int count = GameObjectUtility.GetMonoBehavioursWithMissingScriptCount(transform.gameObject);
                if (count > 0) { report.AppendLine("MISSING SCRIPT " + path + " :: " + transform.name + " :: " + count); missing += count; }
            }
        }
        foreach (EditorBuildSettingsScene entry in EditorBuildSettings.scenes.Where(s => s.enabled))
        {
            var scene = EditorSceneManager.OpenScene(entry.path, OpenSceneMode.Single);
            foreach (GameObject root in scene.GetRootGameObjects())
            foreach (Transform transform in root.GetComponentsInChildren<Transform>(true))
            {
                int count = GameObjectUtility.GetMonoBehavioursWithMissingScriptCount(transform.gameObject);
                if (count > 0) { report.AppendLine("MISSING SCRIPT " + entry.path + " :: " + transform.name + " :: " + count); missing += count; }
            }
        }
        foreach (string guid in AssetDatabase.FindAssets("t:Font", new[] { "Assets/Font" }))
        {
            string path = AssetDatabase.GUIDToAssetPath(guid);
            foreach (UnityEngine.Object asset in AssetDatabase.LoadAllAssetsAtPath(path))
            {
                string assetGuid; long id;
                if (AssetDatabase.TryGetGUIDAndLocalFileIdentifier(asset, out assetGuid, out id))
                    report.AppendLine("FONT SUBASSET " + path + " :: " + asset.GetType().Name + " :: " + assetGuid + " :: " + id);
            }
        }
        report.Insert(0, "Missing script count: " + missing + "\n");
        string output = Path.GetFullPath(Path.Combine(Application.dataPath, "../../analysis/unity-resource-audit.txt"));
        File.WriteAllText(output, report.ToString());
        Debug.Log("Crawl resource audit written to " + output + "; missing scripts: " + missing);
    }
}
