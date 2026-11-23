#if !UNITY_WEBGL || UNITY_EDITOR
using System;
using System.Collections;
using System.Text;
using UnityEngine;
using UnityEngine.Networking;

public sealed class CrawlTicketRedemption
{
    [Serializable] private class Request { public string ticket, roomId, matchId, processLeaseId, releaseId; }
    private readonly string endpoint, secret, roomId, matchId, processLeaseId, releaseId;
    public CrawlTicketRedemption(string endpoint, string secret, string roomId, string matchId, string processLeaseId, string releaseId)
    {
        Uri uri;
        if (!Uri.TryCreate(endpoint, UriKind.Absolute, out uri) || !uri.IsLoopback || uri.Scheme != "http" ||
            string.IsNullOrEmpty(secret) || secret.Length < 32) throw new ArgumentException("Control redemption must use authenticated loopback HTTP.");
        this.endpoint = endpoint; this.secret = secret; this.roomId = roomId; this.matchId = matchId; this.processLeaseId = processLeaseId; this.releaseId = releaseId;
    }
    public IEnumerator Redeem(string ticket, Action<CrawlTicketIdentity> complete)
    {
        byte[] body = Encoding.UTF8.GetBytes(JsonUtility.ToJson(new Request { ticket = ticket, roomId = roomId, matchId = matchId, processLeaseId = processLeaseId, releaseId = releaseId }));
        using (var request = new UnityWebRequest(endpoint, "POST"))
        {
            request.uploadHandler = new UploadHandlerRaw(body); request.downloadHandler = new DownloadHandlerBuffer();
            request.SetRequestHeader("Content-Type", "application/json"); request.SetRequestHeader("Authorization", "Bearer " + secret);
            request.timeout = 3; request.redirectLimit = 0;
            yield return request.SendWebRequest();
            if (request.result != UnityWebRequest.Result.Success || request.responseCode != 200 || request.downloadedBytes > 4096)
            { complete(null); yield break; }
            CrawlTicketIdentity identity = null;
            try { identity = JsonUtility.FromJson<CrawlTicketIdentity>(request.downloadHandler.text); } catch (ArgumentException) { }
            complete(identity);
        }
    }
}
#endif
