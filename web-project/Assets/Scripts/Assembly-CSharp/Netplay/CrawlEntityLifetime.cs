using System;
using UnityEngine;

public sealed class CrawlEntityLifetime : MonoBehaviour
{
    [NonSerialized] public CrawlEntityRegistry registry;
    private void OnDestroy() { registry?.Release(gameObject); }
}
