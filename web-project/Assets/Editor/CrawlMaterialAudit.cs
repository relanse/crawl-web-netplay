using System;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEngine;

public static class CrawlMaterialAudit
{
    [Serializable] private class Entry { public string path, shader, atlas, palette, expectedPalettePath; public bool supported, hasPalette; public Color tint; }
    [Serializable] private class Report { public Entry[] materials; }
    public static void Run()
    {
        var paths = new[] { "AtlasHeroP1", "AtlasHeroP2", "AtlasHeroClipP1", "AtlasHeroClipP2", "MaterialPaletted" };
        var report = new Report { materials = paths.Select(name => {
            string path = "Assets/Material/" + name + ".mat"; var m = AssetDatabase.LoadAssetAtPath<Material>(path);
            return new Entry { path = path, shader = m.shader.name, supported = m.shader.isSupported, hasPalette = m.HasProperty("_ColorRamp"),
                atlas = m.mainTexture == null ? "null" : m.mainTexture.name, palette = m.GetTexture("_ColorRamp") == null ? "null" : m.GetTexture("_ColorRamp").name,
                expectedPalettePath = AssetDatabase.GUIDToAssetPath("ea938c92e24400f49a70393323386a9c"), tint = m.GetColor("_Tint") };
        }).ToArray() };
        string output = System.Environment.GetEnvironmentVariable("CRAWL_TEST_OUTPUT"); Directory.CreateDirectory(output);
        File.WriteAllText(Path.Combine(output, "material-import.json"), JsonUtility.ToJson(report, true));
    }
}
