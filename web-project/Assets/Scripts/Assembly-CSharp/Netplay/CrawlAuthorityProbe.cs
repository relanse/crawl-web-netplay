#if CRAWL_NETPLAY_TESTS && (CRAWL_AUTHORITY || UNITY_SERVER)
using System;
using System.IO;
using UnityEngine;
using UnityEngine.SceneManagement;

// Compile-time test fixture, absent from production and ordinary WebGL builds.
public sealed class CrawlAuthorityProbe : MonoBehaviour
{
    [Serializable] private class Command
    {
        public int id;
        public bool quit;
        public bool setPaused, paused;
        public int frameRate;
        public bool evolve;
        public CrawlRemoteInput.Packet[] inputs;
    }
    [Serializable] private class Actor
    {
        public int slot, controller;
        public bool active, alive, hero;
        public float x, y, health, inputX, inputY, rawX, rawY;
        public string objectName, state;
        public Vector3 visualPosition;
        public Vector3[] visualVertices;
        public Vector2[] visualUv;
        public Color[] visualColors;
        public string visualShader, visualTexture;
        public bool visualEnabled;
        public int visualQueue, visualRawQueue;
    }
    [Serializable] private class Status
    {
        public string mode, scene, lobby, graphics;
        public int frame, commandId, exceptions, attackCallbacks, damageCommits, registeredEntities;
        public uint lastEntityId;
        public uint netTick, simTick;
        public int maxPhysicsStepsPerFrame;
        public uint headlessCommitFrames;
        public int spriteManagers;
        public uint[] deliveredEdges;
        public float uptime;
        public bool ready, steam, paused, inputEnabled;
        public float timeScale;
        public Actor[] actors;
        public string[] menus;
        public string room;
        public float roomX, roomY;
        public Exit[] exits;
    }
    [Serializable] private class Exit { public float x, y, dx, dy; public bool open, blocked, connected; }
    private string directory;
    private int commandId, exceptions;
    private float nextReport;
    private CrawlRemoteInput input;
    private CrawlWebLobby lobby;
    private bool requestedStart;
    public static int AttackCallbacks;
    public static int DamageCommits;

    [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
    private static void Install()
    {
        var obj = new GameObject("CrawlAuthorityProbe"); obj.layer = 17;
        DontDestroyOnLoad(obj); obj.AddComponent<CrawlAuthorityProbe>();
    }
    private void Awake()
    {
        directory = CrawlRuntimeMode.ServerDataDirectory;
        Directory.CreateDirectory(directory);
        var catalog = Resources.Load<CrawlPrefabCatalog>("CrawlNetplayCatalog");
        if (catalog == null) throw new InvalidOperationException("Authority probe requires a generated prefab catalog.");
        CrawlEntityRegistry.Install(catalog);
        Application.targetFrameRate = 60;
        QualitySettings.vSyncCount = 0;
        Application.runInBackground = true;
        Application.logMessageReceived += OnLog;
    }
    private void OnLog(string message, string trace, LogType type)
    { if (type == LogType.Exception || type == LogType.Error) exceptions++; }
    private void OnDestroy() { Application.logMessageReceived -= OnLog; CrawlEntityRegistry.Uninstall(); }
    private void Update()
    {
        if (input == null)
        {
            input = FindObjectOfType<CrawlRemoteInput>();
            if (input == null) return;
            input.Enable(""); lobby = input.GetComponent<CrawlWebLobby>();
            lobby.SetLobby("{\"revision\":1,\"players\":[{\"slot\":0,\"tag\":\"T01\",\"deity\":-1,\"ready\":true,\"connected\":true},{\"slot\":1,\"tag\":\"T02\",\"deity\":-1,\"ready\":true,\"connected\":true}]}");
        }
        if (CrawlWebLobby.Ready && !requestedStart)
        { requestedStart = true; lobby.StartMatch("1"); }
        string commandFile = Path.Combine(directory, "command.json");
        if (File.Exists(commandFile))
        {
            try
            {
                Command command = JsonUtility.FromJson<Command>(File.ReadAllText(commandFile));
                if (command != null && command.id > commandId)
                {
                    commandId = command.id;
                    if (CrawlAuthorityInput.Current == null && command.inputs != null) foreach (var packet in command.inputs) input.SetState(JsonUtility.ToJson(packet));
                    if (command.setPaused) { if (command.paused) SystemTime.PauseGame(); else SystemTime.UnPauseGame(); }
                    if (command.frameRate >= 10 && command.frameRate <= 120) Application.targetFrameRate = command.frameRate;
                    if (command.evolve) { Singleton<SystemPlayers>.Get.OnLevelComplete(); SystemMain.LoadLevel("SceneMenuEvolve"); }
                    if (command.quit) { Report(); Application.Quit(0); return; }
                }
            }
            catch (IOException) { } // The harness publishes with atomic replacement.
        }
        if (Time.realtimeSinceStartup >= nextReport) { nextReport = Time.realtimeSinceStartup + .25f; Report(); }
        if (Time.realtimeSinceStartup > 180f) { Debug.LogError("Authority probe deadline exceeded."); Application.Quit(4); }
    }
    private void Report()
    {
        var status = new Status {
            mode = CrawlRuntimeMode.Current.ToString(), scene = SceneManager.GetActiveScene().name,
            lobby = CrawlWebLobby.Phase, ready = CrawlWebLobby.Ready, frame = Time.frameCount,
            uptime = Time.realtimeSinceStartup, commandId = commandId, exceptions = exceptions,
            attackCallbacks = AttackCallbacks, damageCommits = DamageCommits, graphics = SystemInfo.graphicsDeviceType.ToString(),
            steam = SystemSteam.Initialized, actors = new Actor[4]
        };
        status.paused = SystemTime.Paused; status.timeScale = Time.timeScale;
        if (CrawlHeadlessSpriteCommit.Current != null)
        {
            status.headlessCommitFrames = CrawlHeadlessSpriteCommit.Current.CompletedFrames;
            status.spriteManagers = CrawlHeadlessSpriteCommit.Current.ManagerCount;
        }
        if (CrawlAuthorityInput.Current != null)
        {
            var networkInput = CrawlAuthorityInput.Current; status.netTick = networkInput.NetTick; status.simTick = networkInput.SimTick;
            status.maxPhysicsStepsPerFrame = networkInput.MaxPhysicsStepsPerFrame; status.deliveredEdges = new uint[4];
            for (int i = 0; i < 4; i++) status.deliveredEdges[i] = networkInput.GetSlot(i).deliveredEdges;
        }
        if (CrawlEntityRegistry.Current != null) { CrawlEntityRegistry.Current.PruneDestroyed(); status.registeredEntities = CrawlEntityRegistry.Current.Count; status.lastEntityId = CrawlEntityRegistry.Current.LastAllocatedId; }
        status.inputEnabled = Singleton<SystemInput>.HasInstance() && Singleton<SystemInput>.Get.enabled;
        for (int i = 0; i < 4; i++)
        {
            var actor = status.actors[i] = new Actor { slot = i };
            if (!Singleton<SystemPlayers>.HasInstance()) continue;
            PlayerData data = SystemPlayers.GetPlayer(i);
            if (data == null) continue;
            actor.active = data.IsActive; actor.alive = data.IsAlive; actor.hero = data.IsHero;
            actor.controller = (int)data.ControllerId;
            Vector2 move = data.GetInputMove(); actor.inputX = move.x; actor.inputY = move.y;
            int buttons, pressed; CrawlRemoteInput.Read(i, out buttons, out pressed, out actor.rawX, out actor.rawY);
            if (data.GameObject != null)
            {
                actor.objectName = data.GameObject.name;
                actor.x = data.GameObject.transform.position.x; actor.y = data.GameObject.transform.position.y;
                Health health = data.GameObject.GetComponent<Health>();
                if (health != null) actor.health = health.GetHealthCurrent();
                Player player = data.GameObject.GetComponent<Player>();
                if (player != null) actor.state = player.GetState().ToString();
                var sprite = data.GameObject.GetComponent<exSprite>();
                if (sprite != null && sprite.meshFilter != null && sprite.meshFilter.sharedMesh != null)
                {
                    var mesh = sprite.meshFilter.sharedMesh; var renderer = sprite.GetComponent<Renderer>();
                    actor.visualPosition = sprite.transform.position; actor.visualVertices = mesh.vertices;
                    for (int vertex = 0; vertex < actor.visualVertices.Length; vertex++) actor.visualVertices[vertex] = sprite.transform.TransformPoint(actor.visualVertices[vertex]);
                    actor.visualUv = mesh.uv; actor.visualColors = mesh.colors; actor.visualEnabled = renderer.enabled;
                    if (renderer.sharedMaterial != null) { actor.visualShader = renderer.sharedMaterial.shader.name; actor.visualTexture = renderer.sharedMaterial.mainTexture.name; actor.visualQueue = renderer.sharedMaterial.renderQueue; actor.visualRawQueue = CrawlWorldCapture.GetRawRenderQueue(renderer.sharedMaterial); }
                }
            }
        }
        MenuStateMachine[] menus = FindObjectsOfType<MenuStateMachine>();
        status.menus = new string[menus.Length];
        for (int i = 0; i < menus.Length; i++) status.menus[i] = menus[i].name + ":" + menus[i].GetStateName();
        if (Singleton<SystemLevel>.HasInstance())
        {
            Room room = SystemLevel.GetCurrentRoom();
            if (room != null)
            {
                status.room = room.name; status.roomX = room.transform.position.x; status.roomY = room.transform.position.y;
                status.exits = new Exit[room.m_doors.Count];
                for (int i = 0; i < room.m_doors.Count; i++)
                {
                    DoorData door = room.m_doors[i]; Vector2 direction = door.GetDirectionVector();
                    status.exits[i] = new Exit { x = status.roomX + door.m_position.x, y = status.roomY + door.m_position.y,
                        dx = direction.x, dy = direction.y, connected = door.m_room != null,
                        open = door.m_doorObject != null && door.m_doorObject.GetOpen(), blocked = door.m_doorObject != null && door.m_doorObject.GetBlocked() };
                }
            }
        }
        string file = Path.Combine(directory, "status.json"), temporary = file + ".tmp";
        File.WriteAllText(temporary, JsonUtility.ToJson(status));
        if (File.Exists(file)) File.Replace(temporary, file, null); else File.Move(temporary, file);
    }
}
#endif
