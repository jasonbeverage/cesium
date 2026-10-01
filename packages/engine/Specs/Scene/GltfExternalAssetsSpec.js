import {
  Cartesian3,
  Color,
  FixedFrameTransforms,
  HeadingPitchRange,
  Matrix4,
  RuntimeError,
  clone,
} from "@cesium/core";
import {
  GltfJsonLoader,
  GltfLoader,
  ContextLimits,
  ModelReader,
  ModelUtility,
  Resource,
  ResourceCache,
} from "../../index.js";
import Cesium3DTilesTester from "../../../../Specs/Cesium3DTilesTester.js";
import createScene from "../../../../Specs/createScene.js";
import waitForLoaderProcess from "../../../../Specs/waitForLoaderProcess.js";
import loadAndZoomToModelAsync from "./Model/loadAndZoomToModelAsync.js";

describe(
  "Scene/GltfExternalAssets",
  function () {
    const fixture = "./Data/Models/glTF-2.1/ExternalAssets/ExternalAssets.gltf";
    const box =
      "./Data/Models/glTF-2.0/BoxTextured/glTF-Binary/BoxTextured.glb";
    let scene;
    const loaders = [];

    beforeAll(function () {
      scene = createScene();
    });
    afterAll(function () {
      scene.destroyForSpecs();
    });
    afterEach(function () {
      scene.primitives.removeAll();
      for (const loader of loaders) {
        if (!loader.isDestroyed()) {
          loader.destroy();
        }
      }
      loaders.length = 0;
      ResourceCache.clearForSpecs();
    });

    function composition(file) {
      return {
        asset: { version: "2.1" },
        files: [file],
        externalAssets: [{ file: 0 }],
        nodes: [
          { externalAsset: 0 },
          { externalAsset: 0, translation: [2, 0, 0] },
        ],
        scene: 0,
        scenes: [{ nodes: [0, 1] }],
      };
    }

    async function load(
      gltf,
      resource = new Resource({ url: "./Data/external.gltf" }),
      options = {},
    ) {
      const loader = new GltfLoader({
        gltfResource: resource,
        gltfJson: gltf,
        incrementallyLoadTextures: false,
        ...options,
      });
      loaders.push(loader);
      await loader.load();
      await waitForLoaderProcess(loader, scene);
      return loader;
    }

    function meshNodes(loader) {
      return loader.components.nodes.filter(
        (node) => node.primitives.length > 0,
      );
    }

    it("loads a GLB once and attaches independent node hierarchies after existing children", async function () {
      const gltf = await Resource.fetchJson({ url: fixture });
      gltf.nodes.push({ name: "ExistingChild" });
      gltf.nodes[1].children = [3];
      const fetch = spyOn(
        GltfJsonLoader.prototype,
        "_fetchGltf",
      ).and.callThrough();
      const loader = await load(gltf, new Resource({ url: fixture }));
      expect(fetch.calls.count()).toBe(1);
      expect(loader._externalAssetLoaders.length).toBe(1);
      expect(loader.components.nodes[1].children[0].name).toBe("ExistingChild");
      expect(loader.components.nodes[1].children.length).toBe(2);
      const nodes = meshNodes(loader);
      expect(nodes.length).toBe(2);
      expect(nodes[0]).not.toBe(nodes[1]);
      expect(nodes[0].primitives[0]).not.toBe(nodes[1].primitives[0]);
      expect(nodes[0].primitives[0].attributes[0].buffer).toBe(
        nodes[1].primitives[0].attributes[0].buffer,
      );
    });

    it("shares buffers across tile loaders and retains them until the last reference is destroyed", async function () {
      const gltf = await Resource.fetchJson({ url: fixture });
      const baseResource = new Resource({ url: fixture });
      const fetch = spyOn(
        GltfJsonLoader.prototype,
        "_fetchGltf",
      ).and.callThrough();
      const first = await load(
        clone(gltf, true),
        new Resource({ url: "./Data/first.gltf" }),
        { baseResource },
      );
      const second = await load(
        clone(gltf, true),
        new Resource({ url: "./Data/second.gltf" }),
        { baseResource },
      );
      const buffer = meshNodes(first)[0].primitives[0].attributes[0].buffer;
      expect(meshNodes(second)[0].primitives[0].attributes[0].buffer).toBe(
        buffer,
      );
      expect(fetch.calls.count()).toBe(1);
      first.destroy();
      expect(buffer.isDestroyed()).toBe(false);
      second.destroy();
      expect(buffer.isDestroyed()).toBe(true);
    });

    it("resolves external glTF buffers and images relative to the referenced file", async function () {
      const file = {
        uri: "Models/glTF-2.0/BoxTextured/glTF/BoxTextured.gltf",
        mimeType: "model/gltf+json",
      };
      const loader = await load(composition(file));
      const primitive = meshNodes(loader)[0].primitives[0];
      expect(primitive.attributes[0].buffer).toBeDefined();
      expect(
        primitive.material.metallicRoughness.baseColorTexture.texture,
      ).toBeDefined();
      expect(loader.texturesLoaded).toBe(true);
    });

    it("loads an embedded data URI asset", async function () {
      const data = new Uint8Array(
        await Resource.fetchArrayBuffer({ url: box }),
      );
      const uri = `data:model/gltf-binary;base64,${btoa(String.fromCharCode(...data))}`;
      const loader = await load(
        composition({ uri, mimeType: "model/gltf-binary" }),
      );
      expect(meshNodes(loader).length).toBe(2);
    });

    it("loads a bufferView asset and retains its own GLB buffers", async function () {
      const data = new Uint8Array(
        await Resource.fetchArrayBuffer({ url: box }),
      );
      const gltf = composition({
        bufferView: 0,
        mimeType: "model/gltf-binary",
      });
      gltf.buffers = [
        {
          byteLength: data.length,
          uri: `data:application/octet-stream;base64,${btoa(String.fromCharCode(...data))}`,
        },
      ];
      gltf.bufferViews = [
        { buffer: 0, byteOffset: 0, byteLength: data.length },
      ];
      const loader = await load(gltf);
      expect(meshNodes(loader).length).toBe(2);
      expect(
        meshNodes(loader)[0].primitives[0].attributes[0].buffer,
      ).toBeDefined();
    });

    it("redirects buffer and texture aliases to parent files", async function () {
      const gltf = composition({
        uri: "Models/glTF-2.0/BoxTextured/glTF/BoxTextured.gltf",
        mimeType: "model/gltf+json",
        aliases: [
          { alias: "BoxTextured0.bin", file: 1 },
          { alias: "CesiumLogoFlat.png", file: 2 },
        ],
      });
      gltf.files.push(
        {
          uri: "Models/glTF-2.0/BoxTextured/glTF/BoxTextured0.bin",
          mimeType: "application/gltf-buffer",
        },
        {
          uri: "Models/glTF-2.0/BoxTextured/glTF/CesiumLogoFlat.png",
          mimeType: "image/png",
        },
      );
      const loader = await load(gltf);
      expect(
        meshNodes(loader)[0].primitives[0].attributes[0].buffer,
      ).toBeDefined();
      expect(loader._externalAssetLoaders[0].gltfJson.buffers[0].uri).toContain(
        "Data/Models/",
      );
    });

    it("does not attach an asset without a default scene", async function () {
      const data = {
        asset: { version: "2.1" },
        nodes: [{}],
        scenes: [{ nodes: [0] }],
      };
      const uri = `data:model/gltf+json;base64,${btoa(JSON.stringify(data))}`;
      const loader = await load(
        composition({ uri, mimeType: "model/gltf+json" }),
      );
      expect(loader.components.nodes[0].children.length).toBe(0);
    });

    it("rejects cycles with the referenced URI in the error", async function () {
      const gltf = composition({
        uri: "cycle.gltf",
        mimeType: "model/gltf+json",
      });
      const resource = new Resource({ url: "./Data/cycle.gltf" });
      const loader = new GltfLoader({ gltfResource: resource, gltfJson: gltf });
      loaders.push(loader);
      await expectAsync(loader.load()).toBeRejectedWithError(
        RuntimeError,
        /Cyclic external asset reference.*cycle.gltf/,
      );
    });

    it("rejects invalid file references", async function () {
      const gltf = composition({ uri: "unused.glb", mimeType: "image/png" });
      await expectAsync(load(gltf)).toBeRejectedWithError(
        RuntimeError,
        /Unsupported external asset MIME type/,
      );
    });

    it("propagates external fetch failures and cleans up resources", async function () {
      const gltf = composition({
        uri: "missing-external.glb",
        mimeType: "model/gltf-binary",
      });
      await expectAsync(load(gltf)).toBeRejectedWithError(
        RuntimeError,
        /missing-external.glb/,
      );
      expect(Object.keys(ResourceCache.cacheEntries).length).toBe(0);
    });

    it("instances repeated static meshes and restores individual draws for node control", async function () {
      const model = await loadAndZoomToModelAsync(
        { url: fixture, incrementallyLoadTextures: false },
        scene,
      );
      expect(model.sceneGraph._externalAssetBatches.length).toBe(1);
      const batch = model.sceneGraph._externalAssetBatches[0].runtimeNode;
      expect(batch.runtimePrimitives[0].drawCommand.command.instanceCount).toBe(
        2,
      );
      expect(batch.instancingTransformsBuffer).toBeDefined();
      model.getNode("Left").show = false;
      scene.renderForSpecs();
      expect(model.sceneGraph._externalAssetBatches.length).toBe(0);
      model.getNode("Right").matrix = Matrix4.fromTranslation(
        new Cartesian3(3, 0, 0),
      );
      scene.renderForSpecs();
      expect(model.getNode("Right").matrix[12]).toBe(3);
    });

    it("computes conservative bounds for scaled, rotated, and sheared instance transforms", function () {
      const primitive = {
        attributes: [
          {
            semantic: "POSITION",
            min: new Cartesian3(-1, -1, -1),
            max: new Cartesian3(1, 1, 1),
          },
        ],
      };
      const transform = Matrix4.clone(Matrix4.IDENTITY);
      transform[0] = 3;
      transform[4] = 2;
      transform[12] = 10;
      const bounds = ModelUtility.getPositionMinMax(
        primitive,
        undefined,
        undefined,
        [transform],
      );
      expect(bounds.min).toEqual(new Cartesian3(5, -1, -1));
      expect(bounds.max).toEqual(new Cartesian3(15, 1, 1));
    });

    it("renders, picks, and unloads shared external assets in multiple tiles", async function () {
      scene.camera.lookAt(
        new Cartesian3(6378137, 0, 0),
        new HeadingPitchRange(0, -0.5, 30),
      );
      const tileset = await Cesium3DTilesTester.loadTileset(
        scene,
        "./Data/Cesium3DTiles/ExternalAssets/tileset.json",
        { foveatedScreenSpaceError: false, maximumScreenSpaceError: 0.1 },
      );
      const first = tileset.root.children[0];
      const second = tileset.root.children[1];
      expect(first.contentReady).toBe(true);
      expect(second.contentReady).toBe(true);
      const firstLoader = first.content._model._loader;
      const secondLoader = second.content._model._loader;
      const buffer =
        meshNodes(firstLoader)[0].primitives[0].attributes[0].buffer;
      expect(
        meshNodes(secondLoader)[0].primitives[0].attributes[0].buffer,
      ).toBe(buffer);
      expect(first.content._model.sceneGraph._externalAssetBatches.length).toBe(
        1,
      );
      first.unloadContent();
      expect(buffer.isDestroyed()).toBe(false);
      scene.renderForSpecs();
      scene.primitives.remove(tileset);
      expect(buffer.isDestroyed()).toBe(true);
    });

    it("renders an external asset and returns its model when picked", async function () {
      const model = await loadAndZoomToModelAsync(
        { url: fixture, incrementallyLoadTextures: false },
        scene,
      );
      scene.camera.flyToBoundingSphere(model.boundingSphere, { duration: 0 });
      model.getNode("Left").matrix = Matrix4.IDENTITY;
      model.getNode("Right").show = false;
      scene.camera.flyToBoundingSphere(model.boundingSphere, { duration: 0 });
      expect(scene).toRenderAndCall((rgba) => {
        expect(rgba).not.toEqual(Color.BLACK.toBytes());
      });
      expect(scene).toPickAndCall((result) => {
        expect(result.primitive).toBe(model);
      });
    });

    it("streams tiles as the camera moves and releases unused shared references", async function () {
      const originalFov = scene.camera.frustum.fov;
      scene.camera.frustum.fov = 0.2;
      try {
        scene.camera.lookAtTransform(Matrix4.IDENTITY);
        scene.camera.setView({
          destination: new Cartesian3(6378141, -3, 0),
          orientation: {
            direction: new Cartesian3(-1, 0, 0),
            up: Cartesian3.UNIT_Z,
          },
        });
        const tileset = await Cesium3DTilesTester.loadTileset(
          scene,
          "./Data/Cesium3DTiles/ExternalAssets/tileset.json",
          { foveatedScreenSpaceError: false, maximumScreenSpaceError: 0.1 },
        );
        const first = tileset.root.children.find(
          (tile) => tile.boundingSphere.center.y < 0,
        );
        const second = tileset.root.children.find(
          (tile) => tile.boundingSphere.center.y > 0,
        );
        expect(first.contentReady).toBe(true);
        expect(second.contentReady).toBe(false);
        const buffer = meshNodes(first.content._model._loader)[0].primitives[0]
          .attributes[0].buffer;
        scene.camera.setView({
          destination: new Cartesian3(6378141, 3, 0),
          orientation: {
            direction: new Cartesian3(-1, 0, 0),
            up: Cartesian3.UNIT_Z,
          },
        });
        await Cesium3DTilesTester.waitForTilesLoaded(scene, tileset);
        expect(second.contentReady).toBe(true);
        expect(
          meshNodes(second.content._model._loader)[0].primitives[0]
            .attributes[0].buffer,
        ).toBe(buffer);
        tileset.trimLoadedTiles();
        scene.renderForSpecs();
        expect(first.contentReady).toBe(false);
        expect(buffer.isDestroyed()).toBe(false);
        scene.primitives.remove(tileset);
        expect(buffer.isDestroyed()).toBe(true);
      } finally {
        scene.camera.frustum.fov = originalFov;
      }
    });

    it("loads nested references and applies every level of the node hierarchy", async function () {
      const child = composition({
        uri: new URL(box, document.baseURI).href,
        mimeType: "model/gltf-binary",
      });
      const uri = `data:model/gltf+json;base64,${btoa(JSON.stringify(child))}`;
      const loader = await load(
        composition({ uri, mimeType: "model/gltf+json" }),
      );
      expect(meshNodes(loader).length).toBe(4);
      expect(loader.components.nodes[0].children.length).toBe(2);
      expect(loader.components.nodes[1].translation).toEqual(
        new Cartesian3(2, 0, 0),
      );
    });

    it("resolves embedded glTF dependencies relative to the containing asset", async function () {
      const url = "./Data/Models/glTF-2.0/BoxTextured/glTF/BoxTextured.gltf";
      const source = await Resource.fetchJson({ url });
      const uri = `data:model/gltf+json;base64,${btoa(JSON.stringify(source))}`;
      const loader = await load(
        composition({ uri, mimeType: "model/gltf+json" }),
        new Resource({ url }),
      );
      expect(loader.texturesLoaded).toBe(true);
      expect(meshNodes(loader).length).toBe(2);
    });

    it("redirects an alias to an embedded buffer and releases its object URL", async function () {
      const triangle = {
        asset: { version: "2.0" },
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [{ mesh: 0 }],
        buffers: [{ byteLength: 36, uri: "missing.bin" }],
        bufferViews: [{ buffer: 0, byteLength: 36 }],
        accessors: [
          {
            bufferView: 0,
            componentType: 5126,
            type: "VEC3",
            count: 3,
            min: [0, 0, 0],
            max: [1, 1, 0],
          },
        ],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      };
      const uri = `data:model/gltf+json;base64,${btoa(JSON.stringify(triangle))}`;
      const gltf = composition({
        uri,
        mimeType: "model/gltf+json",
        aliases: [{ alias: "missing.bin", file: 1 }],
      });
      const data = new Uint8Array(
        new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer,
      );
      gltf.files.push({ bufferView: 0, mimeType: "application/gltf-buffer" });
      gltf.buffers = [
        {
          byteLength: 36,
          uri: `data:application/octet-stream;base64,${btoa(String.fromCharCode(...data))}`,
        },
      ];
      gltf.bufferViews = [{ buffer: 0, byteLength: 36 }];
      const revoke = spyOn(URL, "revokeObjectURL").and.callThrough();
      const loader = await load(gltf);
      expect(
        meshNodes(loader)[0].primitives[0].attributes[0].buffer,
      ).toBeDefined();
      const child = loader._externalAssetLoaders[0];
      const url = child._gltfJsonLoader._objectUrls[0];
      loader.destroy();
      expect(revoke).toHaveBeenCalledWith(url);
    });

    it("preserves animation targets and independently poses imported skins", async function () {
      const sourceUrl = new URL(
        "./Data/Models/glTF-2.0/SimpleSkin/glTF/SimpleSkin.gltf",
        document.baseURI,
      ).href;
      const gltf = composition({ uri: sourceUrl, mimeType: "model/gltf+json" });
      const loader = await load(gltf);
      expect(loader.components.skins.length).toBe(2);
      expect(loader.components.skins[0].joints[0]).not.toBe(
        loader.components.skins[1].joints[0],
      );
      expect(loader.components.animations.length).toBe(2);
      expect(loader.components.animations[0].channels[0].target.node).not.toBe(
        loader.components.animations[1].channels[0].target.node,
      );
    });

    it("instances mirrored meshes separately and reads transforms after node control", async function () {
      const gltf = await Resource.fetchJson({ url: fixture });
      gltf.nodes.push({
        externalAsset: 0,
        translation: [3, 0, 0],
        scale: [-1, 2, 1],
      });
      gltf.nodes.push({
        externalAsset: 0,
        translation: [5, 0, 0],
        scale: [-1, 1, 1],
      });
      gltf.nodes[0].children.push(3, 4);
      const model = await loadAndZoomToModelAsync(
        { gltf, basePath: fixture, incrementallyLoadTextures: false },
        scene,
      );
      const batches = model.sceneGraph._externalAssetBatches;
      expect(batches.length).toBe(2);
      expect(batches[1].runtimeNode.node.matrix[0]).toBe(-1);
      const originalTransforms = [];
      ModelReader.forEachPrimitive(
        model,
        undefined,
        (runtime, primitive, instances) => {
          originalTransforms.push(
            ...instances.map((instance) => Matrix4.clone(instance.transform)),
          );
        },
      );
      expect(originalTransforms.length).toBe(4);
      const corners =
        batches[1].runtimeNode.runtimePrimitives[0].boundingSphere;
      expect(corners.radius).toBeGreaterThan(0);
      model.getNode("Root").show = false;
      scene.renderForSpecs();
      expect(
        model.sceneGraph._runtimeNodes.every((node) => node !== undefined),
      ).toBe(true);
      const transforms = [];
      ModelReader.forEachPrimitive(
        model,
        undefined,
        (runtime, primitive, instances) => {
          transforms.push(
            ...instances.map((instance) => Matrix4.clone(instance.transform)),
          );
        },
      );
      expect(transforms.length).toBe(4);
      for (const original of originalTransforms) {
        expect(
          transforms.some((transform) =>
            Matrix4.equalsEpsilon(transform, original, 1e-6),
          ),
        ).toBe(true);
      }
    });

    it("instances and picks external meshes in WebGL 1", async function () {
      const webgl1Scene = createScene({
        contextOptions: { requestWebgl1: true },
      });
      try {
        const gltf = await Resource.fetchJson({ url: fixture });
        gltf.nodes[1].translation = [0, 0, 0];
        gltf.nodes[2].translation = [0, 0, 0];
        const model = await loadAndZoomToModelAsync(
          {
            gltf,
            basePath: fixture,
            incrementallyLoadTextures: false,
            enablePick: true,
          },
          webgl1Scene,
        );
        const batch = model.sceneGraph._externalAssetBatches[0].runtimeNode;
        expect(
          batch.runtimePrimitives[0].drawCommand.command.instanceCount,
        ).toBe(2);
        expect(batch.transformsTypedArray).toBeDefined();
        expect(webgl1Scene).toRenderAndCall((rgba) => {
          expect(rgba).not.toEqual(Color.BLACK.toBytes());
        });
        expect(webgl1Scene).toPickAndCall((result) => {
          expect(result.primitive).toBe(model);
        });
      } finally {
        webgl1Scene.destroyForSpecs();
      }
    });

    it("projects affine external asset instances to 2D after a pipeline rebuild", async function () {
      const scene2D = createScene();
      try {
        scene2D.morphTo2D(0);
        const gltf = await Resource.fetchJson({ url: fixture });
        gltf.nodes[1].translation = [0, 0, 0];
        gltf.nodes[2].translation = [0, 0, 0];
        gltf.nodes[2].scale = [2, 1, 1];
        const model = await loadAndZoomToModelAsync(
          {
            gltf,
            basePath: fixture,
            incrementallyLoadTextures: false,
            projectTo2D: true,
            modelMatrix: FixedFrameTransforms.eastNorthUpToFixedFrame(
              Cartesian3.fromDegrees(-75, 40),
            ),
          },
          scene2D,
        );
        const batch = model.sceneGraph._externalAssetBatches[0].runtimeNode;
        expect(batch.instancingTransformsBuffer2D).toBeDefined();
        model.resetDrawCommands();
        scene2D.renderForSpecs();
        expect(
          batch.runtimePrimitives[0].drawCommand.command.instanceCount,
        ).toBe(2);
        expect(scene2D).toRenderAndCall((rgba) => {
          expect(rgba).not.toEqual(Color.BLACK.toBytes());
        });
      } finally {
        scene2D.destroyForSpecs();
      }
    });

    it("uses shared individual draws when hardware instancing is unavailable", async function () {
      const fallbackScene = createScene({
        contextOptions: { requestWebgl1: true },
      });
      fallbackScene.context._instancedArrays = false;
      try {
        const model = await loadAndZoomToModelAsync(
          { url: fixture, incrementallyLoadTextures: false },
          fallbackScene,
        );
        expect(model.sceneGraph._externalAssetBatches.length).toBe(0);
        const nodes = model.sceneGraph._runtimeNodes.filter(
          (node) => node.runtimePrimitives.length > 0,
        );
        expect(nodes.length).toBe(2);
        expect(nodes[0].node.primitives[0].attributes[0].buffer).toBe(
          nodes[1].node.primitives[0].attributes[0].buffer,
        );
      } finally {
        fallbackScene.destroyForSpecs();
      }
    });

    it("uses individual draws if instance attributes exceed the device limit", async function () {
      const maximumVertexAttributes = ContextLimits._maximumVertexAttributes;
      ContextLimits._maximumVertexAttributes = 5;
      try {
        const model = await loadAndZoomToModelAsync(
          { url: fixture, incrementallyLoadTextures: false },
          scene,
        );
        expect(model.sceneGraph._externalAssetBatches.length).toBe(0);
        expect(model.ready).toBe(true);
      } finally {
        ContextLimits._maximumVertexAttributes = maximumVertexAttributes;
      }
    });

    it("remaps imported metadata tables and retains independent feature draws", async function () {
      const gltf = composition({
        uri: new URL(
          "./Data/Models/glTF-2.0/BuildingsMetadata/glTF/buildings-metadata.gltf",
          document.baseURI,
        ).href,
        mimeType: "model/gltf+json",
      });
      const model = await loadAndZoomToModelAsync(
        { gltf, incrementallyLoadTextures: false },
        scene,
      );
      const metadata = model.structuralMetadata;
      expect(metadata.propertyTableCount).toBe(2);
      expect(metadata.getPropertyTable(0).id).toBe(0);
      expect(metadata.getPropertyTable(1).id).toBe(1);
      const nodes = meshNodes(model._loader);
      expect(nodes[0].primitives[0].featureIds[0].propertyTableId).toBe(0);
      expect(nodes[1].primitives[0].featureIds[0].propertyTableId).toBe(1);
      expect(model.sceneGraph._externalAssetBatches.length).toBe(0);
      expect(metadata.getPropertyTable(0).getProperty(0, "height")).toBe(
        metadata.getPropertyTable(1).getProperty(0, "height"),
      );
    });

    it("instances the same URI referenced through different file entries", async function () {
      const file = {
        uri: new URL(box, document.baseURI).href,
        mimeType: "model/gltf-binary",
      };
      const gltf = composition(file);
      gltf.files.push({ ...file });
      gltf.externalAssets.push({ file: 1 });
      gltf.nodes[1].externalAsset = 1;
      const fetch = spyOn(
        GltfJsonLoader.prototype,
        "_fetchGltf",
      ).and.callThrough();
      const model = await loadAndZoomToModelAsync(
        { gltf, incrementallyLoadTextures: false },
        scene,
      );
      expect(fetch.calls.count()).toBe(1);
      expect(model.sceneGraph._externalAssetBatches.length).toBe(1);
      expect(
        model.sceneGraph._externalAssetBatches[0].runtimeNode.node.instances
          .transforms.length,
      ).toBe(2);
    });

    it("does not inherit file aliases into nested assets", async function () {
      const child = composition({
        uri: new URL(
          "./Data/Models/glTF-2.0/BoxTextured/glTF/BoxTextured.gltf",
          document.baseURI,
        ).href,
        mimeType: "model/gltf+json",
      });
      const uri = `data:model/gltf+json;base64,${btoa(JSON.stringify(child))}`;
      const gltf = composition({
        uri,
        mimeType: "model/gltf+json",
        aliases: [{ alias: "BoxTextured0.bin", file: 1 }],
      });
      gltf.files.push({
        uri: "unused-missing.bin",
        mimeType: "application/gltf-buffer",
      });
      const loader = await load(gltf);
      expect(meshNodes(loader).length).toBe(4);
    });

    it("plays independently targeted external asset animations without static batching", async function () {
      const gltf = composition({
        uri: new URL(
          "./Data/Models/glTF-2.0/SimpleSkin/glTF/SimpleSkin.gltf",
          document.baseURI,
        ).href,
        mimeType: "model/gltf+json",
      });
      const model = await loadAndZoomToModelAsync(
        { gltf, incrementallyLoadTextures: false },
        scene,
      );
      expect(model.activeAnimations.addAll().length).toBe(2);
      expect(model.sceneGraph._externalAssetBatches).toBeUndefined();
      scene.renderForSpecs();
      const skins = model.sceneGraph._runtimeSkins;
      expect(skins.length).toBe(2);
      expect(skins[0].jointMatrices[0]).not.toBe(skins[1].jointMatrices[0]);
    });
  },
  "WebGL",
);
