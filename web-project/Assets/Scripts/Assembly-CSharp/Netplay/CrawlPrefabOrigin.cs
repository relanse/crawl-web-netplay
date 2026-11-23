using UnityEngine;

// Runtime-only provenance, copied by Instantiate when the original game clones
// an existing room wall. Never uses the object's mutable name as an identity.
public sealed class CrawlPrefabOrigin : MonoBehaviour
{
    public uint prefabId;
    internal bool hierarchyStamped;
}
