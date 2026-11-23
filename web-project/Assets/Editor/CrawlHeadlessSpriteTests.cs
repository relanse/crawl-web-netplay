using System;
using System.IO;
using UnityEngine;

public static class CrawlHeadlessSpriteTests
{
    private static void Check(bool value, string message) { if (!value) throw new Exception(message); }
    public static void Run()
    {
        var cameraObject = new GameObject("Headless commit test camera");
        var spriteObject = new GameObject("Headless commit test sprite");
        Material material = null; Texture2D texture = null; Mesh mesh = null;
        try
        {
            var camera = cameraObject.AddComponent<Camera>(); camera.enabled = false;
            var manager = cameraObject.AddComponent<exSpriteMng>();
            var sprite = spriteObject.AddComponent<exSprite>(); sprite.renderCamera = camera;
            var box = spriteObject.AddComponent<BoxCollider>();
            var helper = spriteObject.AddComponent<exCollisionHelper>(); helper.plane = sprite;
            helper.autoLength = false; helper.autoResizeCollision = true;
            texture = new Texture2D(8, 8); material = new Material(Shader.Find("Unlit/Texture")); material.mainTexture = texture;
            spriteObject.GetComponent<Renderer>().sharedMaterial = material;
            mesh = new Mesh(); spriteObject.GetComponent<MeshFilter>().sharedMesh = mesh;
            sprite.customSize = true; sprite.useTextureOffset = false; sprite.width = 10; sprite.height = 12;
            sprite.ForceUpdateMesh(mesh);
            Check(Mathf.Approximately(box.size.x, 10), "Initial collider did not match sprite");
            sprite.width = 24; sprite.color = new Color(.2f, .4f, .6f, .8f);
            Check(Mathf.Approximately(box.size.x, 10), "Test did not leave a pending render-dependent collider change");
            Action commit = CrawlHeadlessSpriteCommit.BindManager(manager); commit();
            Check(Mathf.Approximately(box.size.x, 24) && Mathf.Approximately(mesh.bounds.size.x, 24), "Headless boundary did not update collider and geometry");
            Check(mesh.colors.Length == 4 && Mathf.Approximately(mesh.colors[0].a, .8f), "Headless boundary did not commit current sprite colors");
            Check(sprite.updateFlags == exPlane.UpdateFlags.None && !sprite.inCommitList, "Committed work remained queued");
            Vector3 size = box.size; commit();
            Check(box.size == size, "Repeated empty commit changed collision state");
            File.WriteAllText(Path.Combine(System.Environment.GetEnvironmentVariable("CRAWL_TEST_OUTPUT"), "headless-sprite-tests.json"),
                "{\"passed\":true,\"checks\":6,\"scope\":\"Camera disabled; queued mesh/color/collider changes commit without rendering\"}");
            Debug.Log("Crawl headless sprite boundary tests passed.");
        }
        finally
        {
            UnityEngine.Object.DestroyImmediate(spriteObject); UnityEngine.Object.DestroyImmediate(cameraObject);
            if (mesh != null) UnityEngine.Object.DestroyImmediate(mesh);
            if (material != null) UnityEngine.Object.DestroyImmediate(material);
            if (texture != null) UnityEngine.Object.DestroyImmediate(texture);
        }
    }
}
