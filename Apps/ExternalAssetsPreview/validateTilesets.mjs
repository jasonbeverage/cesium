import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import console from "node:console";

const directory = path.resolve(process.argv[2]);
const files = fs
  .readdirSync(directory)
  .filter((name) => /(?:\.tileset|^tileset(?:-lod0)?)\.json$/.test(name));
let contentReferences = 0;
let boundsChecked = 0;
function contains(parent, child) {
  return (
    Math.hypot(...parent.slice(0, 3).map((c, i) => c - child[i])) + child[3] <=
    parent[3] + 1e-7
  );
}
function checkTile(tile) {
  const sphere = tile.boundingVolume.sphere;
  assert.equal(sphere.length, 4);
  assert(sphere.every(Number.isFinite) && sphere[3] >= 0);
  for (const child of tile.children ?? []) {
    assert(
      contains(sphere, child.boundingVolume.sphere),
      "Parent bounds contain child bounds",
    );
    assert(tile.geometricError >= child.geometricError);
    checkTile(child);
  }
  if (tile.content) {
    const target = path.join(directory, tile.content.uri);
    assert(fs.existsSync(target), target);
    contentReferences++;
    if (target.endsWith(".gltf")) {
      const sidecar = JSON.parse(fs.readFileSync(`${target}.json`, "utf8"));
      for (const bounds of [
        sidecar.cell_bounds_min_max,
        sidecar.content_bounds_min_max,
      ]) {
        for (let corner = 0; corner < 8; corner++) {
          const x = bounds[corner & 1 ? 3 : 0];
          const y = bounds[corner & 2 ? 4 : 1];
          const z = bounds[corner & 4 ? 5 : 2];
          assert(
            contains(sphere, [x, -z, y, 0]),
            "Sidecar bounds fit the leaf sphere",
          );
        }
        boundsChecked++;
      }
    }
  }
}
for (const name of files) {
  const json = JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"));
  assert.equal(json.asset.version, "1.1");
  checkTile(json.root);
}
const manifests = fs
  .readdirSync(directory)
  .filter((name) => /_lod0_tiles_manifest\.json$/.test(name));
assert(manifests.length > 0, "Sidecar manifests are present");
const cells = manifests.reduce(
  (count, name) =>
    count +
    JSON.parse(fs.readFileSync(path.join(directory, name), "utf8")).tiles
      .length,
  0,
);
assert.equal(files.length, manifests.length * 2 + 2);
assert.equal(boundsChecked, cells * 4);
console.log(
  JSON.stringify({
    tilesets: files.length,
    contentReferences,
    sidecarBoundsChecked: boundsChecked,
    passed: true,
  }),
);
