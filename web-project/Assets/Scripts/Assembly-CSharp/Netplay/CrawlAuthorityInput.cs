using System;
using Mirror;
using UnityEngine;
using UnityEngine.SceneManagement;

// Mirror collects packets in EarlyUpdate. Movement is installed before each
// original physics step; discrete edges are presented once to gameplay Update.
// Unity still owns physics; this component never simulates it.
[DefaultExecutionOrder(-10000)]
public sealed class CrawlAuthorityInput : MonoBehaviour
{
    public static CrawlAuthorityInput Current { get; private set; }
    public sealed class Slot
    {
        public uint entityId, revision = 1, batch;
        public MirrorCrawlTransport.Peer peer;
        public CrawlInputBuffer buffer;
        public double rateWindow;
        public int packets;
        public CrawlAppliedInput current;
        public byte pendingEdges;
        public uint deliveredEdges;
        public bool replicaReady;
        public bool menu;
    }
    private readonly Slot[] slots = { new Slot(), new Slot(), new Slot(), new Slot() };
    private MirrorCrawlTransport transport;
    private string matchId;
    private double origin;
    private double frameUnscaledTime, frameScaledTime;
    private float frameTimeScale;
    private uint consumedTick;
    private int physicsSteps;
    public int MaxPhysicsStepsPerFrame { get; private set; }
    public uint NetTick { get; private set; }
    public uint SimTick { get; private set; }
    public uint SceneEpoch { get; private set; } = 1;
    public uint CommittedInputTick { get; private set; }
    public bool RequireReplica { get; set; }
    public void SetReplicaReady(MirrorCrawlTransport.Peer peer, bool ready)
    {
        Slot slot = slots[peer.slot]; if (!ReferenceEquals(slot.peer, peer)) return;
        slot.replicaReady = ready;
        if (!ready) { slot.buffer?.Clear(); slot.current = default(CrawlAppliedInput); slot.pendingEdges = 0; CrawlRemoteInput.SetNetworkState(peer.slot, default(CrawlAppliedInput)); }
    }
    public Slot GetSlot(int slot) { return slots[slot]; }
    public void PrepareStatus() { RefreshClock(); RefreshOwnership(); }
    public void Initialize(MirrorCrawlTransport network, string match)
    {
        if (!CrawlRuntimeMode.IsAuthority || Current != null) throw new InvalidOperationException("Authority input already installed or wrong mode.");
        Current = this; transport = network; matchId = match; origin = Time.unscaledTimeAsDouble;
        gameObject.layer = 17; transport.PeerJoined += Joined; transport.PeerLeft += Left;
        SceneManager.sceneLoaded += SceneLoaded;
        NetworkServer.RegisterHandler<CrawlInputBatch>(Receive);
        NetworkLoop.OnEarlyUpdate += Early; NetworkLoop.OnLateUpdate += Commit;
    }
    private void SceneLoaded(Scene scene, LoadSceneMode mode)
    {
        if (SceneEpoch == uint.MaxValue) throw new InvalidOperationException("Scene epoch exhausted.");
        SceneEpoch++; foreach (var slot in slots) { slot.replicaReady = false; slot.buffer?.Clear(); slot.current = default(CrawlAppliedInput); slot.pendingEdges = 0; }
    }
    private void Joined(MirrorCrawlTransport.Peer peer)
    {
        RefreshClock(); RefreshOwnership();
        Slot slot = slots[peer.slot]; slot.peer = peer; slot.batch = 0; slot.packets = 0; slot.replicaReady = false;
        slot.current = default(CrawlAppliedInput); slot.pendingEdges = 0;
        slot.buffer = new CrawlInputBuffer(); slot.buffer.Bind(peer.connectionEpoch, slot.revision, slot.entityId, NetTick, slot.menu);
    }
    private void Left(MirrorCrawlTransport.Peer peer)
    {
        Slot slot = slots[peer.slot]; if (!ReferenceEquals(slot.peer, peer)) return;
        slot.peer = null; slot.buffer?.Clear(); slot.buffer = null;
        slot.current = default(CrawlAppliedInput); slot.pendingEdges = 0;
        CrawlRemoteInput.SetNetworkState(peer.slot, default(CrawlAppliedInput));
    }
    private void RefreshClock()
    {
        // Unity caches this unscaled clock at frame start. Using a different
        // realtime reading for each packet would shift a slot midway through
        // the same frame. Timeout measurement still uses realtime below.
        double tick = Math.Floor((Time.unscaledTimeAsDouble - origin) * 60 + .00001);
        if (tick >= uint.MaxValue) throw new InvalidOperationException("Network clock exhausted.");
        NetTick = (uint)Math.Max(0, tick);
    }
    private void RefreshOwnership()
    {
        string scene = SceneManager.GetActiveScene().name;
        bool sceneMenu = scene.StartsWith("SceneMenu", StringComparison.Ordinal) && scene != "SceneMenuMain";
        int modalPlayer = -1;
        bool modalMenu = SystemTime.Paused && Singleton<SystemMenu>.HasInstance() && Singleton<SystemMenu>.Get.TryGetPausedInputOwner(out modalPlayer);
        for (int i = 0; i < slots.Length; i++)
        {
            bool menu = modalMenu ? modalPlayer < 0 || modalPlayer == i : sceneMenu;
            PlayerData player = Singleton<SystemPlayers>.HasInstance() ? SystemPlayers.GetPlayer(i) : null;
            uint id = player != null && CrawlEntityRegistry.Current != null ? CrawlEntityRegistry.Current.FindId(player.GameObject) : 0;
            Slot slot = slots[i]; if (id == slot.entityId && menu == slot.menu) continue;
            if (slot.revision == uint.MaxValue) throw new InvalidOperationException("Ownership revision exhausted.");
            slot.entityId = id; slot.menu = menu; slot.revision++; slot.replicaReady = false; slot.buffer?.ChangeOwnership(slot.revision, id, menu);
            slot.current = default(CrawlAppliedInput); slot.pendingEdges = 0;
            CrawlRemoteInput.SetNetworkState(i, default(CrawlAppliedInput));
        }
    }
    private void Receive(NetworkConnectionToClient connection, CrawlInputBatch batch)
    {
        var peer = connection.authenticationData as MirrorCrawlTransport.Peer;
        if (!transport.AcceptGameMessage(connection)) return;
        RefreshClock(); RefreshOwnership(); Slot slot = slots[peer.slot];
        if (RequireReplica && !slot.replicaReady) { connection.Send(new CrawlInputRejected { batchSequence = batch.batchSequence, code = "BASELINE_REQUIRED" }); return; }
        double now = Time.realtimeSinceStartupAsDouble;
        if (now - slot.rateWindow >= 1) { slot.rateWindow = now; slot.packets = 0; }
        if (++slot.packets > 120) { connection.Disconnect(); return; }
        string error = null;
        if (batch.protocolVersion != MirrorCrawlTransport.ProtocolVersion || batch.matchId != matchId) error = "MATCH_MISMATCH";
        else if (batch.sceneEpoch != SceneEpoch) error = "SCENE_MISMATCH";
        else if (batch.batchSequence == 0 || batch.batchSequence <= slot.batch) error = "INPUT_SEQUENCE";
        else
        {
            // Pointer limits are a bounded envelope around the current logical
            // room; the pointer selects an aim target, never an actor position.
            Room room = Singleton<SystemLevel>.HasInstance() ? SystemLevel.GetCurrentRoom() : null;
            Vector2 center = room == null ? Vector2.zero : (Vector2)room.transform.position;
            error = slot.buffer.Enqueue(batch.connectionEpoch, NetTick, now, batch.samples, center.x - 512, center.y - 512, center.x + 512, center.y + 512);
        }
        if (error != null) connection.Send(new CrawlInputRejected { batchSequence = batch.batchSequence, code = error });
        else slot.batch = batch.batchSequence;
    }
    private void Early()
    {
        RefreshClock(); RefreshOwnership();
        frameUnscaledTime = Time.unscaledTimeAsDouble; frameScaledTime = Time.timeAsDouble; frameTimeScale = Time.timeScale;
        physicsSteps = 0;
        if (!SystemTime.Paused) return;
        for (int i = 0; i < slots.Length; i++)
        {
            Slot slot = slots[i];
            slot.current = slot.buffer != null && NetTick > slot.buffer.ClosedInputTick
                ? slot.buffer.Close(NetTick, Time.realtimeSinceStartupAsDouble, !slot.menu) : default(CrawlAppliedInput);
            slot.pendingEdges = slot.current.pressedButtons;
            CrawlRemoteInput.SetNetworkState(i, slot.current);
        }
        consumedTick = NetTick;
    }
    private void FixedUpdate()
    {
        if (Current != this || SystemTime.Paused) return;
        physicsSteps++; MaxPhysicsStepsPerFrame = Math.Max(MaxPhysicsStepsPerFrame, physicsSteps);
        // Map this automatic physics step to its unscaled input slot. The
        // scaled frame remainder tells us how many catch-up steps still follow.
        // Using absolute fixedTime alone drifts after Unity caps a long stall.
        double remaining = frameTimeScale > 0 ? Math.Max(0, frameScaledTime - Time.fixedTimeAsDouble) / frameTimeScale : 0;
        double target = Math.Floor((frameUnscaledTime - origin - remaining) * 60 + .00001);
        uint tick = (uint)Math.Max(0, Math.Min(NetTick, target));
        for (int i = 0; i < slots.Length; i++)
        {
            Slot slot = slots[i];
            if (slot.buffer != null && tick > slot.buffer.ClosedInputTick)
            {
                slot.current = slot.buffer.Close(tick, Time.realtimeSinceStartupAsDouble, false);
                slot.pendingEdges |= slot.current.pressedButtons;
            }
            var movement = slot.current; movement.pressedButtons = 0;
            CrawlRemoteInput.SetNetworkState(i, movement);
        }
        consumedTick = Math.Max(consumedTick, tick);
        if (Singleton<SystemInput>.HasInstance()) Singleton<SystemInput>.Get.InstallNetworkPhysicsAxes();
        if (SimTick == uint.MaxValue) throw new InvalidOperationException("Simulation clock exhausted.");
        SimTick++;
    }
    private void Update()
    {
        if (Current != this) return;
        for (int i = 0; i < slots.Length; i++)
        {
            Slot slot = slots[i]; var gameplay = slot.current;
            gameplay.pressedButtons = slot.pendingEdges; slot.pendingEdges = 0;
            for (byte kind = 1; kind <= 2; kind++) if ((gameplay.pressedButtons & kind) != 0) slot.deliveredEdges++;
            CrawlRemoteInput.SetNetworkState(i, gameplay);
        }
        if (Singleton<SystemInput>.HasInstance()) Singleton<SystemInput>.Get.RefreshNetworkInput();
    }
    private void Commit() { CommittedInputTick = consumedTick; }
    private void OnDestroy()
    {
        if (Current != this) return;
        NetworkLoop.OnEarlyUpdate -= Early; NetworkLoop.OnLateUpdate -= Commit;
        SceneManager.sceneLoaded -= SceneLoaded;
        transport.PeerJoined -= Joined; transport.PeerLeft -= Left;
        for (int i = 0; i < slots.Length; i++) CrawlRemoteInput.SetNetworkState(i, default(CrawlAppliedInput));
        Current = null;
    }
}
