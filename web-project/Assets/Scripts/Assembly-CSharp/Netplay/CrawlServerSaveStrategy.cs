using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using UnityEngine;

// Private, typed server profile. Never deserializes objects or reads Crawl.sav.
public sealed class CrawlServerSaveStrategy : ISaveStrategy
{
    [Serializable] public sealed class Entry
    {
        public string key;
        public string kind;
        public int integer;
        public float number;
        public string text;
    }
    [Serializable] public sealed class Document { public int version; public Entry[] entries; }
    private const int MaxBytes = 4 * 1024 * 1024;
    private readonly string file;
    private Dictionary<string, Entry> values = new Dictionary<string, Entry>(StringComparer.Ordinal);
    private bool success, corrupt;
    private string log = "";

    public CrawlServerSaveStrategy() : this(
        System.Environment.GetEnvironmentVariable("CRAWL_SERVER_PROFILE_DIRECTORY") ?? CrawlRuntimeMode.ServerDataDirectory) { }
    public CrawlServerSaveStrategy(string directory)
    {
        if (string.IsNullOrWhiteSpace(directory) || !Path.IsPathRooted(directory))
            throw new ArgumentException("Server profile directory must be absolute.");
        file = Path.Combine(Path.GetFullPath(directory), "server-profile.v1.json");
        Load(); // SaveHelper creates a fresh strategy for every transaction.
    }
    public void RegisterCallbacks() { }
    public void DeregisterCallbacks() { }
    public bool GetComplete() { return true; }
    public bool GetSuccess() { return success; }
    public bool GetCorrupt() { return corrupt; }
    public string GetLog() { return log; }
    public void Load()
    {
        success = false; corrupt = false; log = "";
        try
        {
            var next = new Dictionary<string, Entry>(StringComparer.Ordinal);
            if (File.Exists(file))
            {
                if (new FileInfo(file).Length > MaxBytes) throw new InvalidDataException("Profile too large.");
                Document document = JsonUtility.FromJson<Document>(File.ReadAllText(file, Encoding.UTF8));
                if (document == null || document.version != 1 || document.entries == null || document.entries.Length > 32768)
                    throw new InvalidDataException("Unsupported profile schema.");
                foreach (Entry entry in document.entries)
                {
                    Validate(entry);
                    if (next.ContainsKey(entry.key)) throw new InvalidDataException("Duplicate profile key.");
                    next.Add(entry.key, entry);
                }
            }
            values = next;
            success = true;
        }
        catch (Exception error) { corrupt = true; log = "Server profile load failed: " + error.GetType().Name; }
    }
    public void Save()
    {
        success = false;
        if (corrupt) { log = "Refusing to overwrite a corrupt server profile."; return; }
        string temporary = file + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            if (values.Count > 32768) throw new InvalidDataException("Too many profile keys.");
            var entries = new List<Entry>(values.Values);
            entries.Sort((a, b) => StringComparer.Ordinal.Compare(a.key, b.key));
            foreach (Entry entry in entries) Validate(entry);
            byte[] data = Encoding.UTF8.GetBytes(JsonUtility.ToJson(new Document { version = 1, entries = entries.ToArray() }));
            if (data.Length > MaxBytes) throw new InvalidDataException("Profile too large.");
            Directory.CreateDirectory(Path.GetDirectoryName(file));
            using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            { stream.Write(data, 0, data.Length); stream.Flush(true); }
            if (File.Exists(file)) File.Replace(temporary, file, null);
            else File.Move(temporary, file);
            success = true; log = "";
        }
        catch (Exception error) { log = "Server profile save failed: " + error.GetType().Name; }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }
    private static void Validate(Entry entry)
    {
        if (entry == null || string.IsNullOrEmpty(entry.key) || entry.key.Length > 512)
            throw new InvalidDataException("Invalid profile key.");
        if (entry.kind != "int" && entry.kind != "float" && entry.kind != "string")
            throw new InvalidDataException("Invalid profile type.");
        if (float.IsNaN(entry.number) || float.IsInfinity(entry.number)) throw new InvalidDataException("Non-finite value.");
        if (entry.text != null && entry.text.Length > 262144) throw new InvalidDataException("Profile text too long.");
    }
    private void Put(Entry entry) { Validate(entry); values[entry.key] = entry; }
    public bool HasKey(string key) { return values.ContainsKey(key); }
    public void DeleteKey(string key) { values.Remove(key); }
    public void DeleteAll() { values.Clear(); corrupt = false; Save(); }
    public int GetInt(string key) { Entry e; return values.TryGetValue(key, out e) && e.kind == "int" ? e.integer : 0; }
    public float GetFloat(string key) { Entry e; return values.TryGetValue(key, out e) && e.kind == "float" ? e.number : 0f; }
    public string GetString(string key) { Entry e; return values.TryGetValue(key, out e) && e.kind == "string" ? e.text ?? "" : ""; }
    public void SetInt(string key, int value) { Put(new Entry { key = key, kind = "int", integer = value }); }
    public void SetFloat(string key, float value) { Put(new Entry { key = key, kind = "float", number = value }); }
    public void SetString(string key, string value) { Put(new Entry { key = key, kind = "string", text = value ?? "" }); }
}
