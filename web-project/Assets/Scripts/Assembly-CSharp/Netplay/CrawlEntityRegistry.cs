using System;
using System.Collections.Generic;
using UnityEngine;

// A match owns one registry. Unity instance IDs never appear on the wire.
public sealed class CrawlEntityRegistry
{
    public sealed class Entity
    {
        public uint entityId, prefabId;
        public GameObject instance;
        public bool ready;
    }
    public static CrawlEntityRegistry Current { get; private set; }
    private readonly Func<GameObject, uint> resolve;
    private readonly Action<GameObject, GameObject> prepare;
    private readonly Dictionary<GameObject, Entity> objects = new Dictionary<GameObject, Entity>();
    private readonly Dictionary<uint, Entity> ids = new Dictionary<uint, Entity>();
    private readonly List<GameObject> destroyed = new List<GameObject>();
    private uint lastId;
    public uint LastAllocatedId { get { return lastId; } }
    public int Count { get { return ids.Count; } }
    public IEnumerable<Entity> Entities { get { return ids.Values; } }
    public event Action<uint> Released;
    public CrawlEntityRegistry(Func<GameObject, uint> resolver, uint previousId = 0, Action<GameObject, GameObject> prepareInstance = null)
    { resolve = resolver ?? throw new ArgumentNullException("resolver"); lastId = previousId; prepare = prepareInstance; }
    public static void Install(CrawlPrefabCatalog catalog)
    {
        if (!CrawlRuntimeMode.IsAuthority || Current != null || catalog == null) throw new InvalidOperationException("Invalid entity registry installation.");
        Current = new CrawlEntityRegistry(catalog.GetId, 0, catalog.StampInstance);
    }
    public static void Uninstall() { Current = null; }
    public Entity Spawn(GameObject instance, GameObject prefab, bool ready)
    {
        if (instance == null || prefab == null) throw new ArgumentNullException();
        if (objects.ContainsKey(instance)) throw new InvalidOperationException("Object already has a live entity lifecycle.");
        uint prefabId = resolve(prefab);
        if (prefabId == 0 || lastId == uint.MaxValue) throw new InvalidOperationException("Entity/catalog ID exhausted or invalid.");
        prepare?.Invoke(instance, prefab);
        var entity = new Entity { entityId = ++lastId, prefabId = prefabId, instance = instance, ready = ready };
        objects.Add(instance, entity); ids.Add(entity.entityId, entity);
        CrawlEntityLifetime lifetime = instance.GetComponent<CrawlEntityLifetime>();
        if (lifetime == null) lifetime = instance.AddComponent<CrawlEntityLifetime>();
        lifetime.registry = this;
        return entity;
    }
    public void FinalizeSpawn(GameObject instance)
    { Entity entity; if (instance != null && objects.TryGetValue(instance, out entity)) entity.ready = true; }
    public void Release(GameObject instance)
    {
        Entity entity;
        // Destroyed Unity objects compare equal to null but still have a key.
        if (ReferenceEquals(instance, null) || !objects.TryGetValue(instance, out entity)) return;
        objects.Remove(instance); ids.Remove(entity.entityId); Released?.Invoke(entity.entityId);
    }
    public uint FindId(GameObject instance)
    { Entity entity; return instance != null && objects.TryGetValue(instance, out entity) ? entity.entityId : 0; }
    public Entity Find(uint entityId) { Entity entity; return ids.TryGetValue(entityId, out entity) ? entity : null; }
    // Unity omits OnDestroy for some never-activated objects and edit-mode
    // objects. Reconcile before exporting any active set as a fallback.
    public void PruneDestroyed()
    {
        destroyed.Clear(); foreach (var pair in objects) if (pair.Key == null) destroyed.Add(pair.Key);
        foreach (GameObject instance in destroyed) Release(instance);
        destroyed.Clear();
    }
}
