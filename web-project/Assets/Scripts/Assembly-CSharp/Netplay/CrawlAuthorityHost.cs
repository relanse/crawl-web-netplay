#if CRAWL_GAME_SERVER && (CRAWL_AUTHORITY || UNITY_SERVER)
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEngine;
using UnityEngine.SceneManagement;

// Production match lifetime. Test command channels and the 180-second probe
// deadline are not compiled into this build.
public sealed class CrawlAuthorityHost : MonoBehaviour
{
    [Serializable] private class Member { public string playerId, tag; public int slot, deity; }
    [Serializable] private class Roster { public int revision; public Member[] players; }
    [Serializable] private class Command { public uint id; public bool stop; public string[] revokePlayerIds; }
    [Serializable] private class PeerStatus { public string playerId; public int slot; public uint epoch, recoveredInputs, expiredInputs; public bool connected, installed; }
    [Serializable] private class Actor { public int slot; public float x, y, health; public bool hero, bot; public string state; }
    [Serializable] private class SlotResult { public int slot, level, xp, heroKills, monsterKills; public bool abandoned; }
    [Serializable] private class MatchResult
    {
        public bool completed, bossDefeated;
        public int winnerSlot, durationSeconds;
        public SlotResult[] players;
    }
    [Serializable] private class Status
    {
        public uint sequence;
        public string matchId, processLeaseId, contentHash, phase, scene;
        public int exceptions;
        public PeerStatus[] players;
        public Actor[] actors;
        public MatchResult result;
    }
    private static CrawlAuthorityHost current;
    private string directory, matchId, leaseId, hash;
    private Roster roster;
    private MatchResult result;
    private bool synchronized, requestedStart, held, running, ended;
    private uint sequence, commandId;
    private double nextReport, nextCommand, startedAt;
    private int exceptions;
    private readonly Dictionary<string, uint> epochs = new Dictionary<string, uint>();
    private readonly HashSet<string> abandoned = new HashSet<string>();
    [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
    private static void Install()
    {
        var host = new GameObject("CrawlAuthorityHost"); host.layer = 17; DontDestroyOnLoad(host); host.AddComponent<CrawlAuthorityHost>();
    }
    private void Awake()
    {
        Application.logMessageReceived += Logged;
        directory = CrawlRuntimeMode.ServerDataDirectory; Directory.CreateDirectory(directory);
        string file = System.Environment.GetEnvironmentVariable("CRAWL_ROSTER_FILE");
        if (string.IsNullOrEmpty(file) || !Path.IsPathRooted(file) || Path.GetDirectoryName(Path.GetFullPath(file)) != directory || new FileInfo(file).Length > 8192)
            throw new InvalidOperationException("A roster inside the isolated match directory is required.");
        roster = JsonUtility.FromJson<Roster>(File.ReadAllText(file));
        if (roster == null || roster.players == null || roster.players.Length < 2 || roster.players.Length > 4 ||
            roster.players.Any(p => p.slot < 0 || p.slot > 3 || p.playerId == null || p.playerId.Length != 32) ||
            roster.players.Select(p => p.slot).Distinct().Count() != roster.players.Length) throw new InvalidDataException("Invalid match roster.");
        foreach (var player in roster.players) epochs.Add(player.playerId, 0);
        var catalog = Resources.Load<CrawlPrefabCatalog>("CrawlNetplayCatalog"); CrawlEntityRegistry.Install(catalog); hash = catalog.contentHash;
        matchId = System.Environment.GetEnvironmentVariable("CRAWL_MATCH_ID"); leaseId = System.Environment.GetEnvironmentVariable("CRAWL_PROCESS_LEASE");
        Application.targetFrameRate = 60; QualitySettings.vSyncCount = 0; Application.runInBackground = true;
        current = this;
    }
    private void Logged(string text, string trace, LogType type) { if (type == LogType.Error || type == LogType.Exception) exceptions++; }
    private void Update()
    {
        var session = CrawlGameSession.Current;
        if (!string.IsNullOrEmpty(session?.World?.Failure))
        {
            // The supervisor unlocks the lobby when the failed match exits.
            Application.Quit(1);
            return;
        }
        if (!synchronized)
        {
            var input = FindObjectOfType<CrawlRemoteInput>();
            if (input != null)
            {
                input.Enable(""); input.GetComponent<CrawlWebLobby>().SetLobby(JsonUtility.ToJson(new CrawlWebLobby.Snapshot {
                    revision = 1, players = roster.players.Select(p => new CrawlWebLobby.Member {
                        slot = p.slot, playerId = p.playerId, tag = p.tag, deity = p.deity, ready = true, connected = true
                    }).ToArray() }));
                synchronized = true;
            }
        }
        if (!requestedStart && CrawlWebLobby.Ready)
        { FindObjectOfType<CrawlWebLobby>().StartMatch("1"); requestedStart = CrawlWebLobby.Starting; }
        bool inGame = SceneManager.GetActiveScene().name == "SceneGame";
        if (!running && inGame && Singleton<SystemLevel>.HasInstance() && SystemLevel.GetCurrentRoom() != null)
        {
            if (!held) { SystemTime.PauseGame(); held = true; }
            if (session != null && session.World != null && roster.players.All(p => session.World.HasInstalled(p.slot)))
            {
                SystemTime.UnPauseGame(); held = false; running = true;
                startedAt = Time.realtimeSinceStartupAsDouble; session.World.AllowControl = true;
            }
        }
        if (running && SceneManager.GetActiveScene().name == "SceneMenuMain") ended = true;
        double now = Time.realtimeSinceStartupAsDouble;
        if (now >= nextCommand)
        {
            nextCommand = now + .25;
            try
            {
                string file = Path.Combine(directory, "host-command.json");
                if (File.Exists(file))
                {
                    var command = JsonUtility.FromJson<Command>(File.ReadAllText(file));
                    if (command != null && command.id > commandId)
                    {
                        commandId = command.id;
                        if (command.stop) { Report(); Application.Quit(0); return; }
                        if (command.revokePlayerIds != null)
                            foreach (string id in command.revokePlayerIds)
                            {
                                var member = roster.players.FirstOrDefault(p => p.playerId == id);
                                if (member == null || !abandoned.Add(id)) continue;
                                if (Singleton<SystemPlayers>.HasInstance()) Singleton<SystemPlayers>.Get.DropOut(member.slot);
                                if (session != null) foreach (var peer in session.Transport.Peers.Where(p => p.playerId == id).ToArray())
                                { CrawlAuthorityInput.Current.SetReplicaReady(peer, false); session.Transport.Reject(peer.connection, "MATCH_ABANDONED"); }
                            }
                    }
                }
            }
            catch (IOException) { } // Atomic replacement can briefly lock a file on Windows.
        }
        if (now >= nextReport) { nextReport = now + .5; Report(); }
    }
    public static void RecordCompletion(bool bossDefeated)
    {
        if (current != null && current.running && current.result == null) current.CaptureResult(bossDefeated);
    }

    private void CaptureResult(bool bossDefeated)
    {
        var completed = new MatchResult {
            completed = true, bossDefeated = bossDefeated, winnerSlot = -1,
            durationSeconds = Mathf.FloorToInt((float)(Time.realtimeSinceStartupAsDouble - startedAt)),
            players = new SlotResult[roster.players.Length]
        };
        for (int i = 0; i < roster.players.Length; i++)
        {
            var member = roster.players[i];
            var player = SystemPlayers.GetPlayer(member.slot);
            var row = new SlotResult { slot = member.slot, abandoned = abandoned.Contains(member.playerId) || player == null || !player.IsHuman };
            if (!row.abandoned)
            {
                var stats = player.StatsGame;
                row.level = Mathf.RoundToInt(player.Level);
                row.xp = Mathf.FloorToInt(stats.GetStat(PlayerStats.eStat.XPEarned));
                row.heroKills = Mathf.RoundToInt(stats.GetStat(PlayerStats.eStat.KillsHero));
                row.monsterKills = Mathf.RoundToInt(stats.GetStat(PlayerStats.eStat.KillsMonster));
                if (bossDefeated && player.IsHero) completed.winnerSlot = member.slot;
            }
            completed.players[i] = row;
        }
        result = completed;
    }

    private void Report()
    {
        var session = CrawlGameSession.Current;
        var peers = session == null ? new MirrorCrawlTransport.Peer[0] : session.Transport.Peers.ToArray();
        foreach (var peer in peers) epochs[peer.playerId] = peer.connectionEpoch;
        var status = new Status { sequence = ++sequence, matchId = matchId, processLeaseId = leaseId, contentHash = hash,
            phase = ended ? "Results" : running ? "Running" : "Loading", scene = SceneManager.GetActiveScene().name, exceptions = exceptions,
            players = roster.players.Select(p => {
                var buffer = CrawlAuthorityInput.Current?.GetSlot(p.slot).buffer;
                return new PeerStatus { playerId = p.playerId, slot = p.slot, epoch = epochs[p.playerId],
                    connected = peers.Any(peer => peer.playerId == p.playerId), installed = session != null && session.World != null && session.World.HasInstalled(p.slot),
                    recoveredInputs = buffer?.RecoveredInputs ?? 0, expiredInputs = buffer?.ExpiredInputs ?? 0 };
            }).ToArray(),
            actors = new Actor[4], result = result };
        for (int i = 0; i < 4; i++)
        {
            var a = status.actors[i] = new Actor { slot = i };
            if (!Singleton<SystemPlayers>.HasInstance()) continue;
            var data = SystemPlayers.GetPlayer(i); if (data == null || data.GameObject == null) continue;
            a.x = data.GameObject.transform.position.x; a.y = data.GameObject.transform.position.y; a.hero = data.IsHero; a.bot = data.IsBot;
            var health = data.GameObject.GetComponent<Health>(); if (health != null) a.health = health.GetHealthCurrent();
            var player = data.GameObject.GetComponent<Player>(); if (player != null) a.state = player.GetState().ToString();
        }
        string target = Path.Combine(directory, "host-status.json"), temporary = target + ".tmp";
        File.WriteAllText(temporary, JsonUtility.ToJson(status));
        if (File.Exists(target)) File.Replace(temporary, target, null); else File.Move(temporary, target);
    }
    private void OnDestroy()
    {
        if (current == this) current = null;
        Application.logMessageReceived -= Logged;
        CrawlEntityRegistry.Uninstall();
    }
}
#endif
