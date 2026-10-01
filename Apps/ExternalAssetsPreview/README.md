# Prestige external asset preview

The preview is available at http://127.0.0.1:8889/. It serves the original model files and the Cesium build in this checkout.

To restart from the checkout root:

```powershell
npx gulp build
node Apps/ExternalAssetsPreview/server.mjs C:/dev/Prestige/models/prestige
```

`Overview`, `Detail`, and `Next tile` move the camera through the LOD hierarchy. `Show tile bounds` displays the generated bounding volumes. `Release unused tiles` trims the tile cache while retaining resources still referenced by visible tiles. The counters describe the currently selected tiles; draw commands include ordinary local meshes and LOD proxies in addition to external asset batches.

The globe now uses ArcGIS World Imagery over Cesium World Terrain. The sun and sky atmosphere are visible, terrain receives building shadows, and the tileset casts and receives soft cascaded shadows. `Skyline`, `PNC Park`, and `Steelers stadium` select presentation cameras; `Clean view for screenshot` hides the diagnostic panel while preserving credits. `Show controls` brings it back.

`Render quality` defaults to `Smooth`: request up to 8× MSAA (Cesium clamps this to the current GPU's supported maximum), enable FXAA, and render at 1.5× the canvas display dimensions in each axis. The status reports the clamped sample count. `Standard` uses up to 4× MSAA, no FXAA, and a 1× render scale. `Extra sharp` uses the same MSAA and FXAA as Smooth with a 2× render scale. WebGL1 falls back to FXAA and increased render resolution. The larger render targets use more GPU memory and pixel processing; 1.5× and 2× render scales draw 2.25× and 4× as many pixels respectively. MSAA primarily smooths geometry coverage, while rendering more pixels also reduces aliasing within shading and textures. Extremely dense repeated detail can still alias.

Optional preview parameters `view=steelers`, `sunTime=10.95`, and `shadows=false` can restore a view preset and lighting selections during a reload.

Lighting starts at 8:00 AM EDT on September 30, 2026, with a clock-driven SunLight so the visible sun and cast shadows agree. The clock is paused. Ambient fill is 65% for the backlit sunrise view, using diffuse spherical harmonics and the locally served Kiara afternoon prefiltered reflection map from Cesium's test data. This fixed reflection environment is a material inspection aid, rather than a time-matched sunrise environment. HDR and PBR neutral tonemapping are enabled. The source materials are preserved.

Adjust `Sun time (EDT)`, `Key light`, and `PBR environment` to tune the presentation. `Cast shadows` toggles the shadow map. Editing `Light angle` switches to the manual directional light; `Use the visible sun` restores physical sun direction. For the earlier directional material comparison, turn off `Use the visible sun`, reduce `PBR environment` to 5%, and compare 135 and 315 degrees from the same camera. Environment strengths stay positive so adjustments update uniforms without rebuilding all tile pipelines.

The source glTF, GLB, and buffer files are gzip-compressed in place. The server detects this and sends `Content-Encoding: gzip`; other servers must send the same header. It leaves the original files untouched.

## Generated tilesets

`C:/dev/Prestige/models/prestige/tileset.json` combines four geographic tiles with LOD2 → LOD1 → LOD0 refinement. `tileset-lod0.json` combines the 36 fine cells directly. Each geographic tile also has a `.tileset.json` and a `.lod0.tileset.json`.

The sidecars contain Y-up bounding boxes. The converter encloses their grid and content bounds in conservative spheres, rotates volumes to the Z-up frame used by 3D Tiles, and places each geographic tile in its WGS84 east/north/up frame. Placement follows the exporter source's slippy-tile center calculation.

LOD2 and LOD1 geometric errors are test values of 16 and 0.5 meters. They are configurable, rather than measured simplification errors:

```powershell
node Apps/ExternalAssetsPreview/createTilesets.mjs C:/dev/Prestige/models/prestige 16 0.5
node Apps/ExternalAssetsPreview/validateTilesets.mjs C:/dev/Prestige/models/prestige
```

Validation checked all ten tilesets, their content paths, hierarchy bounds, and the corners of every sidecar box. The engine implementation is independent of this exporter and its filenames.
