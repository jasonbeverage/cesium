import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import console from "node:console";
import { Buffer } from "node:buffer";
import { URL, fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(here, "../..");
if (!process.argv[2]) {
  throw new Error(
    "Usage: node Apps/ExternalAssetsPreview/server.mjs <model-directory> [port=8889]",
  );
}
const data = path.resolve(process.argv[2]);
const port = Number(process.argv[3] ?? 8889);
const requests = new Map();
const mime = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".gltf": "model/gltf+json",
  ".glb": "model/gltf-binary",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ktx2": "image/ktx2",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
};
function catalog() {
  const top = JSON.parse(
    fs.readFileSync(path.join(data, "tileset.json"), "utf8"),
  );
  const cells = fs
    .readdirSync(data)
    .filter((name) => /_lod0_.*\.gltf\.json$/.test(name))
    .map((name) => {
      const bounds = JSON.parse(fs.readFileSync(path.join(data, name), "utf8"));
      const stem = bounds.file.split("_lod0_")[0];
      const tileset = JSON.parse(
        fs.readFileSync(path.join(data, `${stem}.tileset.json`), "utf8"),
      );
      const b = bounds.content_bounds_min_max;
      const center = [(b[0] + b[3]) / 2, -(b[2] + b[5]) / 2, (b[1] + b[4]) / 2];
      const m = tileset.root.transform;
      const world = [0, 1, 2].map(
        (i) =>
          m[i] * center[0] +
          m[4 + i] * center[1] +
          m[8 + i] * center[2] +
          m[12 + i],
      );
      return {
        uri: bounds.file,
        stem,
        center: world,
        references: bounds.external_instances,
      };
    })
    .sort((a, b) => a.references - b.references);
  return {
    overview: top.root.boundingVolume.sphere,
    detail: cells[0],
    neighbor: cells[1],
    cells,
  };
}
http
  .createServer(async (req, res) => {
    try {
      const uri = decodeURIComponent(
        new URL(req.url, "http://localhost").pathname,
      );
      requests.set(uri, (requests.get(uri) ?? 0) + 1);
      if (uri === "/catalog" || uri === "/requests") {
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        res.end(
          JSON.stringify(
            uri === "/catalog" ? catalog() : Object.fromEntries(requests),
          ),
        );
        return;
      }
      const prefix = uri.startsWith("/prestige/")
        ? "/prestige/"
        : uri.startsWith("/cesium/")
          ? "/cesium/"
          : uri.startsWith("/environment/")
            ? "/environment/"
            : "/";
      const root =
        prefix === "/prestige/"
          ? data
          : prefix === "/cesium/"
            ? path.join(workspace, "Build/CesiumUnminified")
            : prefix === "/environment/"
              ? path.join(workspace, "Specs/Data/EnvironmentMap")
              : here;
      const filename = path.resolve(
        root,
        uri.slice(prefix.length) || "index.html",
      );
      if (!filename.startsWith(root + path.sep)) {
        throw new Error("Invalid path");
      }
      const size = fs.statSync(filename).size;
      const handle = fs.openSync(filename, "r");
      const magic = Buffer.alloc(2);
      fs.readSync(handle, magic, 0, 2, 0);
      fs.closeSync(handle);
      const gzip = magic[0] === 0x1f && magic[1] === 0x8b;
      const headers = {
        "Content-Type":
          mime[path.extname(filename)] ?? "application/octet-stream",
        "Content-Length": size,
        "Cache-Control":
          prefix === "/prestige/" && !filename.endsWith(".json")
            ? "public, max-age=3600"
            : "no-store",
      };
      if (gzip) {
        headers["Content-Encoding"] = "gzip";
      }
      res.writeHead(200, headers);
      if (req.method === "HEAD") {
        res.end();
      } else {
        fs.createReadStream(filename).pipe(res);
      }
    } catch (error) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end(error.message);
      console.error(req.url, error.message);
    }
  })
  .listen(port, "127.0.0.1", () =>
    console.log(`Cesium external asset preview: http://127.0.0.1:${port}`),
  );
