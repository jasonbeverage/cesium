# External assets

This fixture follows the [glTF 2.1 external assets draft](https://github.com/KhronosGroup/glTF/pull/2618). Two nodes reference one file, the existing glTF 2.0 `BoxTextured.glb` fixture. The corresponding `Specs/Data/Cesium3DTiles/ExternalAssets/tileset.json` loads this composition in two tiles.

External assets load through the ordinary `Model.fromGltfAsync` and 3D Tiles paths. The loader supports glTF and GLB files supplied by a URI, data URI, or buffer view, recursive references, and exact URI aliases in `files[].aliases`. Embedded asset dependencies resolve relative to their containing asset. A referenced asset's default scene is attached after a referencing node's existing children; assets without a default scene attach nothing. Cycles and invalid file references report loading errors.

The resource cache shares downloaded JSON, decoded geometry, GPU buffers, and textures across referencing models, with reference counting for unloading. Repeated static triangle primitives within a model use instanced draws with affine transforms, including nonuniform scale, shear, and reflection. Batches stay within each tile to preserve culling, selection, and lifecycle behavior.

Animated, skinned, articulated, morphing, translucent, feature-bearing, edge-visible, classification, and imagery-draped content retains the ordinary draw path and shared resources. Existing `EXT_mesh_gpu_instancing` content also retains its own instancing. Public `ModelNode` transform or visibility edits restore individual draws. Devices without hardware instancing or enough vertex attributes use individual draws as well.

This is support for the draft external assets functionality, rather than all proposed glTF 2.1 features. It contains no exporter-specific behavior.
