using System;
using System.Collections.Generic;

[Serializable] public struct CrawlDiscreteAction
{
    public uint actionId;
    public byte kind; // Action=1, Alt=2; no global pause button.
}

[Serializable] public struct CrawlInputSample
{
    public uint sequence, targetNetTick, ownershipRevision, controlledEntityId; // Tick 0 schedules live intent on arrival.
    public float moveX, moveY, targetX, targetY;
    public byte heldButtons, pointerMode;
    public CrawlDiscreteAction[] actions;
}

public struct CrawlAppliedInput
{
    public uint sequence, closedInputTick;
    public float moveX, moveY, targetX, targetY;
    public byte heldButtons, pressedButtons, pointerMode;
}

// One buffer per authenticated player/connection. Pure code: packet arrival does
// not advance game time, and acknowledgments never pretend received==executed.
public sealed class CrawlInputBuffer
{
    public const uint MaxLead = 12;
    public const uint LateGraceTicks = 6;
    public const double TimeoutSeconds = .250;
    private readonly SortedList<uint, (CrawlInputSample state, byte pressed)> pending = new SortedList<uint, (CrawlInputSample, byte)>(12);
    private uint epoch, ownershipRevision, entityId, lastTarget, lastAction;
    private bool menuContext;
    private double lastReceived = double.NegativeInfinity;
    private CrawlAppliedInput held;
    public uint ReceivedSequence { get; private set; }
    public uint LastAppliedSequence { get; private set; }
    public uint ClosedInputTick { get; private set; }
    public uint RecoveredInputs { get; private set; }
    public uint ExpiredInputs { get; private set; }
    public int PendingCount { get { return pending.Count; } }
    public uint ConnectionEpoch { get { return epoch; } }

    public void Bind(uint connectionEpoch, uint revision, uint controlledEntityId, uint currentTick, bool menu = false)
    {
        if (connectionEpoch == 0 || connectionEpoch <= epoch || revision == 0) throw new ArgumentOutOfRangeException();
        epoch = connectionEpoch; ownershipRevision = revision; entityId = controlledEntityId; menuContext = menu;
        ReceivedSequence = LastAppliedSequence = lastAction = RecoveredInputs = ExpiredInputs = 0;
        ClosedInputTick = currentTick; lastTarget = 0; Clear();
    }
    public void ChangeOwnership(uint revision, uint controlledEntityId, bool menu = false)
    {
        if (revision <= ownershipRevision || revision == 0) throw new ArgumentOutOfRangeException();
        ownershipRevision = revision; entityId = controlledEntityId; menuContext = menu; Clear();
        lastTarget = 0;
    }
    public void Clear()
    { pending.Clear(); held = default(CrawlAppliedInput); lastReceived = double.NegativeInfinity; }
    private static bool Finite(float value) { return !float.IsNaN(value) && !float.IsInfinity(value); }
    public const byte WorldPointer = 1;
    public const byte ViewportPointer = 2;

    // Reject an entire malformed batch before any mutation. The caller already
    // verified matchId, sceneEpoch and the authenticated transport binding.
    public string Enqueue(uint connectionEpoch, uint serverTick, double now, CrawlInputSample[] samples,
        float pointerMinX, float pointerMinY, float pointerMaxX, float pointerMaxY)
    {
        if (connectionEpoch != epoch || epoch == 0) return "STALE_CONNECTION";
        if (samples == null || samples.Length < 1 || samples.Length > 8) return "INPUT_LIMIT";
        uint seq = ReceivedSequence, target = lastTarget, action = lastAction;
        ulong firstOpen = Math.Max((ulong)serverTick, (ulong)ClosedInputTick + 1);
        if (firstOpen > uint.MaxValue) return "INPUT_EXPIRED";
        bool scheduleOnReceipt = samples[0].targetNetTick == 0;
        uint previousDue = 0;
        int actionCount = 0, entries = pending.Count;
        foreach (var sample in samples)
        {
            if (sample.sequence == 0 || sample.sequence <= seq) return "INPUT_SEQUENCE";
            if ((sample.targetNetTick == 0) != scheduleOnReceipt) return "INPUT_VALUE";
            if (!scheduleOnReceipt)
            {
                if (firstOpen > (ulong)sample.targetNetTick + LateGraceTicks) { ExpiredInputs++; return "INPUT_EXPIRED"; }
                if ((ulong)sample.targetNetTick > (ulong)serverTick + MaxLead) return "INPUT_TOO_FAR_AHEAD";
                if (sample.targetNetTick <= target) return "INPUT_SLOT_CONFLICT";
                target = sample.targetNetTick;
            }
            if (sample.ownershipRevision != ownershipRevision || sample.controlledEntityId != entityId) return "OWNERSHIP_MISMATCH";
            if (!Finite(sample.moveX) || !Finite(sample.moveY) || Math.Abs(sample.moveX) > 1 || Math.Abs(sample.moveY) > 1 ||
                !Finite(sample.targetX) || !Finite(sample.targetY) || sample.pointerMode > ViewportPointer || sample.heldButtons > 3) return "INPUT_VALUE";
            if (sample.pointerMode == WorldPointer && (sample.targetX < pointerMinX || sample.targetX > pointerMaxX ||
                sample.targetY < pointerMinY || sample.targetY > pointerMaxY)) return "POINTER_OUT_OF_BOUNDS";
            if (sample.pointerMode == ViewportPointer && (sample.targetX < 0 || sample.targetX > 1 ||
                sample.targetY < 0 || sample.targetY > 1)) return "POINTER_OUT_OF_BOUNDS";
            if (entityId == 0 && !menuContext && (sample.moveX != 0 || sample.moveY != 0 || sample.heldButtons != 0 || sample.pointerMode != 0 ||
                (sample.actions != null && sample.actions.Length != 0))) return "CONTROL_DISABLED";
            if (sample.actions != null)
            {
                if (sample.actions.Length > 2 || (actionCount += sample.actions.Length) > 16) return "INPUT_LIMIT";
                int seenKinds = 0;
                foreach (var edge in sample.actions)
                {
                    if (edge.actionId == 0 || edge.actionId <= action || (edge.kind != 1 && edge.kind != 2) || (seenKinds & edge.kind) != 0) return "ACTION_INVALID";
                    seenKinds |= edge.kind; action = edge.actionId;
                }
            }
            uint due = Math.Max(sample.targetNetTick, (uint)firstOpen);
            if (due != previousDue && !pending.ContainsKey(due)) entries++;
            previousDue = due;
            seq = sample.sequence;
        }
        if (entries > MaxLead) return "INPUT_LIMIT";
        foreach (var sample in samples)
        {
            // Never roll back a closed physics tick. Late samples in the same
            // open slot keep the newest axes and merge distinct button edges.
            uint due = Math.Max(sample.targetNetTick, (uint)firstOpen);
            if (!scheduleOnReceipt && due != sample.targetNetTick) RecoveredInputs++;
            byte pressed = pending.TryGetValue(due, out var prior) ? prior.pressed : (byte)0;
            if (sample.actions != null) foreach (var edge in sample.actions) pressed |= edge.kind;
            var owned = sample;
            owned.actions = null;
            pending[due] = (owned, pressed);
        }
        ReceivedSequence = seq; lastTarget = target; lastAction = action; lastReceived = now;
        return null;
    }
    public CrawlAppliedInput Close(uint tick, double now, bool paused)
    {
        if (tick <= ClosedInputTick) throw new InvalidOperationException("Input clock must advance without wrapping.");
        ClosedInputTick = tick; held.pressedButtons = 0;
        bool timedOut = now - lastReceived >= TimeoutSeconds;
        if (paused || timedOut)
        {
            held = default(CrawlAppliedInput);
            if (paused) pending.Clear(); // Paused attacks must not burst after resume.
        }
        while (pending.Count > 0 && pending.Keys[0] <= tick)
        {
            uint due = pending.Keys[0];
            var (sample, pressed) = pending.Values[0];
            pending.RemoveAt(0);
            if (timedOut || tick - due > LateGraceTicks) continue;
            held.sequence = sample.sequence; LastAppliedSequence = sample.sequence;
            held.moveX = sample.moveX; held.moveY = sample.moveY;
            held.targetX = sample.targetX; held.targetY = sample.targetY;
            held.pointerMode = sample.pointerMode; held.heldButtons = sample.heldButtons;
            held.pressedButtons |= pressed;
        }
        held.closedInputTick = tick;
        return held;
    }
}
