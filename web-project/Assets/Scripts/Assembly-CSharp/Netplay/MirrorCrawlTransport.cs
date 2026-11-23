using System;
using System.Collections;
using System.Collections.Generic;
using System.Text.RegularExpressions;
using Mirror;
using Mirror.SimpleWeb;
using UnityEngine;

public struct CrawlClientHello : NetworkMessage
{
    public ushort protocolVersion;
    public string releaseId, contentHash, matchId, ticket;
}
public struct CrawlServerHello : NetworkMessage
{
    public ushort protocolVersion;
    public string playerId, matchId;
    public byte slot;
    public uint connectionEpoch;
}
public struct CrawlNetError : NetworkMessage { public string code; }
[Serializable] public sealed class CrawlTicketIdentity { public string playerId; public int slot; }

// Low-level Mirror messages only. There is deliberately no NetworkManager player
// prefab, NetworkTransform or duplicate automatic spawn authority.
public sealed class MirrorCrawlTransport : MonoBehaviour
{
    public const ushort ProtocolVersion = 1;
    public sealed class Peer
    {
        public NetworkConnectionToClient connection;
        public string playerId;
        public byte slot;
        public uint connectionEpoch;
    }
    private sealed class Pending { public double deadline; public bool redeeming; }
    private readonly Dictionary<int, Pending> pending = new Dictionary<int, Pending>();
    private readonly Dictionary<string, Peer> peers = new Dictionary<string, Peer>();
    private readonly Dictionary<string, uint> epochs = new Dictionary<string, uint>();
    private readonly HashSet<int> closing = new HashSet<int>();
    private SimpleWebTransport socket;
    private string releaseId, contentHash, matchId;
    private bool runningServer, runningClient;
    private Func<string, Action<CrawlTicketIdentity>, IEnumerator> redeem;
    public event Action<Peer> PeerJoined, PeerLeft;
    public event Action<CrawlServerHello> Authorized;
    public event Action<string> ClientClosed;
    private string closeReason = "DISCONNECTED";
    public int AuthenticatedCount { get { return peers.Count; } }
    public IEnumerable<Peer> Peers { get { return peers.Values; } }

    private void Setup()
    {
        if (socket != null || NetworkServer.active || NetworkClient.active) throw new InvalidOperationException("Network already started.");
        gameObject.layer = 17; DontDestroyOnLoad(gameObject);
        socket = gameObject.AddComponent<SimpleWebTransport>();
        socket.maxMessageSize = 64 * 1024; socket.maxHandshakeSize = 8 * 1024;
        socket.maxSendQueueSize = 16; // 16 x max message size <= 1 MiB in transport queue.
        socket.serverMaxMsgsPerTick = 128; socket.clientMaxMsgsPerTick = 128;
        socket.sendTimeout = 5000; socket.receiveTimeout = 20_000;
        Transport.active = socket;
    }
    private static void ValidateRelease(string release, string hash, string match)
    {
        if (!Regex.IsMatch(release ?? "", "^[A-Za-z0-9._-]{1,64}$") ||
            !Regex.IsMatch(hash ?? "", "^[a-f0-9]{64}$") || !Regex.IsMatch(match ?? "", "^[a-f0-9]{32}$"))
            throw new ArgumentException("Invalid network release binding.");
    }
    public void StartServer(ushort port, string release, string hash, string match,
        Func<string, Action<CrawlTicketIdentity>, IEnumerator> redeemTicket)
    {
        if (!CrawlRuntimeMode.IsAuthority) throw new InvalidOperationException("Only an authority build may listen.");
        ValidateRelease(release, hash, match); if (port == 0 || redeemTicket == null) throw new ArgumentException();
        Setup(); releaseId = release; contentHash = hash; matchId = match; redeem = redeemTicket;
        socket.port = port; socket.serverBindAddress = System.Net.IPAddress.Loopback; runningServer = true;
        NetworkServer.OnConnectedEvent += Connected;
        NetworkServer.OnDisconnectedEvent += Disconnected;
        NetworkServer.Listen(8); // Four players plus bounded replacement handshakes.
        NetworkServer.RegisterHandler<CrawlClientHello>(Hello, false);
    }
    private void Connected(NetworkConnectionToClient connection)
    { pending.Add(connection.connectionId, new Pending { deadline = Time.realtimeSinceStartupAsDouble + 5 }); }
    private void Hello(NetworkConnectionToClient connection, CrawlClientHello hello)
    {
        if (closing.Contains(connection.connectionId)) return;
        Pending state;
        if (connection.isAuthenticated || !pending.TryGetValue(connection.connectionId, out state) || state.redeeming)
        { connection.Disconnect(); return; }
        if (hello.protocolVersion != ProtocolVersion || hello.releaseId != releaseId || hello.contentHash != contentHash || hello.matchId != matchId)
        { Reject(connection, "VERSION_MISMATCH"); return; }
        if (!Regex.IsMatch(hello.ticket ?? "", "^[A-Za-z0-9_-]{43}$")) { Reject(connection, "TICKET_INVALID"); return; }
        state.redeeming = true;
        StartCoroutine(Redeem(connection, state, hello.ticket));
    }
    private IEnumerator Redeem(NetworkConnectionToClient connection, Pending request, string ticket)
    {
        CrawlTicketIdentity identity = null;
        yield return redeem(ticket, value => identity = value);
        Pending current;
        if (!pending.TryGetValue(connection.connectionId, out current) || current != request ||
            !NetworkServer.connections.ContainsKey(connection.connectionId)) yield break;
        if (Time.realtimeSinceStartupAsDouble >= request.deadline || identity == null ||
            !Regex.IsMatch(identity.playerId ?? "", "^[a-f0-9]{32}$") || identity.slot < 0 || identity.slot > 3)
        { Reject(connection, "AUTH_REQUIRED"); yield break; }
        foreach (Peer existing in peers.Values)
            if (existing.slot == identity.slot && existing.playerId != identity.playerId) { Reject(connection, "SLOT_CONFLICT"); yield break; }
        uint previous; epochs.TryGetValue(identity.playerId, out previous);
        if (previous == uint.MaxValue) { Reject(connection, "EPOCH_EXHAUSTED"); yield break; }
        Peer old; peers.TryGetValue(identity.playerId, out old);
        if (old == null && peers.Count >= 4) { Reject(connection, "ROOM_FULL"); yield break; }
        var peer = new Peer { connection = connection, playerId = identity.playerId, slot = (byte)identity.slot, connectionEpoch = previous + 1 };
        epochs[identity.playerId] = peer.connectionEpoch; peers[identity.playerId] = peer;
        pending.Remove(connection.connectionId); connection.authenticationData = peer; connection.isAuthenticated = true;
        if (old != null) { PeerLeft?.Invoke(old); Reject(old.connection, "SESSION_REPLACED"); }
        connection.Send(new CrawlServerHello { protocolVersion = ProtocolVersion, playerId = peer.playerId, slot = peer.slot,
            connectionEpoch = peer.connectionEpoch, matchId = matchId });
        PeerJoined?.Invoke(peer);
    }
    public bool IsCurrent(Peer peer)
    { Peer current; return peer != null && peers.TryGetValue(peer.playerId, out current) && ReferenceEquals(peer, current); }
    public bool AcceptGameMessage(NetworkConnectionToClient connection)
    {
        // A replaced peer may still have input in flight. Discard it while the
        // reliable reason flushes; immediately disconnecting here loses that
        // reason and makes an old browser retry as if the network had failed.
        if (closing.Contains(connection.connectionId)) return false;
        if (IsCurrent(connection.authenticationData as Peer)) return true;
        connection.Disconnect(); return false;
    }
    private void Disconnected(NetworkConnectionToClient connection)
    {
        pending.Remove(connection.connectionId);
        closing.Remove(connection.connectionId);
        Peer peer = connection.authenticationData as Peer;
        if (IsCurrent(peer)) { peers.Remove(peer.playerId); PeerLeft?.Invoke(peer); }
    }
    public void Reject(NetworkConnectionToClient connection, string code)
    {
        if (!closing.Add(connection.connectionId)) return;
        pending.Remove(connection.connectionId);
        // Keep Mirror's authentication flag until the flush. Otherwise its
        // requireAuthentication guard disconnects on the next queued input
        // before Crawl's handler can discard it. AcceptGameMessage gates all
        // gameplay messages and the peer binding is already replaced.
        connection.Send(new CrawlNetError { code = code });
        StartCoroutine(DisconnectAfterFlush(connection));
    }
    private IEnumerator DisconnectAfterFlush(NetworkConnectionToClient connection)
    { yield return new WaitForSecondsRealtime(.1f); connection.Disconnect(); }
    private void Update()
    {
        if (!runningServer) return;
        var expired = new List<int>();
        foreach (var pair in pending) if (Time.realtimeSinceStartupAsDouble >= pair.Value.deadline) expired.Add(pair.Key);
        foreach (int id in expired)
        { NetworkConnectionToClient connection; if (NetworkServer.connections.TryGetValue(id, out connection)) Reject(connection, "AUTH_TIMEOUT"); else pending.Remove(id); }
    }
    public void StartClient(string endpoint, string release, string hash, string match, string ticket)
    {
        ValidateRelease(release, hash, match);
        if (!Regex.IsMatch(ticket ?? "", "^[A-Za-z0-9_-]{43}$")) throw new ArgumentException("Invalid ticket.");
        Uri uri;
        if (!Uri.TryCreate(endpoint, UriKind.Absolute, out uri) || (uri.Scheme != "wss" && !(uri.Scheme == "ws" && uri.IsLoopback)) ||
            uri.UserInfo.Length > 0 || uri.Query.Length > 0 || uri.Fragment.Length > 0) throw new ArgumentException("Use WSS (WS allowed only on loopback).");
        Setup(); runningClient = true; matchId = match;
        NetworkClient.OnConnectedEvent += () => {
            NetworkClient.Send(new CrawlClientHello { protocolVersion = ProtocolVersion, releaseId = release, contentHash = hash, matchId = match, ticket = ticket });
            ticket = null;
        };
        NetworkClient.OnDisconnectedEvent += () => ClientClosed?.Invoke(closeReason);
        NetworkClient.RegisterHandler<CrawlNetError>(error => { closeReason = error.code; }, false);
        NetworkClient.RegisterHandler<CrawlServerHello>(hello => {
            if (hello.protocolVersion != ProtocolVersion || hello.matchId != matchId || hello.slot > 3 || hello.connectionEpoch == 0 ||
                !Regex.IsMatch(hello.playerId ?? "", "^[a-f0-9]{32}$")) { closeReason = "INVALID_SERVER_HELLO"; NetworkClient.Disconnect(); return; }
            NetworkClient.connection.isAuthenticated = true; Authorized?.Invoke(hello);
        }, false);
        NetworkClient.Connect(uri);
    }
    private void OnDestroy()
    {
        if (runningServer) { NetworkServer.Shutdown(); NetworkServer.OnConnectedEvent -= Connected; NetworkServer.OnDisconnectedEvent -= Disconnected; }
        if (runningClient) NetworkClient.Shutdown();
        if (socket != null) socket.Shutdown();
    }
}
