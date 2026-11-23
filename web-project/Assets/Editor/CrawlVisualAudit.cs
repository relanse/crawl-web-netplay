using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEngine;

public static class CrawlVisualAudit
{
    [Serializable] private class Row { public string name; public int count; }
    [Serializable] private class ColliderDependency
    {
        public string prefab, objectPath, planeType, colliderType;
        public bool autoResize, autoLength;
    }
    [Serializable] private class Report
    {
        public int rootPrefabs, sprites, atlasSprites, plainSprites;
        public Row[] planeTypes, shaderTypes;
        public ColliderDependency[] renderDrivenColliders;
    }
    public static void Run()
    {
        var report = new Report(); var helpers = new List<ColliderDependency>();
        var planes = new Dictionary<string, int>(); var shaders = new Dictionary<string, int>();
        foreach (string guid in AssetDatabase.FindAssets("t:Prefab", new[] { "Assets/GameObject" }).OrderBy(value => value, StringComparer.Ordinal))
        {
            string path = AssetDatabase.GUIDToAssetPath(guid);
            var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(path); report.rootPrefabs++;
            foreach (var plane in prefab.GetComponentsInChildren<exPlane>(true)) Count(planes, plane.GetType().Name);
            foreach (var sprite in prefab.GetComponentsInChildren<exSprite>(true))
            {
                report.sprites++; if (sprite.useAtlas) report.atlasSprites++; else report.plainSprites++;
                var renderer = sprite.GetComponent<Renderer>();
                if (renderer != null && renderer.sharedMaterial != null && renderer.sharedMaterial.shader != null)
                    Count(shaders, renderer.sharedMaterial.shader.name);
            }
            foreach (var helper in prefab.GetComponentsInChildren<exCollisionHelper>(true))
            {
                var plane = helper.GetComponent<exPlane>(); var collider = helper.GetComponent<Collider>();
                helpers.Add(new ColliderDependency { prefab = path, objectPath = AnimationUtility.CalculateTransformPath(helper.transform, prefab.transform),
                    planeType = plane == null ? "none" : plane.GetType().Name, colliderType = collider == null ? "none" : collider.GetType().Name,
                    autoResize = helper.autoResizeCollision, autoLength = helper.autoLength });
            }
        }
        report.planeTypes = Rows(planes); report.shaderTypes = Rows(shaders); report.renderDrivenColliders = helpers.ToArray();
        string output = System.Environment.GetEnvironmentVariable("CRAWL_TEST_OUTPUT");
        if (string.IsNullOrEmpty(output) || !Path.IsPathRooted(output)) throw new InvalidOperationException("Isolated output directory required.");
        Directory.CreateDirectory(output); File.WriteAllText(Path.Combine(output, "visual-audit.json"), JsonUtility.ToJson(report, true));
        Debug.Log("Crawl visual audit: " + report.sprites + " sprites, " + helpers.Count + " render-driven collider helpers.");
    }
    private static void Count(Dictionary<string, int> values, string key) { int count; values.TryGetValue(key, out count); values[key] = count + 1; }
    private static Row[] Rows(Dictionary<string, int> values)
    { return values.OrderBy(pair => pair.Key, StringComparer.Ordinal).Select(pair => new Row { name = pair.Key, count = pair.Value }).ToArray(); }
}
