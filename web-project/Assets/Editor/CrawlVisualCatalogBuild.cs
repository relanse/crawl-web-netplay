using System;
using System.Linq;
using System.Text;
using UnityEditor;
using UnityEngine;

public static class CrawlVisualCatalogBuild
{
    public const string Path = "Assets/Resources/CrawlVisualCatalog.asset";
    public static string Generate()
    {
        var catalog = AssetDatabase.LoadAssetAtPath<CrawlVisualCatalog>(Path);
        if (catalog == null) { catalog = ScriptableObject.CreateInstance<CrawlVisualCatalog>(); AssetDatabase.CreateAsset(catalog, Path); }
        catalog.textures = Assets<Texture2D>("t:Texture2D");
        catalog.shaders = Assets<Shader>("t:Shader");
        catalog.fonts = Assets<Font>("t:Font");
        catalog.audioClips = Assets<AudioClip>("t:AudioClip");
        var manifest = new StringBuilder("visual-catalog-v1\n");
        foreach (var asset in catalog.textures.Cast<UnityEngine.Object>().Concat(catalog.shaders).Concat(catalog.fonts).Concat(catalog.audioClips))
        {
            string guid; long id;
            if (!AssetDatabase.TryGetGUIDAndLocalFileIdentifier(asset, out guid, out id)) throw new InvalidOperationException("Visual asset has no source identity.");
            manifest.Append(guid).Append(':').Append(id.ToString(System.Globalization.CultureInfo.InvariantCulture)).Append('\n');
        }
        EditorUtility.SetDirty(catalog); AssetDatabase.SaveAssets();
        Debug.Log("Crawl visual catalog: " + catalog.textures.Length + " textures, " + catalog.shaders.Length + " shaders.");
        return manifest.ToString();
    }
    private static T[] Assets<T>(string filter) where T : UnityEngine.Object
    {
        return AssetDatabase.FindAssets(filter, new[] { "Assets" }).OrderBy(x => x, StringComparer.Ordinal)
            .SelectMany(guid => AssetDatabase.LoadAllAssetsAtPath(AssetDatabase.GUIDToAssetPath(guid)).OfType<T>()
                .OrderBy(asset => { string g; long id; AssetDatabase.TryGetGUIDAndLocalFileIdentifier(asset, out g, out id); return id; }))
            .Distinct().ToArray();
    }
}
