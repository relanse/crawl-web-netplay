using System;
using System.Collections.Generic;
using System.Reflection;
using UnityEngine;

// ex2D queues mesh/clipping changes for a camera's OnPreRender. That callback
// also updates exCollisionHelper, so it is a simulation dependency, not just
// drawing. A null-graphics player has no camera render callback.
[DefaultExecutionOrder(30000)]
public sealed class CrawlHeadlessSpriteCommit : MonoBehaviour
{
    private static readonly MethodInfo CommitMethod = typeof(exSpriteMng).GetMethod("OnPreRender", BindingFlags.Instance | BindingFlags.NonPublic);
    private readonly Dictionary<exSpriteMng, Action> commits = new Dictionary<exSpriteMng, Action>();
    private readonly List<exSpriteMng> destroyed = new List<exSpriteMng>();
    public static CrawlHeadlessSpriteCommit Current { get; private set; }
    public uint CompletedFrames { get; private set; }
    public int ManagerCount { get; private set; }

    [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
    private static void Install()
    {
        if (!CrawlRuntimeMode.IsAuthority || Current != null) return;
        var host = new GameObject("CrawlHeadlessSpriteCommit"); host.layer = 17;
        DontDestroyOnLoad(host); Current = host.AddComponent<CrawlHeadlessSpriteCommit>();
    }
    public static Action BindManager(exSpriteMng manager)
    {
        if (manager == null || CommitMethod == null || CommitMethod.ReturnType != typeof(void) || CommitMethod.GetParameters().Length != 0)
            throw new InvalidOperationException("The pinned ex2D commit API is unavailable.");
        // Bind exactly this component, not GameObject.SendMessage: invoking all
        // OnPreRender methods on its camera would also run image effects.
        return (Action)Delegate.CreateDelegate(typeof(Action), manager, CommitMethod);
    }
    private void LateUpdate()
    {
        if (!CrawlRuntimeMode.IsAuthority) return;
        destroyed.Clear();
        foreach (var pair in commits) if (pair.Key == null) destroyed.Add(pair.Key);
        foreach (var manager in destroyed) commits.Remove(manager);
        // Camera managers can be created during a spawn, not only scene load.
        // Keep discovery correct first; profile before replacing it with hooks.
        var managers = FindObjectsOfType<exSpriteMng>(); ManagerCount = managers.Length;
        foreach (var manager in managers)
        {
            Action commit;
            if (!commits.TryGetValue(manager, out commit)) { commit = BindManager(manager); commits.Add(manager, commit); }
            commit();
        }
        if (CompletedFrames == uint.MaxValue) throw new InvalidOperationException("Headless commit clock exhausted.");
        CompletedFrames++;
    }
    private void OnDestroy() { if (Current == this) Current = null; }
}
