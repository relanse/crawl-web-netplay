using System;
using System.IO;
using UnityEngine;

public enum CrawlRunMode { Offline, LegacyStream, NetworkClient, AuthorityServer }

public static class CrawlRuntimeMode
{
#if CRAWL_AUTHORITY || UNITY_SERVER
    public static CrawlRunMode Current { get; private set; } = CrawlRunMode.AuthorityServer;
#elif CRAWL_NETWORK_CLIENT || CRAWL_TRANSPORT_PROBE
    public static CrawlRunMode Current { get; private set; } = CrawlRunMode.NetworkClient;
#else
    public static CrawlRunMode Current { get; private set; } = CrawlRunMode.Offline;
#endif
    public static bool IsAuthority { get { return Current == CrawlRunMode.AuthorityServer; } }
    public static void EnableLegacyStream()
    {
        if (IsAuthority) return;
        if (Current != CrawlRunMode.Offline && Current != CrawlRunMode.LegacyStream)
            throw new InvalidOperationException("A network client cannot become a streaming host.");
        Current = CrawlRunMode.LegacyStream;
    }
    public static string ServerDataDirectory
    {
        get
        {
            string directory = System.Environment.GetEnvironmentVariable("CRAWL_SERVER_DATA");
            if (string.IsNullOrWhiteSpace(directory) || !Path.IsPathRooted(directory))
                throw new InvalidOperationException("CRAWL_SERVER_DATA must be an explicit absolute directory.");
            return Path.GetFullPath(directory);
        }
    }
    // A batch-mode player has no render boundary. Keep original waits in normal play.
    public static object RenderBoundary { get { return IsAuthority ? null : (object)new WaitForEndOfFrame(); } }
}
