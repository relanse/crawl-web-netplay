using System;
using System.IO;
using UnityEngine;

public static class CrawlEntityRegistryTests
{
    private static void Check(bool condition, string message) { if (!condition) throw new Exception(message); }
    public static void Run()
    {
        var prefab = new GameObject("Registry test prefab"); var instance = new GameObject("Registry test instance");
        try
        {
            var registry = new CrawlEntityRegistry(value => value == prefab ? 12u : 0u);
            int released = 0; registry.Released += _ => released++;
            var first = registry.Spawn(instance, prefab, false);
            Check(first.entityId == 1 && !first.ready && first.prefabId == 12, "Initial lifecycle incorrect");
            registry.FinalizeSpawn(instance); Check(first.ready, "Two-stage spawn not finalized");
            bool duplicate = false; try { registry.Spawn(instance, prefab, true); } catch (InvalidOperationException) { duplicate = true; }
            Check(duplicate, "Duplicate live object registered");
            registry.Release(instance); registry.Release(instance);
            Check(registry.Find(first.entityId) == null && released == 1, "Release not idempotent");
            var second = registry.Spawn(instance, prefab, true);
            Check(second.entityId > first.entityId && registry.FindId(instance) == second.entityId, "Pooled instance reused entity ID");
            UnityEngine.Object.DestroyImmediate(instance); instance = null;
            registry.PruneDestroyed(); // Edit mode doesn't promise MonoBehaviour.OnDestroy.
            Check(registry.Count == 0 && released == 2, "Destroyed object retained entity record");
            instance = new GameObject("Overflow test instance");
            var exhausted = new CrawlEntityRegistry(_ => 12, uint.MaxValue);
            bool overflow = false; try { exhausted.Spawn(instance, prefab, true); } catch (InvalidOperationException) { overflow = true; }
            Check(overflow && exhausted.Count == 0, "ID wrapped or half-committed");
            File.WriteAllText(Path.Combine(System.Environment.GetEnvironmentVariable("CRAWL_TEST_OUTPUT"), "entity-tests.json"), "{\"passed\":true,\"checks\":7,\"scope\":\"registry lifecycles, pool reuse, destroy, wrap; not full world replication\"}");
            Debug.Log("Crawl entity registry tests passed.");
        }
        finally { if (instance != null) UnityEngine.Object.DestroyImmediate(instance); UnityEngine.Object.DestroyImmediate(prefab); }
    }
}
