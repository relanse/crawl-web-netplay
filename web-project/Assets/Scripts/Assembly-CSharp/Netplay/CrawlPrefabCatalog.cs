using System;
using System.Collections.Generic;
using UnityEngine;

public sealed class CrawlPrefabCatalog : ScriptableObject
{
    [Serializable] public sealed class Entry { public uint prefabId; public string guid; public GameObject prefab; }
    public string contentHash;
    public Entry[] entries;
    private Dictionary<GameObject, uint> byPrefab;
    private Dictionary<uint, GameObject> byId;
    private void Index()
    {
        if (byPrefab != null) return;
        var prefabs = new Dictionary<GameObject, uint>(); var ids = new Dictionary<uint, GameObject>();
        if (entries == null) throw new InvalidOperationException("Missing prefab catalog entries.");
        foreach (Entry entry in entries)
        {
            if (entry == null || entry.prefab == null || entry.prefabId == 0 || string.IsNullOrEmpty(entry.guid) ||
                prefabs.ContainsKey(entry.prefab) || ids.ContainsKey(entry.prefabId)) throw new InvalidOperationException("Invalid prefab catalog.");
            prefabs.Add(entry.prefab, entry.prefabId); ids.Add(entry.prefabId, entry.prefab);
        }
        byPrefab = prefabs; byId = ids;
    }
    public uint GetId(GameObject prefab)
    {
        Index(); uint id;
        if (prefab != null && byPrefab.TryGetValue(prefab, out id)) return id;
        CrawlPrefabOrigin origin = prefab == null ? null : prefab.GetComponent<CrawlPrefabOrigin>();
        if (origin != null && byId.ContainsKey(origin.prefabId)) return origin.prefabId;
        throw new InvalidOperationException("Spawned prefab is absent from the release catalog: " + (prefab == null ? "null" : prefab.name));
    }
    public GameObject GetPrefab(uint id)
    { Index(); GameObject prefab; if (!byId.TryGetValue(id, out prefab)) throw new InvalidOperationException("Unknown release prefab ID."); return prefab; }
    public void StampInstance(GameObject instance, GameObject source)
    {
        Index(); uint id;
        if (!byPrefab.TryGetValue(source, out id))
        {
            // Runtime clones inherit serialized provenance on all known parts.
            if (GetId(instance) != GetId(source)) throw new InvalidOperationException("Runtime clone lost prefab provenance.");
            return;
        }
        var origin = instance.GetComponent<CrawlPrefabOrigin>();
        if (origin != null && origin.hierarchyStamped)
        {
            if (origin.prefabId != id) throw new InvalidOperationException("Pooled object has a different source prefab.");
            return;
        }
        // Effects may detach or destroy children after their first spawn.
        StampPart(instance.transform, source.transform);
        instance.GetComponent<CrawlPrefabOrigin>().hierarchyStamped = true;
    }
    private void StampPart(Transform instance, Transform source)
    {
        uint id = GetId(source.gameObject);
        var origin = instance.GetComponent<CrawlPrefabOrigin>();
        if (origin == null) origin = instance.gameObject.AddComponent<CrawlPrefabOrigin>();
        origin.prefabId = id;
        if (instance.childCount < source.childCount) throw new InvalidOperationException("Prefab structure changed before provenance installation.");
        for (int i = 0; i < source.childCount; i++)
        {
            Transform a = instance.GetChild(i), b = source.GetChild(i);
            if (a.name != b.name) throw new InvalidOperationException("Prefab child order changed before provenance installation.");
            StampPart(a, b);
        }
    }
}
