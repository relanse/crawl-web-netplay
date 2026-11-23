using System;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.SceneManagement;

// Web room preparation only. The original menu still confirms/saves players and starts the match.
public sealed class CrawlWebLobby : MonoBehaviour
{
    [Serializable] public class Member { public int slot; public string tag, playerId; public int deity = -1; public bool ready; public bool connected; }
    [Serializable] public class Snapshot { public int revision; public Member[] players; }
    [Serializable] public class Choice { public int id; public string name; public string description; public bool unlocked; public bool trial; }
    public static Snapshot Current { get; private set; }
    public static bool Starting { get; private set; }
    public static bool Ready { get; private set; }
    public static string Phase { get; private set; } = "loading";
    public static Choice[] Choices { get; private set; } = new Choice[0];
    private float nextCatalog;

    public static string AuthorityPlayerId(int slot)
    {
        if (!CrawlRuntimeMode.IsAuthority || Current == null) return null;
        return Array.Find(Current.players, member => member.slot == slot)?.playerId;
    }

    public void SetLobby(string json)
    {
        if (!CrawlRemoteInput.Enabled) return;
        Snapshot snapshot = JsonUtility.FromJson<Snapshot>(json);
        if (snapshot == null || snapshot.players == null || snapshot.players.Length > 4) return;
        Current = snapshot;
    }
    public void StartMatch(string revision)
    {
        if (!CrawlRemoteInput.Enabled || Current == null || Starting || !Ready || revision != Current.revision.ToString() || Current.players.Length < 2 || !Array.TrueForAll(Current.players, p => p.ready && p.connected)) return;
        MenuJoin menu = FindObjectOfType<MenuJoin>();
        if (menu != null && menu.StartWebMatch()) { Starting = true; Ready = false; Phase = "starting"; }
    }
    private void Update()
    {
        if (!CrawlRemoteInput.Enabled || Current == null) return;
        string scene = SceneManager.GetActiveScene().name;
        if (scene != "SceneMenuMain") { Phase = scene == "SceneGame" || scene == "SceneMenuIntroAnimatic" ? "playing" : "loading"; Ready = false; Starting = false; return; }
        if (Starting) return;
        MenuJoin menu = FindObjectOfType<MenuJoin>();
        if (menu != null) { Phase = "selecting"; menu.SyncWebPlayers(Current.players); Ready = menu.WebReady; }
        else
        {
            Phase = "loading"; Ready = false;
            MenuMain main = FindObjectOfType<MenuMain>();
            if (main != null && Current.players.Length > 0) main.OpenWebLobby(Current.players[0].slot);
        }
        if (Time.realtimeSinceStartup < nextCatalog || !Singleton<SystemDeity>.HasInstance() || !Singleton<SystemUnlocks>.HasInstance()) return;
        nextCatalog = Time.realtimeSinceStartup + 1f;
        List<Deity> deities = SystemDeity.GetDeities();
        List<Choice> choices = new List<Choice>();
        for (int i = 0; i < deities.Count; i++)
        {
            Deity deity = deities[i];
            choices.Add(new Choice { id = i, name = CrawlDisplayNames.TranslateDisplay(deity.GetName()), description = deity.GetText(), unlocked = SystemDeity.GetUnlocked(deity) && (!deity.GetIsTrial() || SystemUnlocks.GetUnlocked(Singleton<SystemDeity>.Instance.gameObject, "Trials")), trial = deity.GetIsTrial() });
        }
        Choices = choices.ToArray();
    }
}
