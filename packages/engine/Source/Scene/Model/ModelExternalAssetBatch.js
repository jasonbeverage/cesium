import {
  AttributeType,
  ComponentDatatype,
  Matrix3,
  Matrix4,
  PrimitiveType,
  defined,
} from "@cesium/core";
import ContextLimits from "../../Renderer/ContextLimits.js";
import ModelComponents from "../ModelComponents.js";
import SceneMode from "../SceneMode.js";
import ModelRuntimeNode from "./ModelRuntimeNode.js";
import ModelRuntimePrimitive from "./ModelRuntimePrimitive.js";

/**
 * Batches static external asset meshes within a model (and therefore within a
 * tile). ResourceCache shares the mesh buffers and textures across tiles while
 * tile-local batches preserve tile culling, selection, and unloading.
 * @namespace ModelExternalAssetBatch
 * @private
 */
const ModelExternalAssetBatch = {};

ModelExternalAssetBatch.isSupported = function (sceneGraph, frameState) {
  if (
    !frameState.context.instancedArrays ||
    (sceneGraph._model.imageryLayers?.length ?? 0) > 0
  ) {
    return false;
  }
  const use2D =
    frameState.mode !== SceneMode.SCENE3D &&
    !frameState.scene3DOnly &&
    sceneGraph._model._projectTo2D;
  const instanceAttributeCount = use2D ? 6 : 3;
  return (sceneGraph._externalAssetBatches ?? []).every(({ runtimeNode }) => {
    const primitive = runtimeNode.runtimePrimitives[0].primitive;
    const outlineAttributeCount = defined(primitive.outlineCoordinates) ? 1 : 0;
    const attributeCount = primitive.attributes.reduce(
      (count, attribute) =>
        count + AttributeType.getAttributeLocationCount(attribute.type),
      instanceAttributeCount + outlineAttributeCount,
    );
    return attributeCount <= ContextLimits.maximumVertexAttributes;
  });
};

ModelExternalAssetBatch.create = function (sceneGraph) {
  const components = sceneGraph.components;
  if (
    components.animations.length > 0 ||
    components.skins.length > 0 ||
    components.articulations.length > 0 ||
    defined(sceneGraph._model.classificationType)
  ) {
    return;
  }
  const groups = new Map();
  for (const runtimeNode of sceneGraph._runtimeNodes) {
    if (!defined(runtimeNode) || defined(runtimeNode.node.instances)) {
      continue;
    }
    for (const runtimePrimitive of runtimeNode.runtimePrimitives) {
      const primitive = runtimePrimitive.primitive;
      if (
        !defined(primitive.externalAssetSource) ||
        primitive.primitiveType !== PrimitiveType.TRIANGLES ||
        primitive.morphTargets.length > 0 ||
        primitive.featureIds.length > 0 ||
        primitive.propertyTextureIds.length > 0 ||
        primitive.propertyAttributeIds.length > 0 ||
        primitive.material.alphaMode === "BLEND" ||
        defined(primitive.edgeVisibility)
      ) {
        continue;
      }
      let byOrientation = groups.get(primitive.externalAssetSource);
      if (!defined(byOrientation)) {
        byOrientation = [[], []];
        groups.set(primitive.externalAssetSource, byOrientation);
      }
      const determinant = Matrix3.determinant(
        Matrix4.getMatrix3(runtimeNode.computedTransform, new Matrix3()),
      );
      const mirrored = determinant < 0.0;
      byOrientation[mirrored ? 1 : 0].push({ runtimeNode, runtimePrimitive });
    }
  }
  sceneGraph._externalAssetBatches = [];
  for (const byOrientation of groups.values()) {
    for (let orientation = 0; orientation < 2; orientation++) {
      const members = byOrientation[orientation];
      if (members.length < 2) {
        continue;
      }
      const node = new ModelComponents.Node();
      node.index = sceneGraph._runtimeNodes.length;
      node.matrix = Matrix4.clone(Matrix4.IDENTITY);
      if (orientation === 1) {
        // Keep winding uniform within each draw; ModelDrawCommand uses the
        // batch's reflected model matrix to select the appropriate cull face.
        node.matrix[0] = -1.0;
      }
      node.instances = new ModelComponents.Instances();
      const attribute = new ModelComponents.Attribute();
      attribute.count = members.length;
      attribute.componentDatatype = ComponentDatatype.FLOAT;
      node.instances.attributes.push(attribute);
      node.instances.transforms = members.map(({ runtimeNode }) =>
        Matrix4.multiplyTransformation(
          node.matrix,
          runtimeNode.computedTransform,
          new Matrix4(),
        ),
      );
      const runtimeNode = new ModelRuntimeNode({
        node,
        transform: node.matrix,
        transformToRoot: Matrix4.IDENTITY,
        children: [],
        sceneGraph,
      });
      const primitive = members[0].runtimePrimitive.primitive;
      node.primitives.push(primitive);
      runtimeNode.runtimePrimitives.push(
        new ModelRuntimePrimitive({
          primitive,
          node,
          model: sceneGraph._model,
        }),
      );
      for (const member of members) {
        member.runtimeNode.runtimePrimitives =
          member.runtimeNode.runtimePrimitives.filter(
            (value) => value !== member.runtimePrimitive,
          );
      }
      sceneGraph._runtimeNodes.push(runtimeNode);
      sceneGraph._rootNodes.push(node.index);
      sceneGraph._externalAssetBatches.push({ runtimeNode, members });
    }
  }
};

// Public node control needs independently rendered nodes. Restore those draws
// before the next pipeline build, retaining shared geometry and texture buffers.
ModelExternalAssetBatch.restore = function (sceneGraph) {
  const batches = sceneGraph._externalAssetBatches ?? [];
  if (batches.length === 0) {
    return;
  }
  for (const { runtimeNode, members } of batches) {
    for (const member of members) {
      member.runtimeNode.runtimePrimitives.push(member.runtimePrimitive);
    }
    sceneGraph._runtimeNodes[runtimeNode.node.index] = undefined;
    sceneGraph._rootNodes = sceneGraph._rootNodes.filter(
      (index) => index !== runtimeNode.node.index,
    );
  }
  sceneGraph._runtimeNodes.length = batches[0].runtimeNode.node.index;
  batches.length = 0;
  sceneGraph._model.resetDrawCommands();
};

export default ModelExternalAssetBatch;
