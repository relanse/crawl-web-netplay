using System;
using System.Collections.Generic;
using UnityEngine;

// Asset references only: loading this catalog never instantiates game prefabs.
public sealed class CrawlVisualCatalog : ScriptableObject
{
    public Texture2D[] textures;
    public Shader[] shaders;
    public Font[] fonts = new Font[0];
    public AudioClip[] audioClips = new AudioClip[0];
    private Dictionary<Texture, uint> textureIds;
    private Dictionary<Shader, uint> shaderIds;
    private void Index()
    {
        if (textureIds != null) return;
        textureIds = new Dictionary<Texture, uint>(); shaderIds = new Dictionary<Shader, uint>();
        for (int i = 0; i < textures.Length; i++) textureIds.Add(textures[i], (uint)i + 4);
        for (int i = 0; i < shaders.Length; i++) shaderIds.Add(shaders[i], (uint)i + 1);
    }
    public uint TextureId(Texture texture)
    {
        if (texture == null || texture == Texture2D.whiteTexture) return 1;
        if (texture == Texture2D.blackTexture) return 2;
        if (texture == Texture2D.grayTexture) return 3;
        Index(); uint id;
        if (!textureIds.TryGetValue(texture, out id)) throw new InvalidOperationException("Uncatalogued world texture: " + texture.name);
        return id;
    }
    public Texture2D Texture(uint id)
    {
        if (id == 1) return Texture2D.whiteTexture;
        if (id == 2) return Texture2D.blackTexture;
        if (id == 3) return Texture2D.grayTexture;
        if (id < 4 || id - 4 >= textures.Length) throw new InvalidOperationException("Unknown world texture ID.");
        return textures[id - 4];
    }
    public uint ShaderId(Shader shader)
    {
        Index(); uint id;
        if (shader == null || !shaderIds.TryGetValue(shader, out id)) throw new InvalidOperationException("Uncatalogued world shader: " + (shader == null ? "null" : shader.name));
        return id;
    }
    public Shader Shader(uint id)
    {
        if (id == 0 || id > shaders.Length) throw new InvalidOperationException("Unknown world shader ID.");
        return shaders[id - 1];
    }
    public uint FontId(Font font)
    {
        int index = Array.IndexOf(fonts, font);
        if (index < 0) throw new InvalidOperationException("Uncatalogued font: " + (font == null ? "null" : font.name));
        return (uint)index + 1;
    }
    public Font Font(uint id)
    {
        if (id == 0 || id > fonts.Length) throw new InvalidOperationException("Unknown world font ID.");
        return fonts[id - 1];
    }
    public uint AudioId(AudioClip clip)
    {
        int index = Array.IndexOf(audioClips, clip);
        if (index < 0) throw new InvalidOperationException("Uncatalogued audio: " + clip.name);
        return (uint)index + 1;
    }
    public AudioClip Audio(uint id)
    {
        if (id == 0 || id > audioClips.Length) throw new InvalidOperationException("Unknown audio ID.");
        return audioClips[id - 1];
    }
}
