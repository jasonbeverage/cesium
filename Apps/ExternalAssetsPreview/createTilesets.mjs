import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import console from "node:console";

const directory = path.resolve(process.argv[2]);
const lod2Error = Number(process.argv[3] ?? 16);
const lod1Error = Number(process.argv[4] ?? 0.5);
const radians = (degrees) => (degrees * Math.PI) / 180;
function frame(stem) {
  const [, zoom, x, y] = /tile_(\d+)_(\d+)_(\d+)/.exec(stem).map(Number);
  const n = 2 ** zoom;
  const latitude = (row) => Math.atan(Math.sinh(Math.PI * (1 - (2 * row) / n)));
  const lon = ((((x + 0.5) / n) * 360 - 180) * Math.PI) / 180;
  const lat = (latitude(y) + latitude(y + 1)) / 2;
  const a = 6378137;
  const e2 = 0.0066943799901413165;
  const v = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
  return {
    longitude: lon / radians(1),
    latitude: lat / radians(1),
    transform: [
      -Math.sin(lon),
      Math.cos(lon),
      0,
      0,
      -Math.sin(lat) * Math.cos(lon),
      -Math.sin(lat) * Math.sin(lon),
      Math.cos(lat),
      0,
      Math.cos(lat) * Math.cos(lon),
      Math.cos(lat) * Math.sin(lon),
      Math.sin(lat),
      0,
      v * Math.cos(lat) * Math.cos(lon),
      v * Math.cos(lat) * Math.sin(lon),
      v * (1 - e2) * Math.sin(lat),
      1,
    ],
  };
}
function sphere(bounds) {
  if (bounds.length !== 6 || !bounds.every(Number.isFinite)) {
    throw new Error("Invalid bounds");
  }
  const center = [0, 1, 2].map((i) => (bounds[i] + bounds[i + 3]) / 2);
  const radius = Math.hypot(
    ...[0, 1, 2].map((i) => (bounds[i + 3] - bounds[i]) / 2),
  );
  // glTF is Y-up. 3D Tiles volumes use the Z-up frame after glTF axis correction.
  return [center[0], -center[2], center[1], radius];
}
function worldSphere(local, transform) {
  const result = [0, 0, 0, local[3]];
  for (let i = 0; i < 3; i++) {
    result[i] =
      transform[i] * local[0] +
      transform[4 + i] * local[1] +
      transform[8 + i] * local[2] +
      transform[12 + i];
  }
  return result;
}
function enclosing(spheres) {
  const center = [0, 1, 2].map(
    (i) => spheres.reduce((sum, s) => sum + s[i], 0) / spheres.length,
  );
  return [
    ...center,
    Math.max(
      ...spheres.map(
        (s) => Math.hypot(...center.map((c, i) => c - s[i])) + s[3],
      ),
    ),
  ];
}
function unionBounds(...bounds) {
  const available = bounds.filter(Boolean);
  return [0, 1, 2]
    .map((i) => Math.min(...available.map((b) => b[i])))
    .concat([3, 4, 5].map((i) => Math.max(...available.map((b) => b[i]))));
}
function write(name, json) {
  fs.writeFileSync(
    path.join(directory, name),
    `${JSON.stringify(json, null, 2)}\n`,
  );
}
const manifests = fs
  .readdirSync(directory)
  .filter((name) => /_lod0_tiles_manifest\.json$/.test(name))
  .sort();
const groups = [];
for (const name of manifests) {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(directory, name), "utf8"),
  );
  const stem = name.replace(/_lod0_tiles_manifest\.json$/, "");
  const placement = frame(stem);
  const cells = manifest.tiles.map((tile) => {
    const sidecar = JSON.parse(
      fs.readFileSync(path.join(directory, `${tile.file}.json`), "utf8"),
    );
    if (sidecar.up_axis !== "Y") {
      throw new Error(`Unsupported up axis in ${tile.file}`);
    }
    const bounds = unionBounds(
      sidecar.cell_bounds_min_max,
      sidecar.content_bounds_min_max,
    );
    return { tile, sphere: sphere(bounds) };
  });
  const localSphere = enclosing([
    sphere(manifest.scene_bounds_min_max),
    ...cells.map((cell) => cell.sphere),
  ]);
  const leaves = cells.map(({ tile, sphere }) => ({
    boundingVolume: { sphere },
    geometricError: 0,
    content: { uri: tile.file },
  }));
  const children = leaves.map((leaf) => {
    const lod1 = leaf.content.uri
      .replace("_lod0_", "_lod1_")
      .replace(/\.gltf$/, ".glb");
    return fs.existsSync(path.join(directory, lod1))
      ? {
          boundingVolume: leaf.boundingVolume,
          geometricError: lod1Error,
          refine: "REPLACE",
          content: { uri: lod1 },
          children: [leaf],
        }
      : leaf;
  });
  const lod2 = `${stem}_lod2.glb`;
  const root = {
    boundingVolume: { sphere: localSphere },
    transform: placement.transform,
    geometricError: lod2Error,
    refine: "REPLACE",
    children,
  };
  if (fs.existsSync(path.join(directory, lod2))) {
    root.content = { uri: lod2 };
  }
  write(`${stem}.tileset.json`, {
    asset: { version: "1.1" },
    geometricError: 10000,
    root,
    extras: {
      sourceBounds: name,
      ...placement,
      lod2ErrorMeters: lod2Error,
      lod1ErrorMeters: lod1Error,
    },
  });
  write(`${stem}.lod0.tileset.json`, {
    asset: { version: "1.1" },
    geometricError: 10000,
    root: {
      ...root,
      content: undefined,
      geometricError: 10000,
      children: leaves,
    },
  });
  groups.push({
    stem,
    placement,
    sphere: worldSphere(localSphere, placement.transform),
    cells: cells.length,
  });
}
if (groups.length === 0) {
  throw new Error("No LOD0 sidecar manifests found");
}
for (const lod0 of [false, true]) {
  write(lod0 ? "tileset-lod0.json" : "tileset.json", {
    asset: { version: "1.1" },
    geometricError: 10000,
    root: {
      boundingVolume: {
        sphere: enclosing(groups.map((group) => group.sphere)),
      },
      geometricError: 10000,
      refine: "REPLACE",
      children: groups.map((group) => ({
        boundingVolume: { sphere: group.sphere },
        geometricError: 10000,
        content: { uri: `${group.stem}${lod0 ? ".lod0" : ""}.tileset.json` },
      })),
    },
    extras: {
      source: "Tile bounds sidecars",
      geographicTiles: groups.length,
      cells: groups.reduce((sum, group) => sum + group.cells, 0),
    },
  });
}
const report = {
  directory,
  groups: groups.length,
  cells: groups.reduce((sum, group) => sum + group.cells, 0),
  manifests: groups.length * 2 + 2,
};
console.log(JSON.stringify(report));
