using System;
using System.Collections.Generic;
using System.Linq;
using UnityEngine;

// The authority records audio lifetimes without asking the OS to play sound.
// Audio uses its own random generator, so cosmetic choices cannot alter combat.
public sealed class CrawlAudioCapture : MonoBehaviour
{
    private sealed class Playing { public uint id; public AudioSource source; public Transform emitter; public bool hadEmitter, music; public double start; public float end; }
    private static CrawlAudioCapture current;
    private readonly List<Playing> playing = new List<Playing>();
    private readonly System.Random random = new System.Random();
    private uint sequence;
    private AudioSource music;
    private CrawlVisualCatalog assets;
    private static CrawlAudioCapture Get
    {
        get
        {
            if (current == null) { var host = new GameObject("Authority audio events"); host.layer = 17; DontDestroyOnLoad(host); current = host.AddComponent<CrawlAudioCapture>(); current.assets = Resources.Load<CrawlVisualCatalog>("CrawlVisualCatalog"); }
            return current;
        }
    }
    public static bool MusicPlaying { get { return current != null && current.music != null; } }
    private float Range(MinMaxRange value) { return Mathf.Lerp(value.Min, value.Max, (float)random.NextDouble()); }
    public static AudioSource PlayCue(AudioCue cue, Transform emitter, float fromTime, bool isMusic = false)
    {
        if (cue == null || cue.m_sounds == null || cue.m_sounds.Count == 0) return null;
        var self = Get;
        if (self.random.NextDouble() > cue.m_chance) return null;
        float total = cue.m_sounds.Sum(c => Mathf.Max(0, c.m_weight)), choice = (float)self.random.NextDouble() * total;
        AudioCue.Clip selected = cue.m_sounds[0];
        foreach (var candidate in cue.m_sounds) { selected = candidate; choice -= Mathf.Max(0, candidate.m_weight); if (choice <= 0) break; }
        if (selected.m_sound == null) return null;
        double now = Time.realtimeSinceStartupAsDouble;
        float interval = cue.m_noDuplicateTime >= 0 ? cue.m_noDuplicateTime : .05f;
        if (!isMusic && self.playing.Any(p => p.source != null && p.source.clip == selected.m_sound && now - p.start < interval)) return null;
        var source = self.Add(selected.m_sound, emitter, selected.m_loop, self.Range(cue.m_volume) * self.Range(selected.m_volume), self.Range(selected.m_pitch),
            Mathf.Max(fromTime, selected.m_startTime), self.Range(cue.m_startDelay), selected.m_endTime, isMusic);
        if (cue.m_alsoPlay != null && cue.m_alsoPlay != cue) PlayCue(cue.m_alsoPlay, emitter, fromTime);
        return source;
    }
    public static AudioSource PlayClip(AudioClip clip, Transform emitter, bool loop, float volume, float pitch)
    { return clip == null ? null : Get.Add(clip, emitter, loop, volume, pitch, 0, 0, 0, false); }
    private AudioSource Add(AudioClip clip, Transform emitter, bool loop, float volume, float pitch, float offset, float delay, float end, bool isMusic)
    {
        Prune();
        if (playing.Count >= 128) Stop(playing.FirstOrDefault(p => !p.music)?.source);
        var host = new GameObject("Audio event"); host.transform.SetParent(transform, false); host.layer = 17;
        var source = host.AddComponent<AudioSource>(); source.playOnAwake = false; source.clip = clip; source.loop = loop;
        source.volume = Mathf.Clamp01(volume); source.pitch = Mathf.Clamp(pitch, .05f, 3);
        if (emitter != null) source.transform.position = emitter.position;
        playing.Add(new Playing { id = ++sequence, source = source, emitter = emitter, hadEmitter = emitter != null, music = isMusic,
            start = Time.realtimeSinceStartupAsDouble + Mathf.Max(0, delay) - offset / source.pitch, end = end > 0 ? end : clip.length });
        if (isMusic) music = source;
        return source;
    }
    public static AudioSource PlayMusic(AudioCue cue, bool synced)
    {
        float offset = 0;
        if (synced && MusicPlaying) { var old = Get.playing.Find(p => p.source == Get.music); if (old != null) offset = (float)(Time.realtimeSinceStartupAsDouble - old.start) * old.source.pitch; }
        StopMusic(); return PlayCue(cue, null, offset, true);
    }
    public static void StopMusic() { if (current != null) Stop(current.music); }
    public static void Stop(AudioSource source)
    {
        if (current == null || source == null) return;
        current.playing.RemoveAll(p => p.source == source); if (current.music == source) current.music = null;
        Destroy(source.gameObject);
    }
    public static void StopEffects() { if (current != null) foreach (var p in current.playing.Where(p => !p.music).ToArray()) Stop(p.source); }
    private void Prune()
    {
        double now = Time.realtimeSinceStartupAsDouble;
        foreach (var p in playing.ToArray())
        {
            if (p.source == null) { playing.Remove(p); continue; }
            if ((!p.source.loop && (now - p.start) * p.source.pitch >= p.end) || (p.source.loop && p.hadEmitter && p.emitter == null)) Stop(p.source);
        }
    }
    private void Update() { Prune(); }
    public static CrawlWorldFrame.AudioState[] Capture()
    {
        if (current == null) return new CrawlWorldFrame.AudioState[0];
        current.Prune(); double now = Time.realtimeSinceStartupAsDouble;
        return current.playing.Where(p => now >= p.start).Select(p => new CrawlWorldFrame.AudioState { id = p.id, clip = current.assets.AudioId(p.source.clip),
            offset = (float)(now - p.start) * p.source.pitch, volume = p.source.volume, pitch = p.source.pitch, loop = p.source.loop, music = p.music }).ToArray();
    }
}

public sealed class CrawlAudioReplica : IDisposable
{
    private readonly CrawlVisualCatalog assets;
    private readonly GameObject host;
    private readonly Dictionary<uint, AudioSource> sources = new Dictionary<uint, AudioSource>();
    public int Count { get { return sources.Count; } }
    public CrawlAudioReplica(CrawlVisualCatalog catalog) { assets = catalog; host = new GameObject("Replica audio"); host.AddComponent<AudioListener>(); }
    public void Apply(CrawlWorldFrame.AudioState[] states)
    {
        var active = new HashSet<uint>();
        foreach (var state in states)
        {
            active.Add(state.id); AudioSource source;
            if (!sources.TryGetValue(state.id, out source))
            {
                source = host.AddComponent<AudioSource>(); source.playOnAwake = false; source.clip = assets.Audio(state.clip); source.loop = state.loop;
                source.volume = state.volume * (state.music ? .45f : 1); source.pitch = state.pitch;
                if (source.clip.length > 0) source.time = state.loop ? state.offset % source.clip.length : Mathf.Min(state.offset, Mathf.Max(0, source.clip.length - .01f));
                source.Play(); CrawlVoiceSubtitles.Track(source); sources.Add(state.id, source);
            }
            source.volume = state.volume * (state.music ? .45f : 1); source.pitch = state.pitch;
        }
        foreach (uint id in sources.Keys.Where(id => !active.Contains(id)).ToArray()) { sources[id].Stop(); Release(sources[id]); sources.Remove(id); }
    }
    private static void Release(UnityEngine.Object value) { if (Application.isPlaying) UnityEngine.Object.Destroy(value); else UnityEngine.Object.DestroyImmediate(value); }
    public void Dispose() { foreach (var source in sources.Values) { source.Stop(); Release(source); } sources.Clear(); Release(host); }
}
