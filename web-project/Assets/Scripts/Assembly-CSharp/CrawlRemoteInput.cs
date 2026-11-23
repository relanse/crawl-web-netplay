using System;
using System.Runtime.InteropServices;
using UnityEngine;
using UnityEngine.SceneManagement;

// Optional input transport for an authoritative WebGL host. The existing game
// still owns controller assignment, movement, combat, randomness and physics.
public sealed class CrawlRemoteInput : MonoBehaviour
{
    [Serializable] public class Packet
    {
        public int slot;
        public int buttons;
        public int pressed;
        public float x;
        public float y;
        public bool connected;
        public bool mouse;
        public float px;
        public float py;
    }
    private sealed class State
    {
        public int buttons;
        public int pressed;
        public float x;
        public float y;
        public float updated;
        public bool connected;
        public bool mouse;
        public Vector2 pointer;
        public int sampledFrame = -1;
        public int sampledPressed;
    }
    [Serializable] private class MenuHit { public string text; public float px; public float py; public float width; public float height; }
    [Serializable] private class Status
    {
        public string scene;
        public int[] controllers = new int[4];
        public bool[] active = new bool[4];
        public string[] menus;
        public int frame;
        public int remotePackets;
        public int remotePresses;
        public int readPresses;
        public int inputInstances;
        public float[] playerX = new float[4];
        public float[] playerY = new float[4];
        public bool[] pointer = new bool[4];
        public string caption;
        public string voice;
        public float voiceTime;
        public MenuHit[] menuHits;
        public Vector2 menuMouse;
        public bool inputEnabled;
        public bool pointerInside;
        public bool mousePreferred;
        public string pointerTrace;
        public string lobbyPhase;
        public bool lobbyReady;
        public int lobbyRevision;
        public CrawlWebLobby.Choice[] deities;
        public string[] playerNames = new string[4];
        public int[] playerDeities = new int[4];
    }
    private static readonly State[] states = { new State(), new State(), new State(), new State() };
    private static readonly State localMouse = new State();
    public static bool LocalMouseInitialized { get; private set; }
    public static string PointerTrace { get; private set; } = "";
    public static void TracePointer(string value) { if (!Enabled && SystemTime.Paused && PointerTrace.Length < 3000) PointerTrace += " | " + value; }
    public static int LocalButtons { get { return LocalPointerInside ? localMouse.buttons : 0; } }
    public static Vector2 LocalPointer { get { return localMouse.pointer; } }
    public static int LocalPressed
    {
        get
        {
            if (localMouse.sampledFrame != Time.frameCount)
            {
                localMouse.sampledFrame = Time.frameCount;
                localMouse.sampledPressed = localMouse.pressed;
                localMouse.pressed = 0;
            }
            return LocalPointerInside ? localMouse.sampledPressed : 0;
        }
    }
    public static bool Enabled { get; private set; }
    public static bool LocalMousePreferred { get; private set; } = true;
    public static bool LocalPointerInside { get; private set; } = true;
    private float nextReport;
    private static int receivedPackets;
    private static int receivedPresses;
    private static int readPresses;
#if UNITY_WEBGL && !UNITY_EDITOR
    [DllImport("__Internal")] private static extern void CrawlReportState(string state);
#endif
    [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.BeforeSceneLoad)]
    private static void Initialize()
    {
        GameObject host = new GameObject("CrawlRemoteInput");
        host.layer = 17; // Original menu layer: input transport must remain alive while gameplay is paused.
        DontDestroyOnLoad(host);
        host.AddComponent<CrawlRemoteInput>();
        host.AddComponent<CrawlWebLobby>();
    }
    public void Enable(string unused) { CrawlRuntimeMode.EnableLegacyStream(); Enabled = true; }
    public void SetLocalMode(string mode) { LocalMousePreferred = mode == "mouse"; }
    public void SetPointerInside(string inside) { LocalPointerInside = inside == "1"; if (!LocalPointerInside) { localMouse.buttons = 0; localMouse.pressed = 0; } }
    public void SetLocalPointer(string json)
    {
        if (Enabled) return;
        Packet packet = JsonUtility.FromJson<Packet>(json);
        if (packet == null) return;
        LocalMouseInitialized = true;
        int buttons = packet.buttons & 7;
        if ((buttons & ~localMouse.buttons) != 0) PointerTrace = "pointer packet buttons=" + buttons;
        localMouse.pressed |= buttons & ~localMouse.buttons;
        localMouse.buttons = buttons;
        localMouse.pointer = new Vector2(Mathf.Clamp01(packet.px), Mathf.Clamp01(packet.py));
    }
    public static void ApplyLocalControlPreference()
    {
        if (Enabled || !Singleton<SystemUsers>.HasInstance() || !Singleton<SystemPlayers>.HasInstance()) return;
        UserData user = Singleton<SystemUsers>.Get.GetPrimaryUser();
        if (user == null) return;
        eController controller = user.GetAssignedControllerId();
        if (controller != eController.Mouse && controller != eController.Keyboard1) return;
        eController wanted = LocalMousePreferred ? eController.Mouse : eController.Keyboard1;
        if (wanted == controller) return;
        PlayerData player = SystemPlayers.GetPlayerWithController(controller);
        if (SystemPlayers.GetPlayerWithController(wanted) != null) return;
        if (player != null && player.IsHuman) player.AssignController(wanted);
        user.SetAssignedControllerId(wanted);
    }
    public void SetState(string json)
    {
        if (!Enabled) return;
        Packet packet = JsonUtility.FromJson<Packet>(json);
        if (packet == null || packet.slot < 0 || packet.slot >= states.Length) return;
        State state = states[packet.slot];
        receivedPackets++;
        int buttons = packet.connected ? packet.buttons & 7 : 0;
        state.pressed |= (buttons & ~state.buttons) | (packet.connected ? packet.pressed & 7 : 0);
        if (((buttons & ~state.buttons) | packet.pressed & 7) != 0) receivedPresses++;
        state.buttons = buttons;
        state.x = packet.connected ? Mathf.Clamp(packet.x, -1f, 1f) : 0f;
        state.y = packet.connected ? Mathf.Clamp(packet.y, -1f, 1f) : 0f;
        state.connected = packet.connected;
        state.mouse = packet.connected && packet.mouse;
        state.pointer = new Vector2(Mathf.Clamp01(packet.px), Mathf.Clamp01(packet.py));
        state.updated = Time.realtimeSinceStartup;
    }
    public static void SetNetworkState(int slot, CrawlAppliedInput value)
    {
        if (!CrawlRuntimeMode.IsAuthority || slot < 0 || slot >= 4) throw new InvalidOperationException("Invalid authority input binding.");
        Enabled = true;
        State state = states[slot]; state.connected = true;
        state.buttons = value.heldButtons; state.pressed = value.pressedButtons;
        state.x = value.moveX; state.y = value.moveY;
        state.mouse = value.pointerMode != 0;
        if (value.pointerMode == CrawlInputBuffer.ViewportPointer)
            state.pointer = new Vector2(value.targetX, value.targetY);
        else if (value.pointerMode == CrawlInputBuffer.WorldPointer)
        {
            Camera camera = SystemMain.GetCameraMenu();
            Vector3 viewport = camera == null ? Vector3.zero : camera.WorldToViewportPoint(new Vector3(value.targetX, value.targetY, 0));
            state.pointer = new Vector2(viewport.x, 1 - viewport.y);
        }
        state.sampledFrame = -1; state.updated = Time.realtimeSinceStartup;
    }
    public static bool IsRemoteController(eController controller)
    {
        return Enabled && (int)controller >= 0 && (int)controller < 4;
    }
    public static bool UsesMouse(eController controller)
    {
        int slot = (int)controller;
        return IsRemoteController(controller) && states[slot].connected && states[slot].mouse && Time.realtimeSinceStartup - states[slot].updated < 1.5f;
    }
    public static Vector2 Pointer(eController controller) { return states[(int)controller].pointer; }
    public static void Read(int slot, out int buttons, out int pressed, out float x, out float y)
    {
        State state = states[slot];
        bool fresh = state.connected && Time.realtimeSinceStartup - state.updated < 1.5f;
        buttons = fresh ? state.buttons : 0;
        // Match Unity's GetKeyDown semantics: every reader in the same frame
        // observes the same edge, including overlapping input systems on scene changes.
        if (state.sampledFrame != Time.frameCount)
        {
            state.sampledFrame = Time.frameCount;
            state.sampledPressed = state.pressed;
            state.pressed = 0;
        }
        pressed = fresh ? state.sampledPressed : 0;
        if (pressed != 0) readPresses++;
        x = fresh ? state.x : 0f;
        y = fresh ? state.y : 0f;
        if (!fresh) state.buttons = 0;
    }
    private void Update()
    {
#if UNITY_WEBGL && !UNITY_EDITOR
        if (Time.realtimeSinceStartup < nextReport) return;
        nextReport = Time.realtimeSinceStartup + 1f;
        Status status = new Status();
        status.scene = SceneManager.GetActiveScene().name;
        status.frame = Time.frameCount;
        status.remotePackets = receivedPackets;
        status.remotePresses = receivedPresses;
        status.readPresses = readPresses;
        status.inputInstances = FindObjectsOfType<SystemInput>().Length;
        status.caption = CrawlVoiceSubtitles.CurrentText;
        status.voice = CrawlVoiceSubtitles.CurrentClip;
        status.voiceTime = CrawlVoiceSubtitles.CurrentTime;
        status.lobbyPhase = CrawlWebLobby.Phase;
        status.lobbyReady = CrawlWebLobby.Ready;
        status.lobbyRevision = CrawlWebLobby.Current == null ? -1 : CrawlWebLobby.Current.revision;
        status.deities = CrawlWebLobby.Choices;
        if (!Enabled && SystemTime.Paused)
        {
            SystemInput input = Singleton<SystemInput>.Get;
            status.inputEnabled = input != null && input.enabled;
            status.pointerInside = LocalPointerInside;
            status.mousePreferred = LocalMousePreferred;
            status.pointerTrace = PointerTrace;
            status.menuMouse = SystemInput.GetMousePos();
            Camera camera = SystemMain.GetCameraMenu();
            var hits = new System.Collections.Generic.List<MenuHit>();
            if (camera != null) foreach (MenuTextMenuItem item in FindObjectsOfType<MenuTextMenuItem>())
            {
                if (!item.GetEnabled()) continue;
                Rect rect = item.GetHotspot();
                Vector3 a = camera.WorldToScreenPoint(rect.min), b = camera.WorldToScreenPoint(rect.max);
                hits.Add(new MenuHit { text = item.GetText(), px = (a.x+b.x)*0.5f/Screen.width, py = 1f-(a.y+b.y)*0.5f/Screen.height, width = (b.x-a.x)/Screen.width, height = (b.y-a.y)/Screen.height });
            }
            status.menuHits = hits.ToArray();
        }
        for (int i = 0; i < 4; i++)
        {
            status.controllers[i] = int.MinValue;
            if (!Singleton<SystemPlayers>.HasInstance()) continue;
            PlayerData player = SystemPlayers.GetPlayer(i);
            if (player == null) continue;
            status.active[i] = player.IsActive;
            status.playerNames[i] = player.Name;
            status.playerDeities[i] = SystemDeity.GetDeities().IndexOf(player.GetDeity());
            status.controllers[i] = (int)player.ControllerId;
            status.pointer[i] = player.ControllerId == eController.Mouse || UsesMouse(player.ControllerId);
            if (player.GameObject != null) { status.playerX[i] = player.GameObject.transform.position.x; status.playerY[i] = player.GameObject.transform.position.y; }
        }
        MenuStateMachine[] menus = FindObjectsOfType<MenuStateMachine>();
        status.menus = new string[menus.Length];
        for (int i = 0; i < menus.Length; i++) status.menus[i] = menus[i].name + ":" + menus[i].GetStateName();
        CrawlReportState(JsonUtility.ToJson(status));
#endif
    }
}
