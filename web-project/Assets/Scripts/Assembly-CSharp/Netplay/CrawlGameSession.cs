#if CRAWL_TRANSPORT_PROBE || CRAWL_NETWORK_CLIENT || CRAWL_GAME_SERVER
using System;
using System.Runtime.InteropServices;
using Mirror;
using UnityEngine;

// Shared authority/client network session. The browser UI supplies only input
// intent; all world state and control grants come from the authority.
public struct CrawlProbePing : NetworkMessage { public uint sequence; }
public struct CrawlProbeFrame : NetworkMessage
{
    public uint sequence;
    public float uptime, x0, y0, x1, y1;
    public bool hero0, hero1;
    public uint entityId, ownershipRevision, sceneEpoch, netTick, committedInputTick, receivedInput, appliedInput;
}
public sealed class CrawlGameSession : MonoBehaviour
{
    public static CrawlGameSession Current { get; private set; }
    public MirrorCrawlTransport Transport { get { return transport; } }
    public CrawlWorldStream World { get { return world; } }
    [Serializable] private class Config { public string endpoint, releaseId, contentHash, matchId, ticket; public bool attemptEarlyInput; }
    [Serializable] private class Status
    {
        public bool authenticated, canControl, earlyInputRefused, menu, paused;
        public int worldFrames, worldSprites, worldRooms, worldEntities;
        public int worldTexts, worldCameras, worldAudio;
        public int renderFps, syncFps, snapshotGapMs;
        public int snapshotReceiveGapMs, snapshotPrepareMs, snapshotQueueMs, snapshotApplyMs, presentationHoldMs;
        public string worldError;
        public int worldActorSprites0, worldActorSprites1;
        public float worldX0, worldY0, worldX1, worldY1, roundTripMs;
        public float displayedX, displayedY;
        public int slot, frames;
        public uint epoch, sent, received;
        public uint entityId, ownershipRevision, sceneEpoch, netTick, committedInputTick, receivedInput, appliedInput, inputBatches, rejectedInputs;
        public string lastRejection;
        public string playerId, error;
        public float x0, y0, x1, y1;
    }
    private MirrorCrawlTransport transport;
    private CrawlWorldStream world;
    private Status status = new Status();
    private float nextSend;
    [Serializable] private class ProbeInput { public float x, y, px, py; public int buttons; public bool mouse; }
    private ProbeInput desired = new ProbeInput();
    private string matchId;
    private uint inputSequence, actionSequence, lastTarget;
    private byte previousButtons;
    private byte latchedButtons;
    private float nextInput, clockReceivedAt;
    private readonly float[] pingSentAt = new float[32];
    private readonly uint[] pingSequences = new uint[32];
    private float roundTrip;
    private double clockAnchor;
    private uint EstimateTick() { return (uint)Math.Max(0, Math.Floor(clockAnchor + (Time.realtimeSinceStartup - clockReceivedAt) * 60)); }
    // This lead is measured at send time. MaxLead in the authority buffer
    // still limits how far ahead an input may be when it actually arrives.
    private const uint MaxInputLead = 60;
    private uint InputLead { get { return (uint)Mathf.Clamp(Mathf.CeilToInt(roundTrip * 30) + 3, 3, (int)MaxInputLead); } }
    private bool suppressInput;
#if CRAWL_NETWORK_CLIENT
    private ProbeInput lastSentInput;
    private float nextInputKeepalive;
    private double nextReport, rateSampleAt;
    private int rateFrame, rateSnapshot;
    private bool lastReportedAuth;
    private string lastReportedError;
#endif
    // Test-only seam: stop packet production without closing the socket, so the
    // authority's input timeout can be checked independently of disconnects.
    public void SetInput(string json)
    {
        if (world == null || !world.CanControl) { desired = new ProbeInput(); latchedButtons = 0; return; }
        var next = JsonUtility.FromJson<ProbeInput>(json) ?? new ProbeInput();
        latchedButtons |= (byte)((next.buttons & 3) & ~desired.buttons); desired = next;
    }
    public void SetProbeInput(string json) { SetInput(json); }
#if CRAWL_NETWORK_CLIENT
    [UnityEngine.Scripting.Preserve]
    public void SetVolume(string percentage)
    {
        if (int.TryParse(percentage, out int value)) AudioListener.volume = Mathf.Clamp(value, 0, 100) / 100f;
    }

    [UnityEngine.Scripting.Preserve]
    public void SetRenderFrameRate(string setting)
    {
        if (!int.TryParse(setting, out int fps) || (fps != -1 && (fps < 30 || fps > 180))) return;
        QualitySettings.vSyncCount = fps == -1 ? 1 : 0;
        Application.targetFrameRate = fps;
    }
#endif
    public void SetProbeInputEnabled(string value) { suppressInput = value == "0"; }
    public void SendProbeTap(string unused)
    {
        if (!status.authenticated || status.entityId == 0) return;
        uint estimated = EstimateTick();
        uint target = Math.Max(lastTarget + 1, estimated + Math.Max(8u, InputLead));
        var samples = new CrawlInputSample[2];
        for (int i = 0; i < 2; i++) samples[i] = new CrawlInputSample { sequence = ++inputSequence,
            targetNetTick = target + (uint)i, controlledEntityId = status.entityId, ownershipRevision = status.ownershipRevision,
            heldButtons = (byte)(i == 0 ? 1 : 0), actions = i == 0 ? new[] { new CrawlDiscreteAction { actionId = ++actionSequence, kind = 1 } } : null };
        NetworkClient.Send(new CrawlInputBatch { protocolVersion = MirrorCrawlTransport.ProtocolVersion, matchId = matchId,
            sceneEpoch = status.sceneEpoch, connectionEpoch = status.epoch, batchSequence = ++status.inputBatches, samples = samples });
        lastTarget = target + 1;
    }
    [Serializable] private class InvalidInput { public string kind; public uint entityId; }
    public void SendProbeInvalid(string json)
    {
        if (!status.authenticated || status.entityId == 0) return;
        var invalid = JsonUtility.FromJson<InvalidInput>(json);
        uint estimated = EstimateTick();
        var sample = new CrawlInputSample { sequence = ++inputSequence, targetNetTick = Math.Max(lastTarget + 1, estimated + InputLead),
            controlledEntityId = status.entityId, ownershipRevision = status.ownershipRevision, moveX = 1 };
        uint epoch = status.epoch;
        switch (invalid.kind)
        {
            case "entity": sample.controlledEntityId = invalid.entityId; break;
            case "epoch": epoch++; break;
            case "nan": sample.moveX = float.NaN; break;
            case "buttons": sample.heldButtons = 4; break;
            case "expired": sample.targetNetTick = status.netTick > CrawlInputBuffer.LateGraceTicks + 1
                ? status.netTick - CrawlInputBuffer.LateGraceTicks - 1 : 1; break;
            case "future": sample.targetNetTick = estimated + 100; break;
            default: throw new ArgumentException("Unknown negative test.");
        }
        NetworkClient.Send(new CrawlInputBatch { protocolVersion = MirrorCrawlTransport.ProtocolVersion, matchId = matchId,
            sceneEpoch = status.sceneEpoch, connectionEpoch = epoch, batchSequence = ++status.inputBatches, samples = new[] { sample } });
    }
#if UNITY_WEBGL && !UNITY_EDITOR
    [DllImport("__Internal")] private static extern void CrawlTransportProbeReport(string json);
#endif
    [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
    private static void Install()
    {
        var obj = new GameObject("CrawlGameSession");obj.layer = 17;
        DontDestroyOnLoad(obj);obj.AddComponent<CrawlGameSession>();
    }
    private void Awake()
    {
        Current = this; Application.runInBackground = true;
        transport = gameObject.AddComponent<MirrorCrawlTransport>();
#if CRAWL_AUTHORITY || UNITY_SERVER
        string port = System.Environment.GetEnvironmentVariable("CRAWL_GAME_PORT");
        if (string.IsNullOrEmpty(port)) return; // Native-only feasibility test still works.
        string builtHash = BuiltContentHash();
        if (Env("CRAWL_CONTENT_HASH") != builtHash) throw new InvalidOperationException("Configured content hash does not match the native build.");
        var redemption = new CrawlTicketRedemption(Env("CRAWL_CONTROL_URL"), Env("CRAWL_CONTROL_SECRET"),
            Env("CRAWL_ROOM_ID"), Env("CRAWL_MATCH_ID"), Env("CRAWL_PROCESS_LEASE"), Env("CRAWL_RELEASE_ID"));
        transport.StartServer(ushort.Parse(port), Env("CRAWL_RELEASE_ID"), builtHash, Env("CRAWL_MATCH_ID"), redemption.Redeem);
        var input = gameObject.AddComponent<CrawlAuthorityInput>(); input.Initialize(transport, Env("CRAWL_MATCH_ID"));
        world = gameObject.AddComponent<CrawlWorldStream>(); world.InitializeServer(transport, Env("CRAWL_MATCH_ID"), builtHash);
#if CRAWL_GAME_SERVER
        world.AllowControl = false;
#endif
        NetworkServer.RegisterHandler<CrawlProbePing>((connection, ping) => {
            var peer = connection.authenticationData as MirrorCrawlTransport.Peer;
            if (!transport.AcceptGameMessage(connection)) return;
            // Handlers run before OnEarlyUpdate. At 20 fps, replying with the
            // preceding frame's clock underestimates server time by 3 ticks.
            input.PrepareStatus();
            var frame = new CrawlProbeFrame { sequence = ping.sequence, uptime = Time.realtimeSinceStartup };
            var slot = input.GetSlot(peer.slot);
            frame.entityId = slot.entityId; frame.ownershipRevision = slot.revision; frame.sceneEpoch = input.SceneEpoch;
            frame.netTick = input.NetTick; frame.committedInputTick = input.CommittedInputTick;
            frame.receivedInput = slot.buffer == null ? 0 : slot.buffer.ReceivedSequence;
            frame.appliedInput = slot.buffer == null ? 0 : slot.buffer.LastAppliedSequence;
            if (Singleton<SystemPlayers>.HasInstance())
            {
                PlayerData a = SystemPlayers.GetPlayer(0), b = SystemPlayers.GetPlayer(1);
                if (a != null && a.GameObject != null) { frame.x0 = a.GameObject.transform.position.x; frame.y0 = a.GameObject.transform.position.y; frame.hero0 = a.IsHero; }
                if (b != null && b.GameObject != null) { frame.x1 = b.GameObject.transform.position.x; frame.y1 = b.GameObject.transform.position.y; frame.hero1 = b.IsHero; }
            }
            connection.Send(frame);
        });
#endif
    }
    private static string Env(string name) { return System.Environment.GetEnvironmentVariable(name); }
    private static string BuiltContentHash()
    {
        var catalog = Resources.Load<CrawlPrefabCatalog>("CrawlNetplayCatalog");
        if (catalog == null || string.IsNullOrEmpty(catalog.contentHash)) throw new InvalidOperationException("Build is missing its generated content catalog.");
        return catalog.contentHash;
    }
    public void Configure(string json)
    {
#if !CRAWL_AUTHORITY && !UNITY_SERVER
        try
        {
            Config config = JsonUtility.FromJson<Config>(json);
            string builtHash = BuiltContentHash();
            if (config.contentHash != builtHash) { status.error = "VERSION_MISMATCH"; Report(); return; }
            matchId = config.matchId;
            transport.Authorized += hello => {
                status.authenticated = true; status.slot = hello.slot; status.playerId = hello.playerId; status.epoch = hello.connectionEpoch;
                clockReceivedAt = Time.realtimeSinceStartup;
                if (config.attemptEarlyInput) NetworkClient.Send(new CrawlInputBatch { protocolVersion = 1, matchId = matchId,
                    sceneEpoch = 1, connectionEpoch = hello.connectionEpoch, batchSequence = ++status.inputBatches,
                    samples = new[] { new CrawlInputSample { sequence = ++inputSequence, targetNetTick = 1, moveX = 1 } } });
                Report();
            };
            transport.ClientClosed += reason => { status.error = reason; status.authenticated = false; Report(); };
            NetworkClient.RegisterHandler<CrawlProbeFrame>(frame => {
                if (frame.sequence <= status.received) return;
                status.received = frame.sequence; status.frames++; status.x0 = frame.x0; status.y0 = frame.y0; status.x1 = frame.x1; status.y1 = frame.y1;
                if (status.entityId != frame.entityId || status.ownershipRevision != frame.ownershipRevision || status.sceneEpoch != frame.sceneEpoch)
                { previousButtons = 0; lastTarget = 0; }
                status.entityId = frame.entityId; status.ownershipRevision = frame.ownershipRevision; status.sceneEpoch = frame.sceneEpoch;
                status.netTick = frame.netTick; status.committedInputTick = frame.committedInputTick;
                status.receivedInput = frame.receivedInput; status.appliedInput = frame.appliedInput; clockReceivedAt = Time.realtimeSinceStartup;
                int pingIndex = (int)(frame.sequence % 32);
                if (pingSequences[pingIndex] == frame.sequence) roundTrip = Mathf.Clamp(clockReceivedAt - pingSentAt[pingIndex], 0, 2f);
                clockAnchor = frame.netTick + roundTrip * 30; status.roundTripMs = roundTrip * 1000;
                Report();
            });
            NetworkClient.RegisterHandler<CrawlInputRejected>(error => { status.rejectedInputs++; status.lastRejection = error.code; if (error.code == "BASELINE_REQUIRED") status.earlyInputRefused = true; Report(); });
            world = gameObject.AddComponent<CrawlWorldStream>(); world.InitializeClient(transport, config.matchId, builtHash);
            world.Changed += () => { if (!world.CanControl) { desired = new ProbeInput(); latchedButtons = 0; previousButtons = 0; } Report(); };
            transport.StartClient(config.endpoint, config.releaseId, builtHash, config.matchId, config.ticket);
        }
        catch (Exception error) { status.error = error.GetType().Name; Debug.LogError(status.error + "\n" + error.StackTrace); Report(); }
#endif
    }
    private void Update()
    {
        if (!status.authenticated) return;
        float now = Time.realtimeSinceStartup;
        if (now - clockReceivedAt > 5) { status.authenticated = false; desired = new ProbeInput(); NetworkClient.Disconnect(); return; }
        if (now >= nextSend)
        {
            nextSend = now + .1f;
            uint sequence = ++status.sent; int index = (int)(sequence % 32); pingSentAt[index] = now; pingSequences[index] = sequence;
            NetworkClient.Send(new CrawlProbePing { sequence = sequence });
        }
        if (world == null || !world.CanControl || suppressInput || (status.entityId == 0 && !world.ClientFrame.actors[status.slot].menu) || now < nextInput) return;
        if (inputSequence > uint.MaxValue - 8 || actionSequence > uint.MaxValue - 2 || status.inputBatches == uint.MaxValue || status.netTick > uint.MaxValue - 128)
        { status.error = "INPUT_SEQUENCE_EXHAUSTED"; status.authenticated = false; NetworkClient.Disconnect(); Report(); return; }
        nextInput = now + 1f / 60f;
#if CRAWL_NETWORK_CLIENT
        // The authority assigns the next open tick. Client RTT is diagnostic
        // and does not decide whether a fresh movement or click is valid.
        uint target = 0;
#else
        if (now - clockReceivedAt > .5f) return;
        uint estimated = EstimateTick();
        uint target = Math.Max(lastTarget + 1, estimated + InputLead);
        if (target > estimated + Math.Min(InputLead + 4, MaxInputLead)) return;
#endif
        byte buttons = (byte)(desired.buttons & 3);
        byte rising = (byte)(latchedButtons | (buttons & ~previousButtons));
#if CRAWL_NETWORK_CLIENT
        var sent = lastSentInput;
        if (sent != null && now < nextInputKeepalive && rising == 0 && buttons == previousButtons &&
            desired.x == sent.x && desired.y == sent.y && desired.mouse == sent.mouse &&
            (!desired.mouse || (desired.px == sent.px && desired.py == sent.py))) return;
        lastSentInput = desired;
        nextInputKeepalive = now + .05f;
#endif
        var edges = new System.Collections.Generic.List<CrawlDiscreteAction>();
        for (byte kind = 1; kind <= 2; kind++) if ((rising & kind) != 0)
            edges.Add(new CrawlDiscreteAction { actionId = ++actionSequence, kind = kind });
        var samples = new CrawlInputSample[1];
        for (int i = 0; i < samples.Length; i++) samples[i] = new CrawlInputSample {
            sequence = ++inputSequence, targetNetTick = target + (uint)i, ownershipRevision = status.ownershipRevision,
            controlledEntityId = status.entityId, moveX = Mathf.Clamp(desired.x, -1, 1), moveY = Mathf.Clamp(desired.y, -1, 1),
            targetX = desired.px, targetY = desired.py, pointerMode = desired.mouse ? CrawlInputBuffer.ViewportPointer : (byte)0,
            heldButtons = buttons, actions = i == 0 ? edges.ToArray() : null
        };
        NetworkClient.Send(new CrawlInputBatch { protocolVersion = MirrorCrawlTransport.ProtocolVersion, matchId = matchId,
            sceneEpoch = status.sceneEpoch, connectionEpoch = status.epoch, batchSequence = ++status.inputBatches, samples = samples });
        previousButtons = buttons; latchedButtons = 0; lastTarget = target;
    }
    private void Report()
    {
#if CRAWL_NETWORK_CLIENT
        double now = Time.realtimeSinceStartupAsDouble;
        if (now < nextReport && status.authenticated == lastReportedAuth && status.error == lastReportedError &&
            (world?.CanControl ?? false) == status.canControl && world?.Failure == status.worldError) return;
        nextReport = now + .1;
        lastReportedAuth = status.authenticated;
        lastReportedError = status.error;
        if (world != null && (rateSampleAt == 0 || now - rateSampleAt >= 1))
        {
            int frameCount = Time.frameCount;
            int snapshots = world.InstalledFrames;
            var timing = world.ReadAndResetSnapshotTiming();
            status.snapshotGapMs = timing.gap;
            status.snapshotReceiveGapMs = timing.receive;
            status.snapshotPrepareMs = timing.prepare;
            status.snapshotQueueMs = timing.queue;
            status.snapshotApplyMs = timing.apply;
            status.presentationHoldMs = timing.hold;
            if (rateSampleAt > 0)
            {
                double elapsed = now - rateSampleAt;
                status.renderFps = (int)Math.Round((frameCount - rateFrame) / elapsed);
                status.syncFps = (int)Math.Round((snapshots - rateSnapshot) / elapsed);
            }
            rateFrame = frameCount; rateSnapshot = snapshots; rateSampleAt = now;
        }
#endif
        if (world != null)
        {
            status.canControl = world.CanControl; status.worldFrames = world.InstalledFrames; status.worldSprites = world.SpriteCount; status.worldError = world.Failure;
            if (world.ClientFrame != null)
            {
                var frame = world.ClientFrame; status.worldRooms = frame.rooms.Length; status.worldEntities = frame.entities.Length;
                status.worldTexts = frame.texts.Length; status.worldCameras = frame.cameras.Length; status.worldAudio = frame.audio.Length;
                status.menu = frame.actors[status.slot].menu;
                status.paused = frame.paused;
                status.worldActorSprites0 = 0; status.worldActorSprites1 = 0;
                foreach (var sprite in frame.sprites) { if (sprite.entity == frame.actors[0].entity) status.worldActorSprites0++; if (sprite.entity == frame.actors[1].entity) status.worldActorSprites1++; }
                foreach (var entity in frame.entities)
                {
                    if (entity.id == frame.actors[0].entity) { status.worldX0 = entity.position.x; status.worldY0 = entity.position.y; }
                    if (entity.id == frame.actors[1].entity) { status.worldX1 = entity.position.x; status.worldY1 = entity.position.y; }
                }
            }
        }
#if UNITY_WEBGL && !UNITY_EDITOR
        CrawlTransportProbeReport(JsonUtility.ToJson(status));
#endif
    }
    private void LateUpdate()
    {
        Vector2 position;
        Vector2 intent = desired.mouse ? new Vector2(desired.px, desired.py) : new Vector2(desired.x, desired.y);
        if (world == null || !status.authenticated || !world.PresentMovement(status.slot, intent, desired.mouse, out position)) return;
        if (position.x == status.displayedX && position.y == status.displayedY) return;
        status.displayedX = position.x; status.displayedY = position.y;
        Report();
    }
}
#endif
