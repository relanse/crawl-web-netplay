using System.IO;
using Mirror;

public struct CrawlInputBatch : NetworkMessage
{
    public ushort protocolVersion;
    public string matchId;
    public uint sceneEpoch, connectionEpoch, batchSequence;
    public CrawlInputSample[] samples;
}
public struct CrawlInputRejected : NetworkMessage { public uint batchSequence; public string code; }

// Explicit count checks happen BEFORE allocating arrays. Mirror discovers these
// writer/reader extensions through its Weaver.
public static class CrawlInputWire
{
    public static void WriteCrawlInputBatch(this NetworkWriter writer, CrawlInputBatch batch)
    {
        if (batch.samples == null || batch.samples.Length < 1 || batch.samples.Length > 8) throw new InvalidDataException("INPUT_LIMIT");
        writer.WriteUShort(batch.protocolVersion); writer.WriteString(batch.matchId);
        writer.WriteUInt(batch.sceneEpoch); writer.WriteUInt(batch.connectionEpoch); writer.WriteUInt(batch.batchSequence);
        writer.WriteByte((byte)batch.samples.Length);
        foreach (var sample in batch.samples)
        {
            writer.WriteUInt(sample.sequence); writer.WriteUInt(sample.targetNetTick);
            writer.WriteUInt(sample.ownershipRevision); writer.WriteUInt(sample.controlledEntityId);
            writer.WriteFloat(sample.moveX); writer.WriteFloat(sample.moveY); writer.WriteFloat(sample.targetX); writer.WriteFloat(sample.targetY);
            writer.WriteByte(sample.heldButtons); writer.WriteByte(sample.pointerMode);
            int count = sample.actions == null ? 0 : sample.actions.Length;
            if (count > 2) throw new InvalidDataException("INPUT_LIMIT");
            writer.WriteByte((byte)count);
            if (sample.actions != null) foreach (var edge in sample.actions) { writer.WriteUInt(edge.actionId); writer.WriteByte(edge.kind); }
        }
    }
    public static CrawlInputBatch ReadCrawlInputBatch(this NetworkReader reader)
    {
        var batch = new CrawlInputBatch { protocolVersion = reader.ReadUShort(), matchId = reader.ReadString(),
            sceneEpoch = reader.ReadUInt(), connectionEpoch = reader.ReadUInt(), batchSequence = reader.ReadUInt() };
        if (batch.matchId == null || batch.matchId.Length != 32) throw new InvalidDataException("INVALID_MATCH");
        int count = reader.ReadByte(); if (count < 1 || count > 8) throw new InvalidDataException("INPUT_LIMIT");
        batch.samples = new CrawlInputSample[count];
        for (int i = 0; i < count; i++)
        {
            var sample = new CrawlInputSample { sequence = reader.ReadUInt(), targetNetTick = reader.ReadUInt(),
                ownershipRevision = reader.ReadUInt(), controlledEntityId = reader.ReadUInt(), moveX = reader.ReadFloat(), moveY = reader.ReadFloat(),
                targetX = reader.ReadFloat(), targetY = reader.ReadFloat(), heldButtons = reader.ReadByte(), pointerMode = reader.ReadByte() };
            int edges = reader.ReadByte(); if (edges > 2) throw new InvalidDataException("INPUT_LIMIT");
            if (edges > 0)
            {
                sample.actions = new CrawlDiscreteAction[edges];
                for (int j = 0; j < edges; j++) sample.actions[j] = new CrawlDiscreteAction { actionId = reader.ReadUInt(), kind = reader.ReadByte() };
            }
            batch.samples[i] = sample;
        }
        return batch;
    }
}
