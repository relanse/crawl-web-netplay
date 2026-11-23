using System;
using System.IO;
using UnityEngine;

public static class CrawlInputBufferTests
{
    private static int checks;
    private static void Check(bool value, string message) { checks++; if (!value) throw new Exception(message); }
    private static CrawlInputSample Sample(uint sequence, uint tick, float x = 1)
    { return new CrawlInputSample { sequence = sequence, targetNetTick = tick, ownershipRevision = 1, controlledEntityId = 42, moveX = x }; }
    private static string Add(CrawlInputBuffer buffer, uint epoch, uint tick, double time, params CrawlInputSample[] values)
    { return buffer.Enqueue(epoch, tick, time, values, -100, -100, 100, 100); }
    public static void Run()
    {
        checks = 0;
        var buffer = new CrawlInputBuffer(); buffer.Bind(1, 1, 42, 100);
        var sample = Sample(1, 102); sample.actions = new[] { new CrawlDiscreteAction { actionId = 1, kind = 1 } };
        Check(Add(buffer, 1, 100, 0, sample) == null, "Valid input rejected");
        Check(buffer.ReceivedSequence == 1 && buffer.LastAppliedSequence == 0 && buffer.ClosedInputTick == 100, "Receive was mistaken for execution");
        Check(buffer.Close(101, .016, false).moveX == 0, "Input executed early");
        Check(buffer.Close(102, .033, false).pressedButtons == 1, "Input action missing");
        Check(buffer.Close(103, .05, false).pressedButtons == 0, "Action repeated without new input");
        Check(buffer.Close(116, .251, false).moveX == 0, "Timeout did not release movement");
        Check(Add(buffer, 1, 116, .3, Sample(2, 109)) == "INPUT_EXPIRED", "Input older than the late window was accepted");
        Check(Add(buffer, 1, 116, .3, Sample(2, 129)) == "INPUT_TOO_FAR_AHEAD", "Unbounded future input");
        var invalid = Sample(3, 119, float.NaN);
        Check(Add(buffer, 1, 116, .3, Sample(2, 118), invalid) == "INPUT_VALUE" && buffer.PendingCount == 0 && buffer.ReceivedSequence == 1, "Partial malformed batch committed");
        Check(Add(buffer, 1, 116, .3, Sample(2, 118)) == null, "Valid second sample rejected");
        Check(Add(buffer, 1, 116, .3, Sample(3, 118, -1)) == "INPUT_SLOT_CONFLICT", "Existing input overwritten");
        Check(buffer.Close(117, .31, true).moveX == 0 && buffer.PendingCount == 0, "Paused input retained");
        Check(buffer.Close(118, .32, false).moveX == 0, "Paused action replayed on resume");
        buffer.ChangeOwnership(2, 43);
        Check(Add(buffer, 1, 118, .33, Sample(3, 120)) == "OWNERSHIP_MISMATCH", "Old entity controlled");
        buffer.Bind(2, 2, 43, 118);
        Check(Add(buffer, 1, 118, .33, Sample(3, 120)) == "STALE_CONNECTION", "Old connection controlled replacement");
        var fresh = Sample(1, 120); fresh.ownershipRevision = 2; fresh.controlledEntityId = 43;
        Check(Add(buffer, 2, 118, .33, fresh) == null && buffer.Close(120, .35, false).moveX == 1, "Replacement did not work");
        bool wrapRejected = false; try { buffer.Bind(0, 2, 43, 120); } catch (ArgumentOutOfRangeException) { wrapRejected = true; }
        Check(wrapRejected, "Epoch silently wrapped");
        fresh.sequence = 2; fresh.targetNetTick = 122; fresh.pointerMode = 1; fresh.targetX = 101;
        Check(Add(buffer, 2, 120, .36, fresh) == "POINTER_OUT_OF_BOUNDS", "Unbounded pointer accepted");
        fresh.pointerMode = CrawlInputBuffer.ViewportPointer; fresh.targetX = 1.01f; fresh.targetY = .75f;
        Check(Add(buffer, 2, 120, .36, fresh) == "POINTER_OUT_OF_BOUNDS", "Out-of-canvas viewport pointer accepted");
        fresh.targetX = .25f;
        var viewport = new CrawlInputBuffer(); viewport.Bind(2, 2, 43, 120);
        Check(Add(viewport, 2, 120, .36, fresh) == null, "Valid viewport input rejected");
        var pointer = viewport.Close(122, .38, false);
        Check(pointer.pointerMode == CrawlInputBuffer.ViewportPointer && pointer.targetX == .25f && pointer.targetY == .75f,
            "Viewport position lost before application");
        fresh.pointerMode = 0; fresh.actions = new[] { new CrawlDiscreteAction { actionId = 1, kind = 1 } };
        Check(Add(buffer, 2, 120, .36, fresh) == null, "Valid edge rejected after invalid pointer batch");
        fresh.actions[0] = new CrawlDiscreteAction { actionId = 2, kind = 2 };
        Check(buffer.Close(122, .38, false).pressedButtons == 1, "Caller mutation changed accepted input");
        fresh.sequence = 3; fresh.targetNetTick = 124; fresh.actions[0] = new CrawlDiscreteAction { actionId = 1, kind = 1 };
        Check(Add(buffer, 2, 122, .39, fresh) == "ACTION_INVALID", "Replayed discrete action accepted");
        fresh.actions[0] = new CrawlDiscreteAction { actionId = 2, kind = 1 };
        Check(Add(buffer, 2, 122, .39, fresh) == null, "Fresh discrete action rejected");
        Check(buffer.Close(131, .55, false).pressedButtons == 0 && buffer.LastAppliedSequence == 2 && buffer.PendingCount == 0,
            "Skipped closed time slot replayed an expired action or falsely acknowledged it");
        bool closedRejected = false; try { buffer.Close(131, .56, false); } catch (InvalidOperationException) { closedRejected = true; }
        Check(closedRejected, "Same network slot was applied twice");
        var jitter = new CrawlInputBuffer(); jitter.Bind(1, 1, 42, 100);
        var lateMove = Sample(1, 101); lateMove.actions = new[] { new CrawlDiscreteAction { actionId = 1, kind = 1 } };
        var newestMove = Sample(2, 102, -1); newestMove.actions = new[] { new CrawlDiscreteAction { actionId = 2, kind = 2 } };
        Check(Add(jitter, 1, 104, .08, lateMove, newestMove) == null && jitter.PendingCount == 1 && jitter.RecoveredInputs == 2,
            "Slightly late ordered samples did not merge into one open slot");
        var recovered = jitter.Close(104, .09, false);
        Check(recovered.moveX == -1 && recovered.pressedButtons == 3 && jitter.LastAppliedSequence == 2 &&
            jitter.Close(105, .11, false).pressedButtons == 0, "Rebased movement or button edges were lost or replayed");
        Check(Add(jitter, 1, 106, .12, Sample(3, 106)) == null && jitter.Close(106, .13, false).moveX == 1,
            "An input arriving during an open tick was rejected");
        var ordered = new CrawlInputBuffer(); ordered.Bind(1, 1, 42, 100);
        lateMove.targetNetTick = newestMove.targetNetTick = 0;
        Check(Add(ordered, 1, 160, 1, lateMove, newestMove) == null && ordered.PendingCount == 1 && ordered.ExpiredInputs == 0,
            "Live input used an estimated client tick");
        var live = ordered.Close(160, 1.001, false);
        Check(live.moveX == -1 && live.pressedButtons == 3 && ordered.LastAppliedSequence == 2,
            "Live input burst did not keep the newest movement and both edges");
        Check(Add(ordered, 1, 160, 1.002, newestMove) == "INPUT_SEQUENCE", "Live input bypassed sequence validation");
        ordered.ChangeOwnership(2, 43);
        Check(Add(ordered, 1, 160, 1.003, Sample(3, 0)) == "OWNERSHIP_MISMATCH", "Live input bypassed ownership validation");
        var menuBuffer = new CrawlInputBuffer(); menuBuffer.Bind(1, 1, 0, 100);
        var menuInput = Sample(1, 102); menuInput.controlledEntityId = 0;
        Check(Add(menuBuffer, 1, 100, 0, menuInput) == "CONTROL_DISABLED", "No actor enabled gameplay input");
        menuBuffer.ChangeOwnership(2, 0, true); menuInput.ownershipRevision = 2;
        Check(Add(menuBuffer, 1, 100, 0, menuInput) == null && menuBuffer.Close(102, .033, false).moveX == 1, "Authority menu context failed");
        menuInput.sequence = 2; menuInput.targetNetTick = 104;
        menuInput.actions = new[] { new CrawlDiscreteAction { actionId = 1, kind = 2 } };
        Check(Add(menuBuffer, 1, 102, .035, menuInput) == null && menuBuffer.Close(105, .08, false).pressedButtons == 2 &&
            menuBuffer.Close(106, .10, false).pressedButtons == 0, "Menu back was lost or repeated when Update skipped a tick");
        menuBuffer.ChangeOwnership(3, 42);
        menuInput.sequence = 3; menuInput.targetNetTick = 108;
        Check(menuBuffer.Close(107, .12, false).moveX == 0 && Add(menuBuffer, 1, 107, .12, menuInput) == "OWNERSHIP_MISMATCH", "Menu input leaked into a new controlled actor");
        string root = System.Environment.GetEnvironmentVariable("CRAWL_TEST_OUTPUT");
        File.WriteAllText(Path.Combine(root, "input-tests.json"), "{\"passed\":true,\"checks\":" + checks + ",\"scope\":\"input scheduling, authority, edges, pause, timeout, bounds; not game-loop integration\"}");
        Debug.Log("Netplay input buffer tests passed.");
    }
}
