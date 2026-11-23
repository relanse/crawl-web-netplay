using System;
using System.IO;
using UnityEngine;

public static class CrawlPrefabCatalogTests
{
    private static void Check(bool value, string message) { if (!value) throw new Exception(message); }
    public static void Run()
    {
        var source = new GameObject("Room source");
        var part = new GameObject("BackWallArt"); part.transform.SetParent(source.transform);
        var catalog = ScriptableObject.CreateInstance<CrawlPrefabCatalog>();
        catalog.entries = new[] {
            new CrawlPrefabCatalog.Entry { prefabId = 1, guid = "asset:1", prefab = source },
            new CrawlPrefabCatalog.Entry { prefabId = 2, guid = "asset:2", prefab = part }
        };
        GameObject instance = null, split = null, impostor = null;
        try
        {
            instance = UnityEngine.Object.Instantiate(source); catalog.StampInstance(instance, source);
            Check(catalog.GetId(instance) == 1 && catalog.GetId(instance.transform.GetChild(0).gameObject) == 2,
                "Root or child lost stable prefab provenance");
            var runtimePart = instance.transform.GetChild(0).gameObject;
            // Room.BuildWalls mutates/clones a runtime child, not an asset root.
            runtimePart.transform.localScale = new Vector3(.5f, 1, 1);
            split = UnityEngine.Object.Instantiate(runtimePart); catalog.StampInstance(split, runtimePart);
            Check(catalog.GetId(split) == 2 && split.transform.localScale.x == .5f,
                "Runtime wall clone lost original part identity or runtime transform");
            UnityEngine.Object.DestroyImmediate(runtimePart);
            catalog.StampInstance(instance, source);
            Check(catalog.GetId(instance) == 1, "Reused effect lost provenance when its child was removed");
            Check(source.GetComponent<CrawlPrefabOrigin>() == null && part.GetComponent<CrawlPrefabOrigin>() == null,
                "Stamping an instance mutated source prefabs");
            impostor = new GameObject("BackWallArt"); bool rejected = false;
            try { catalog.GetId(impostor); } catch (InvalidOperationException) { rejected = true; }
            Check(rejected, "Resource resolved by object name instead of provenance");
            File.WriteAllText(Path.Combine(System.Environment.GetEnvironmentVariable("CRAWL_TEST_OUTPUT"), "catalog-tests.json"),
                "{\"passed\":true,\"checks\":5,\"scope\":\"root/child provenance, runtime wall clones, reused effects, source isolation, unknown rejection\"}");
            Debug.Log("Crawl prefab provenance tests passed.");
        }
        finally
        {
            if (impostor != null) UnityEngine.Object.DestroyImmediate(impostor);
            if (split != null) UnityEngine.Object.DestroyImmediate(split);
            if (instance != null) UnityEngine.Object.DestroyImmediate(instance);
            UnityEngine.Object.DestroyImmediate(source); UnityEngine.Object.DestroyImmediate(catalog);
        }
    }
}
