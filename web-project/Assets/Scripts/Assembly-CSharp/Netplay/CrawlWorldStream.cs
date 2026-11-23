using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using Mirror;
using UnityEngine;

public struct CrawlWorldControl : NetworkMessage
{
    public CrawlBaselineBinding binding;
    public uint entity, revision;
}

// Each peer starts with a full frame. The reliable ordered stream can use
// deltas against its preceding frame even if rendering skips an update.
[DefaultExecutionOrder(31000)]
public sealed class CrawlWorldStream : MonoBehaviour
{
    private const int MaxFramesInFlight = 32;
    private const int MaxBytesInFlight = 256 * 1024;
    private const double CapturePeriod = .05;
    private sealed class Payload
    {
        public readonly byte[] bytes, hash;
        public Payload(byte[] bytes, SHA256 sha) { this.bytes = bytes; hash = sha.ComputeHash(bytes); }
    }
    private sealed class Frame { public uint id, baseId; public CrawlWorldFrame state; public byte[] raw; public Payload full, delta; }
    private sealed class Transmission { public Frame frame; public Payload payload; }
    private struct SentFrame
    {
        public CrawlBaselineBinding binding;
        public CrawlWorldFrame.Actor actor;
        public byte[] hash;
        public int bytes;
    }
    private sealed class Session
    {
        public MirrorCrawlTransport.Peer peer;
        public Transmission sending;
        public readonly Queue<SentFrame> awaiting = new Queue<SentFrame>();
        public int chunk, installed, awaitingBytes;
        public uint scene, applied, sent;
        public uint readyEntity, readyRevision;
        public double deadline, catchUpStarted;
        public bool CanStartFrame => sending == null && awaiting.Count < MaxFramesInFlight && awaitingBytes < MaxBytesInFlight;
    }
    private readonly Dictionary<int, Session> sessions = new Dictionary<int, Session>();
    private MirrorCrawlTransport transport;
    private string matchId, contentHash;
    private bool server, stopped;
    private uint lastFrame;
    private double nextCapture;
    private double lastCaptureAt, captureWindowAt, totalCaptureGap, peakCaptureGap;
    private double captureCost, encodeCost, packCost;
    private int captureGaps, longCaptureGaps;
    private Frame latest;
    private byte[] deltaScratch;
    private CrawlWorldCapture capture;
    private CrawlWorldReplica replica;
    private CrawlBaselineAssembler assembler;
    private CrawlBaselineBegin receiving;
    private CrawlBaselineBegin pendingFrame;
    private ArraySegment<byte> pendingBody, receivedBody;
    private byte[] receiveSpare;
    private double pendingPreparedAt;
    private uint receivedId;
    private CrawlServerHello identity;
    private uint installedId, clientScene;
    private double lastInstalledAt, peakInstallGap;
    private double lastReceivedAt, peakReceiveGap, peakPrepare, peakQueue, peakApply;
    public bool CanControl { get; private set; }
    public bool AllowControl { get; set; } = true;
    public bool HasInstalled(int slot)
    {
        var input = CrawlAuthorityInput.Current;
        return sessions.Values.Any(s => s.peer.slot == slot && s.installed >= 2 && s.scene == input.SceneEpoch &&
            s.readyEntity != 0 && s.readyEntity == input.GetSlot(slot).entityId && s.readyRevision == input.GetSlot(slot).revision);
    }
    public int InstalledFrames { get; private set; }
    public (int gap, int receive, int prepare, int queue, int apply, int hold) ReadAndResetSnapshotTiming()
    {
        var timing = (Milliseconds(peakInstallGap), Milliseconds(peakReceiveGap), Milliseconds(peakPrepare),
            Milliseconds(peakQueue), Milliseconds(peakApply), Milliseconds(replica.ReadAndResetPeakHold()));
        peakInstallGap = peakReceiveGap = peakPrepare = peakQueue = peakApply = 0;
        return timing;
    }
    private static int Milliseconds(double seconds) { return (int)Math.Round(seconds * 1000); }
    public int SpriteCount { get { return replica == null ? 0 : replica.SpriteCount; } }
    public CrawlWorldFrame ClientFrame { get { return replica == null ? null : replica.Current; } }
    public event Action Changed;
    public string Failure { get; private set; }

    public void InitializeServer(MirrorCrawlTransport network, string match, string hash)
    {
        transport = network; matchId = match; contentHash = hash; server = true; gameObject.layer = 17;
        capture = new CrawlWorldCapture(Resources.Load<CrawlVisualCatalog>("CrawlVisualCatalog"), hash);
        CrawlAuthorityInput.Current.RequireReplica = true;
        transport.PeerJoined += Joined; transport.PeerLeft += Left;
        NetworkServer.RegisterHandler<CrawlBaselineInstalled>(Installed);
    }
    private void Joined(MirrorCrawlTransport.Peer peer) { sessions.Add(peer.connection.connectionId, new Session { peer = peer }); }
    private void Left(MirrorCrawlTransport.Peer peer) { sessions.Remove(peer.connection.connectionId); }
    private CrawlBaselineBinding Binding(Session s, Frame f)
    { return new CrawlBaselineBinding { protocolVersion = 1, matchId = matchId, connectionEpoch = s.peer.connectionEpoch, sceneEpoch = f.state.sceneEpoch, baselineId = f.id }; }
    private void LateUpdate()
    {
        if (!server || stopped || sessions.Count == 0) return;
        try
        {
            double now = Time.realtimeSinceStartupAsDouble;
            if (now >= nextCapture && (latest == null || latest.state.sceneEpoch != CrawlAuthorityInput.Current.SceneEpoch ||
                sessions.Values.Any(s => s.CanStartFrame)))
            {
                nextCapture += CapturePeriod;
                if (nextCapture <= now) nextCapture = now + CapturePeriod;
                var state = capture.Capture();
                if (state != null)
                {
                    if (lastFrame == uint.MaxValue) throw new InvalidOperationException("World frame ID exhausted.");
                    double capturedAt = Time.realtimeSinceStartupAsDouble;
                    byte[] raw = CrawlWorldFrameCodec.Encode(state);
                    double encodedAt = Time.realtimeSinceStartupAsDouble;
                    var frame = new Frame { id = ++lastFrame, state = state, raw = raw };
                    using (var sha = SHA256.Create())
                    {
                        frame.full = new Payload(CrawlWorldCompression.Pack(raw), sha);
                        if (latest != null && latest.state.sceneEpoch == state.sceneEpoch)
                        {
                            byte[] delta = CrawlWorldCompression.PackDelta(raw, latest.id, latest.raw, ref deltaScratch);
                            if (delta.Length < frame.full.bytes.Length)
                            {
                                frame.baseId = latest.id;
                                frame.delta = new Payload(delta, sha);
                            }
                        }
                    }
                    latest = frame;
                    RecordCapture(now, AllowControl && !state.paused, capturedAt - now, encodedAt - capturedAt,
                        Time.realtimeSinceStartupAsDouble - encodedAt);
                }
            }
            if (latest == null) return;
            foreach (var s in sessions.Values.ToArray())
            {
                if (!transport.AcceptGameMessage(s.peer.connection)) continue;
                if (s.scene != latest.state.sceneEpoch)
                {
                    CrawlAuthorityInput.Current.SetReplicaReady(s.peer, false); s.scene = latest.state.sceneEpoch;
                    s.sending = null; s.awaiting.Clear(); s.awaitingBytes = 0; s.installed = 0; s.catchUpStarted = 0;
                }
                if (((s.sending != null || s.awaiting.Count > 0) && now >= s.deadline) || (s.installed == 1 && now - s.catchUpStarted > 5))
                { transport.Reject(s.peer.connection, "RESYNC_TIMEOUT"); continue; }
                if (s.CanStartFrame && latest.id > s.sent)
                {
                    Payload payload = latest.delta != null && s.sent == latest.baseId ? latest.delta : latest.full;
                    if (s.awaiting.Count != 0 && s.awaitingBytes + payload.bytes.Length > MaxBytesInFlight) continue;
                    if (s.installed == 1 && payload.bytes.Length > 2 * 1024 * 1024) { transport.Reject(s.peer.connection, "RESYNC_OVERFLOW"); continue; }
                    s.sending = new Transmission { frame = latest, payload = payload }; s.chunk = 0; s.sent = latest.id;
                    if (s.awaiting.Count == 0) s.deadline = now + 30;
                    s.peer.connection.Send(new CrawlBaselineBegin { binding = Binding(s, latest), totalBytes = payload.bytes.Length,
                        chunks = (ushort)((payload.bytes.Length + CrawlBaselineAssembler.ChunkBytes - 1) / CrawlBaselineAssembler.ChunkBytes), sha256 = payload.hash });
                }
                if (s.sending == null) continue;
                var sending = s.sending; var binding = Binding(s, sending.frame);
                byte[] bytes = sending.payload.bytes;
                for (int budget = 0; budget < 4 && s.chunk * CrawlBaselineAssembler.ChunkBytes < bytes.Length; budget++, s.chunk++)
                {
                    int offset = s.chunk * CrawlBaselineAssembler.ChunkBytes;
                    s.peer.connection.Send(new CrawlBaselineChunk { binding = binding, index = (ushort)s.chunk,
                        bytes = new ArraySegment<byte>(bytes, offset, Math.Min(CrawlBaselineAssembler.ChunkBytes, bytes.Length - offset)) });
                }
                if (s.chunk * CrawlBaselineAssembler.ChunkBytes >= bytes.Length)
                {
                    s.peer.connection.Send(new CrawlBaselineEnd { binding = binding, queuedAt = Time.realtimeSinceStartupAsDouble });
                    s.awaiting.Enqueue(new SentFrame { binding = binding, actor = sending.frame.state.actors[s.peer.slot], hash = sending.payload.hash, bytes = bytes.Length });
                    s.awaitingBytes += bytes.Length;
                    s.sending = null;
                }
            }
        }
        catch (Exception e)
        {
            stopped = true; Failure = e.Message; Debug.LogException(e);
            foreach (var s in sessions.Values.ToArray()) { CrawlAuthorityInput.Current.SetReplicaReady(s.peer, false); transport.Reject(s.peer.connection, "WORLD_CAPTURE_FAILED"); }
        }
    }
    private void RecordCapture(double now, bool playing, double captureTime, double encodeTime, double packTime)
    {
        if (!playing)
        {
            lastCaptureAt = captureWindowAt = totalCaptureGap = peakCaptureGap = 0;
            captureCost = encodeCost = packCost = 0;
            captureGaps = longCaptureGaps = 0;
            return;
        }
        if (lastCaptureAt > 0)
        {
            double gap = now - lastCaptureAt;
            captureGaps++;
            if (gap >= .08) longCaptureGaps++;
            totalCaptureGap += gap;
            peakCaptureGap = Math.Max(peakCaptureGap, gap);
            captureCost += captureTime; encodeCost += encodeTime; packCost += packTime;
        }
        lastCaptureAt = now;
        if (captureWindowAt == 0) captureWindowAt = now;
        if (now - captureWindowAt < 10 || captureGaps == 0) return;
        double msPerCapture = 1000.0 / captureGaps;
        Debug.Log($"[CrawlSync] captures={captureGaps} meanMs={Math.Round(msPerCapture * totalCaptureGap)} maxMs={Math.Round(1000 * peakCaptureGap)} gapsOver80Ms={longCaptureGaps} captureMs={msPerCapture * captureCost:F2} encodeMs={msPerCapture * encodeCost:F2} packMs={msPerCapture * packCost:F2}");
        captureWindowAt = now;
        totalCaptureGap = peakCaptureGap = 0;
        captureCost = encodeCost = packCost = 0;
        captureGaps = longCaptureGaps = 0;
    }
    private void Installed(NetworkConnectionToClient connection, CrawlBaselineInstalled message)
    {
        if (!transport.AcceptGameMessage(connection)) return;
        Session s;
        if (!sessions.TryGetValue(connection.connectionId, out s)) return;
        var sent = s.awaiting.FirstOrDefault(frame => frame.binding.baselineId == message.binding.baselineId);
        var expected = sent.binding;
        if (expected.baselineId == 0) return;
        if (message.binding.matchId != expected.matchId || message.binding.connectionEpoch != expected.connectionEpoch ||
            message.binding.sceneEpoch != expected.sceneEpoch || message.binding.baselineId != expected.baselineId) return;
        if (!message.sha256.SequenceEqual(sent.hash)) { transport.Reject(connection, "BASELINE_HASH"); return; }
        s.applied = expected.baselineId;
        while (s.awaiting.Count > 0 && s.awaiting.Peek().binding.baselineId <= s.applied)
            s.awaitingBytes -= s.awaiting.Dequeue().bytes;
        s.deadline = Time.realtimeSinceStartupAsDouble + 30; s.installed++;
        if (s.installed == 1) { s.catchUpStarted = Time.realtimeSinceStartupAsDouble; return; }
        var slot = CrawlAuthorityInput.Current.GetSlot(s.peer.slot); var actor = sent.actor;
        if (CrawlAuthorityInput.Current.SceneEpoch != expected.sceneEpoch || slot.entityId != actor.entity || slot.revision != actor.revision) return;
        s.readyEntity = actor.entity; s.readyRevision = actor.revision;
        if (!AllowControl || slot.replicaReady) return;
        CrawlAuthorityInput.Current.SetReplicaReady(s.peer, true);
        connection.Send(new CrawlWorldControl { binding = expected, entity = actor.entity, revision = actor.revision });
    }
    public void InitializeClient(MirrorCrawlTransport network, string match, string hash)
    {
        transport = network; matchId = match; contentHash = hash;
        replica = new CrawlWorldReplica(Resources.Load<CrawlVisualCatalog>("CrawlVisualCatalog"));
        transport.Authorized += hello => identity = hello;
        transport.ClientClosed += reason => { CanControl = false; pendingBody = receivedBody = default; receiveSpare = null; assembler?.Cancel(); Changed?.Invoke(); };
        NetworkClient.RegisterHandler<CrawlBaselineBegin>(Begin);
        NetworkClient.RegisterHandler<CrawlBaselineChunk>(Chunk);
        NetworkClient.RegisterHandler<CrawlBaselineEnd>(End);
        NetworkClient.RegisterHandler<CrawlWorldControl>(Control);
    }
    private void Begin(CrawlBaselineBegin message)
    {
        Guard(() => {
            var b = message.binding;
            if (b.matchId != matchId || b.connectionEpoch != identity.connectionEpoch) throw new InvalidDataException("BASELINE_BINDING");
            if (assembler == null) { assembler = new CrawlBaselineAssembler(matchId, b.connectionEpoch, b.sceneEpoch); clientScene = b.sceneEpoch; }
            if (b.sceneEpoch > clientScene)
            {
                CanControl = false; pendingBody = receivedBody = default; receivedId = 0;
                lastInstalledAt = lastReceivedAt = peakInstallGap = peakReceiveGap = peakPrepare = peakQueue = peakApply = 0;
                assembler.AdvanceScene(b.sceneEpoch); clientScene = b.sceneEpoch; Changed?.Invoke();
            }
            if (assembler.Begin(b.matchId, b.connectionEpoch, b.sceneEpoch, b.baselineId, message.totalBytes, message.chunks, message.sha256, Time.realtimeSinceStartupAsDouble)) receiving = message;
        });
    }
    private void Chunk(CrawlBaselineChunk message)
    {
        Guard(() => {
            if (assembler == null) throw new InvalidDataException("BASELINE_REQUIRED");
            var b = message.binding;
            assembler.Add(b.matchId, b.connectionEpoch, b.sceneEpoch, b.baselineId, message.index, message.bytes, Time.realtimeSinceStartupAsDouble);
        });
    }
    private void End(CrawlBaselineEnd message)
    {
        Guard(() => {
            var b = message.binding;
            if (b.matchId != matchId || b.connectionEpoch != identity.connectionEpoch) throw new InvalidDataException("BASELINE_BINDING");
            if (b.sceneEpoch != clientScene || b.baselineId != receiving.binding.baselineId || b.baselineId <= installedId) return;
            if (b.baselineId <= receivedId) return;
            double arrivedAt = Time.realtimeSinceStartupAsDouble;
            if (lastReceivedAt > 0) peakReceiveGap = Math.Max(peakReceiveGap, arrivedAt - lastReceivedAt);
            lastReceivedAt = arrivedAt;
            byte[] packet = assembler.TakeVerified(b.baselineId, arrivedAt);
            var body = CrawlWorldCompression.UnpackInto(packet, receivedId, receivedBody, ref receiveSpare);
            receiveSpare = receivedBody.Array;
            receivedId = b.baselineId; receivedBody = body;
            double preparedAt = Time.realtimeSinceStartupAsDouble;
            peakPrepare = Math.Max(peakPrepare, preparedAt - arrivedAt);
            // The initial synchronization installs each frame immediately.
            // During play only the newest complete state needs to draw this frame.
            if (CanControl) { pendingFrame = receiving; pendingBody = body; pendingPreparedAt = preparedAt; }
            else Install(receiving, body, preparedAt);
        });
    }
    private void Install(CrawlBaselineBegin frame, ArraySegment<byte> body, double preparedAt)
    {
        var b = frame.binding;
        double applyAt = Time.realtimeSinceStartupAsDouble;
        peakQueue = Math.Max(peakQueue, applyAt - preparedAt);
        var previous = replica.Current;
        var state = CrawlWorldFrameCodec.Decode(body, contentHash, previous);
        if (state.sceneEpoch != b.sceneEpoch) throw new InvalidDataException("WORLD_SCENE");
        var actor = state.actors[identity.slot];
        if (previous == null || previous.actors[identity.slot].revision != actor.revision) CanControl = false;
        replica.Apply(state); installedId = b.baselineId; InstalledFrames++;
        double now = Time.realtimeSinceStartupAsDouble;
        peakApply = Math.Max(peakApply, now - applyAt);
        if (lastInstalledAt > 0) peakInstallGap = Math.Max(peakInstallGap, now - lastInstalledAt);
        lastInstalledAt = now;
        NetworkClient.Send(new CrawlBaselineInstalled { binding = b, sha256 = frame.sha256 }); Changed?.Invoke();
    }
    private void Control(CrawlWorldControl message)
    {
        var b = message.binding;
        // A later complete frame may arrive before this grant. It is safe only
        // when that installed frame still has the exact granted ownership.
        if (b.matchId != matchId || b.connectionEpoch != identity.connectionEpoch || b.sceneEpoch != clientScene || b.baselineId > installedId || replica.Current == null) return;
        var actor = replica.Current.actors[identity.slot];
        if (actor.entity != message.entity || actor.revision != message.revision) return;
        if (!CanControl) { CanControl = true; Changed?.Invoke(); }
    }
    private void Update()
    {
        if (server || stopped || assembler == null) return;
        Guard(() => {
            assembler.Expire(Time.realtimeSinceStartupAsDouble);
            if (pendingBody.Array == null) return;
            var body = pendingBody;
            pendingBody = default;
            Install(pendingFrame, body, pendingPreparedAt);
        });
    }
    private void Guard(Action action)
    {
        if (stopped) return;
        try { action(); }
        catch (Exception e) { stopped = true; Failure = e.Message; CanControl = false; pendingBody = receivedBody = default; receiveSpare = null; assembler?.Cancel(); replica?.Dispose(); Debug.LogException(e); NetworkClient.Disconnect(); Changed?.Invoke(); }
    }
    private void OnDestroy() { replica?.Dispose(); assembler?.Cancel(); if (server && transport != null) { transport.PeerJoined -= Joined; transport.PeerLeft -= Left; } }
    public bool PresentMovement(int slot, Vector2 intent, bool mouse, out Vector2 position)
    {
        position = Vector2.zero;
        return replica != null && replica.PresentMovement(slot, intent, mouse, CanControl,
            Time.realtimeSinceStartupAsDouble, Time.unscaledDeltaTime, out position);
    }
}
