import {
  Matrix4,
  RuntimeError,
  addAllToArray,
  clone,
  defined,
  getAbsoluteUri,
} from "@cesium/core";
import isDataUri from "../Core/isDataUri.js";
import ResourceCache from "./ResourceCache.js";
import ModelComponents from "./ModelComponents.js";
import StructuralMetadata from "./StructuralMetadata.js";

/**
 * Loads and instantiates the external asset graph from the glTF 2.1 draft.
 * Child loaders retain the original resource identities so ResourceCache shares
 * JSON, decoded geometry, GPU buffers, and textures between tiles.
 * @namespace GltfExternalAssets
 * @private
 */
const GltfExternalAssets = {};

function getFile(loader, index) {
  const file = loader.gltfJson.files?.[index];
  if (!Number.isInteger(index) || index < 0 || !defined(file)) {
    throw new RuntimeError(`Invalid external asset file index: ${index}`);
  }
  if (defined(file.uri) === defined(file.bufferView)) {
    throw new RuntimeError(
      `External asset file ${index} must define exactly one of uri and bufferView.`,
    );
  }
  return file;
}

async function getFileData(loader, index) {
  const file = getFile(loader, index);
  if (defined(file.uri)) {
    const resource = loader._baseResource.getDerivedResource({ url: file.uri });
    return new Uint8Array(await resource.fetchArrayBuffer());
  }
  if (!defined(loader.gltfJson.bufferViews?.[file.bufferView])) {
    throw new RuntimeError(
      `Invalid external asset buffer view: ${file.bufferView}`,
    );
  }
  const bufferViewLoader = ResourceCache.getBufferViewLoader({
    gltf: loader.gltfJson,
    bufferViewId: file.bufferView,
    gltfResource: loader._gltfResource,
    baseResource: loader._baseResource,
  });
  loader._bufferViewLoaders.push(bufferViewLoader);
  await bufferViewLoader.load();
  return bufferViewLoader.typedArray;
}

function makeUriResolver(loader, file) {
  if (!defined(file.aliases) || file.aliases.length === 0) {
    return undefined;
  }
  const aliases = new Map();
  for (const alias of file.aliases) {
    getFile(loader, alias.file);
    if (aliases.has(alias.alias)) {
      throw new RuntimeError(`Duplicate external asset alias: ${alias.alias}`);
    }
    aliases.set(alias.alias, alias.file);
  }
  // Resolve each embedded alias once, even if several buffers/images use it.
  const resolved = new Map();
  return async function (uri, jsonLoader) {
    const index = aliases.get(uri);
    if (!defined(index)) {
      return uri;
    }
    if (!resolved.has(index)) {
      resolved.set(
        index,
        (async () => {
          const target = getFile(loader, index);
          if (defined(target.uri)) {
            return loader._baseResource.getDerivedResource({ url: target.uri })
              .url;
          }
          const data = await getFileData(loader, index);
          if (jsonLoader.isDestroyed()) {
            return uri;
          }
          const url = URL.createObjectURL(
            new Blob([data], { type: target.mimeType }),
          );
          jsonLoader._objectUrls.push(url);
          return url;
        })(),
      );
    }
    return resolved.get(index);
  };
}

GltfExternalAssets.load = async function (loader, createLoader) {
  const gltf = loader.gltfJson;
  const ancestry = loader._externalAssetAncestry;
  const currentUrl = getAbsoluteUri(
    (loader._fetchResource ?? loader._gltfResource).url,
  );
  const path = ancestry.concat(currentUrl);
  const byFile = new Map();
  const promises = [];
  for (let i = 0; i < (gltf.nodes?.length ?? 0); i++) {
    const node = gltf.nodes[i];
    if (!defined(node.externalAsset)) {
      continue;
    }
    const asset = gltf.externalAssets?.[node.externalAsset];
    if (!Number.isInteger(node.externalAsset) || !defined(asset)) {
      throw new RuntimeError(
        `Invalid external asset index: ${node.externalAsset}`,
      );
    }
    if (
      defined(node.mesh) ||
      defined(node.extensions?.EXT_mesh_gpu_instancing)
    ) {
      throw new RuntimeError(
        "An externalAsset node cannot also define a mesh or EXT_mesh_gpu_instancing.",
      );
    }
    const file = getFile(loader, asset.file);
    if (
      file.mimeType !== "model/gltf+json" &&
      file.mimeType !== "model/gltf-binary"
    ) {
      throw new RuntimeError(
        `Unsupported external asset MIME type: ${file.mimeType}`,
      );
    }
    if (!byFile.has(asset.file)) {
      const promise = (async () => {
        const embedded = !defined(file.uri) || isDataUri(file.uri);
        const sourceResource = embedded
          ? undefined
          : loader._baseResource.getDerivedResource({ url: file.uri });
        const sourceUrl = defined(sourceResource)
          ? getAbsoluteUri(sourceResource.url)
          : undefined;
        if (
          defined(sourceUrl) &&
          path.some((url) => url.split("#")[0] === sourceUrl.split("#")[0])
        ) {
          throw new RuntimeError(
            `Cyclic external asset reference: ${path.concat(sourceUrl).join(" -> ")}`,
          );
        }
        const resolveUri = makeUriResolver(loader, file);
        // Aliases can change the content of an otherwise identical URI. Scope
        // those cache identities to this file reference, including GLB buffers.
        const scoped = embedded || defined(resolveUri);
        const gltfResource = scoped
          ? loader._gltfResource.clone()
          : sourceResource;
        if (scoped) {
          // Resource's public URL setter strips fragments. Keep the internal
          // fragment here, as for embedded contents of composite tile resources.
          gltfResource._url = `${loader._gltfResource._url.split("#")[0]}#external-asset=${encodeURIComponent(loader._gltfResource.url)}:${asset.file}`;
        }
        const typedArray = embedded
          ? await getFileData(loader, asset.file)
          : undefined;
        if (loader.isDestroyed() || loader.isUnloaded()) {
          return undefined;
        }
        const child = createLoader({
          gltfResource,
          baseResource: embedded ? loader._baseResource : sourceResource,
          fetchResource: sourceResource,
          typedArray,
          resolveUri,
          externalAssetAncestry: path,
          isExternalAsset: true,
          releaseGltfJson: false,
          asynchronous: loader._asynchronous,
          incrementallyLoadTextures: loader._incrementallyLoadTextures,
          loadAttributesAsTypedArray: loader._loadAttributesAsTypedArray,
          loadAttributesFor2D: loader._loadAttributesFor2D,
          enablePick: loader._enablePick,
          loadIndicesForWireframe: loader._loadIndicesForWireframe,
          loadPrimitiveOutline: loader._loadPrimitiveOutline,
          loadForClassification: loader._loadForClassification,
          renameBatchIdSemantic: loader._renameBatchIdSemantic,
        });
        loader._externalAssetLoaders.push(child);
        await child.load();
        return child;
      })();
      byFile.set(asset.file, promise);
    }
    promises.push(
      byFile.get(asset.file).then((child) => {
        if (!loader.isDestroyed() && !loader.isUnloaded() && defined(child)) {
          loader._externalAssetReferences.set(i, child);
        }
      }),
    );
  }
  await Promise.all(promises);
};

function copy(object) {
  return Object.assign(Object.create(Object.getPrototypeOf(object)), object);
}

function copyFeatureIds(featureIds, tableOffset) {
  return featureIds.map((source) => {
    const result = copy(source);
    if (defined(result.propertyTableId)) {
      result.propertyTableId += tableOffset;
    }
    return result;
  });
}

function mergeMetadata(target, source) {
  const current = target.structuralMetadata;
  const offsets = {
    tables: current?.propertyTables.length ?? 0,
    textures: current?.propertyTextures.length ?? 0,
    attributes: current?.propertyAttributes.length ?? 0,
  };
  const metadata = source.structuralMetadata;
  if (defined(metadata)) {
    // Imported indices belong to the containing model. Keep the source objects
    // (and their GPU textures) owned by their loader, with separate IDs here.
    const copyWithId = (object, index, offset) => {
      const result = copy(object);
      result._id = index + offset;
      return result;
    };
    target.structuralMetadata = new StructuralMetadata({
      schema: current?.schema ?? metadata.schema,
      propertyTables: (current?.propertyTables ?? []).concat(
        metadata.propertyTables.map((table, i) =>
          copyWithId(table, i, offsets.tables),
        ),
      ),
      propertyTextures: (current?.propertyTextures ?? []).concat(
        metadata.propertyTextures.map((texture, i) =>
          copyWithId(texture, i, offsets.textures),
        ),
      ),
      propertyAttributes: (current?.propertyAttributes ?? []).concat(
        metadata.propertyAttributes.map((attribute, i) =>
          copyWithId(attribute, i, offsets.attributes),
        ),
      ),
    });
  }
  return offsets;
}

function instantiate(target, source, parent) {
  if (source.scene.nodes.length === 0) {
    return;
  }
  const offsets = mergeMetadata(target, source);
  const nodes = source.nodes.map((original) => {
    const node = copy(original);
    node.index = target.nodes.length;
    target.nodes.push(node);
    node.matrix = Matrix4.clone(original.matrix);
    node.translation = clone(original.translation);
    node.rotation = clone(original.rotation);
    node.scale = clone(original.scale);
    node.morphWeights = original.morphWeights.slice();
    node.primitives = original.primitives.map((originalPrimitive) => {
      const primitive = copy(originalPrimitive);
      primitive.attributes = originalPrimitive.attributes.map(copy);
      primitive.indices = defined(originalPrimitive.indices)
        ? copy(originalPrimitive.indices)
        : undefined;
      primitive.featureIds = copyFeatureIds(
        originalPrimitive.featureIds,
        offsets.tables,
      );
      primitive.propertyTextureIds = originalPrimitive.propertyTextureIds.map(
        (id) => id + offsets.textures,
      );
      primitive.propertyAttributeIds =
        originalPrimitive.propertyAttributeIds.map(
          (id) => id + offsets.attributes,
        );
      primitive.externalAssetSource =
        originalPrimitive.externalAssetSource ?? originalPrimitive;
      return primitive;
    });
    if (defined(original.instances)) {
      node.instances = copy(original.instances);
      node.instances.attributes = original.instances.attributes.map(copy);
      node.instances.featureIds = copyFeatureIds(
        original.instances.featureIds,
        offsets.tables,
      );
    }
    return node;
  });
  const skins = source.skins.map((original) => {
    const skin = copy(original);
    skin.index = target.skins.length;
    skin.joints = original.joints.map((joint) => nodes[joint.index]);
    target.skins.push(skin);
    return skin;
  });
  for (let i = 0; i < nodes.length; i++) {
    nodes[i].children = source.nodes[i].children.map(
      (child) => nodes[child.index],
    );
    nodes[i].skin = defined(source.nodes[i].skin)
      ? skins[source.nodes[i].skin.index]
      : undefined;
  }
  for (const original of source.animations) {
    const animation = copy(original);
    animation.channels = original.channels.map((originalChannel) => {
      const channel = copy(originalChannel);
      channel.target = copy(originalChannel.target);
      channel.target.node = nodes[originalChannel.target.node.index];
      return channel;
    });
    target.animations.push(animation);
  }
  // Articulations are named rather than indexed. Namespace each instance to
  // prevent posing one imported asset from inadvertently posing another.
  const prefix = `externalAsset_${parent.index}_`;
  for (const original of source.articulations) {
    const articulation = copy(original);
    articulation.name = prefix + original.name;
    target.articulations.push(articulation);
  }
  for (const node of nodes) {
    if (defined(node.articulationName)) {
      node.articulationName = prefix + node.articulationName;
    }
  }
  const roots = source.scene.nodes.map((node) => nodes[node.index]);
  if (!Matrix4.equals(source.transform, Matrix4.IDENTITY)) {
    const root = new ModelComponents.Node();
    root.index = target.nodes.length;
    root.matrix = Matrix4.clone(source.transform);
    root.children = roots;
    target.nodes.push(root);
    parent.children.push(root);
  } else {
    addAllToArray(parent.children, roots);
  }
}

GltfExternalAssets.attach = function (loader) {
  const components = loader.components;
  const credited = new Set();
  for (const [index, externalLoader] of loader._externalAssetReferences) {
    instantiate(components, externalLoader.components, components.nodes[index]);
    if (!credited.has(externalLoader)) {
      addAllToArray(
        components.asset.credits,
        externalLoader.components.asset.credits,
      );
      credited.add(externalLoader);
    }
  }
};

export default GltfExternalAssets;
