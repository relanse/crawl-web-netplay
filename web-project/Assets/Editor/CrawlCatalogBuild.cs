using System;
using System.IO;
using System.Linq;
using System.Collections.Generic;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using UnityEditor;
using UnityEngine;

public static class CrawlCatalogBuild
{
    public const string CatalogPath = "Assets/Resources/CrawlNetplayCatalog.asset";
    public static string Generate()
    {
        string[] guids = AssetDatabase.FindAssets("t:Prefab", new[] { "Assets/GameObject" }).OrderBy(guid => guid, StringComparer.Ordinal).ToArray();
        if (guids.Length == 0) throw new InvalidOperationException("No recovered prefabs found.");
        var entries = new List<CrawlPrefabCatalog.Entry>();
        string[] paths = guids.Select(AssetDatabase.GUIDToAssetPath).ToArray();
        var manifest = new StringBuilder("crawl-shared-content-v2\n" + Application.unityVersion + "\n");
        manifest.Append(CrawlVisualCatalogBuild.Generate());
        for (int i = 0; i < guids.Length; i++)
        {
            GameObject prefab = AssetDatabase.LoadAssetAtPath<GameObject>(paths[i]);
            if (prefab == null) throw new InvalidOperationException("Unable to load catalog prefab.");
            foreach (Transform part in prefab.GetComponentsInChildren<Transform>(true))
            {
                string assetGuid; long localId;
                if (!AssetDatabase.TryGetGUIDAndLocalFileIdentifier(part.gameObject, out assetGuid, out localId)) throw new InvalidOperationException("Prefab part has no stable asset identity.");
                var entry = new CrawlPrefabCatalog.Entry { prefabId = (uint)(entries.Count + 1), guid = assetGuid + ":" + localId.ToString(CultureInfo.InvariantCulture), prefab = part.gameObject };
                entries.Add(entry); manifest.Append(entry.prefabId).Append(' ').Append(entry.guid).Append('\n');
            }
        }
        // All shared source assets, including runtime-loaded resources, helper
        // scripts, Mirror, plugins, link.xml and import metadata. Prefab-only
        // dependency walks miss scripts and Resources loaded by string.
        // Exclude only our own generated catalog (no circular hash) and the
        // generated platform-specific transport fixture. Library/Temp never
        // participate. Platform build options remain separate from this hash.
        var dependencies = Directory.GetFiles("Assets", "*", SearchOption.AllDirectories)
            .Select(value => value.Replace('\\', '/'))
            .Where(value => value != CatalogPath && value != CatalogPath + ".meta" &&
                value != CrawlVisualCatalogBuild.Path && value != CrawlVisualCatalogBuild.Path + ".meta" &&
                !value.StartsWith("Assets/NetplayTests/", StringComparison.Ordinal) && value != "Assets/NetplayTests.meta")
            .Concat(new[] { "Packages/manifest.json", "Packages/packages-lock.json",
                "ProjectSettings/DynamicsManager.asset", "ProjectSettings/Physics2DSettings.asset",
                "ProjectSettings/TimeManager.asset", "ProjectSettings/TagManager.asset",
                "ProjectSettings/InputManager.asset", "ProjectSettings/NavMeshAreas.asset",
                "ProjectSettings/QualitySettings.asset", "ProjectSettings/GraphicsSettings.asset", "ProjectSettings/AudioManager.asset" })
            .Distinct(StringComparer.Ordinal).OrderBy(value => value, StringComparer.Ordinal);
        foreach (string dependency in dependencies)
        {
            manifest.Append(dependency).Append(' ').Append(Hash(File.ReadAllBytes(dependency))).Append('\n');
        }
        CrawlPrefabCatalog catalog = AssetDatabase.LoadAssetAtPath<CrawlPrefabCatalog>(CatalogPath);
        if (catalog == null) { catalog = ScriptableObject.CreateInstance<CrawlPrefabCatalog>(); AssetDatabase.CreateAsset(catalog, CatalogPath); }
        catalog.entries = entries.ToArray(); catalog.contentHash = Hash(Encoding.UTF8.GetBytes(manifest.ToString()));
        EditorUtility.SetDirty(catalog); AssetDatabase.SaveAssets();
        string output = System.Environment.GetEnvironmentVariable("CRAWL_TEST_OUTPUT");
        Directory.CreateDirectory(output);
        File.WriteAllText(Path.Combine(output, "catalog-source-manifest.txt"), manifest.ToString());
        File.WriteAllText(Path.Combine(output, "catalog.json"), "{\"rootPrefabs\":" + guids.Length + ",\"prefabsAndParts\":" + entries.Count + ",\"contentHash\":\"" + catalog.contentHash + "\",\"scope\":\"Original prefab/part identity mapping; visual replicas not generated yet\"}");
        Debug.Log("Crawl prefab catalog: " + entries.Count + " entries, hash " + catalog.contentHash);
        return catalog.contentHash;
    }
    private static string Hash(byte[] bytes)
    { using (var sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant(); }
}
