import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const read = path => readFileSync(new URL(path, root), "utf8");
const save = (path, value) => writeFileSync(new URL(path, root), value);
const config = JSON.parse(read("src-tauri/tauri.conf.json"));
const requested = process.argv[2] === "--set" ? process.argv[3] : undefined;
if (requested !== undefined) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(requested)) throw Error("版本必须为三段非负整数，例如 0.1.2");
  config.version = requested;
  save("src-tauri/tauri.conf.json", JSON.stringify(config, null, 2) + "\n");
  for (const path of ["package.json", "package-lock.json"]) {
    const value = JSON.parse(read(path)); value.version = requested;
    if (value.packages?.[""]) value.packages[""].version = requested;
    save(path, JSON.stringify(value, null, 2) + "\n");
  }
  save("src-tauri/Cargo.toml", read("src-tauri/Cargo.toml").replace(/^(version\s*=\s*)"[^"]+"/m, `$1"${requested}"`));
  save("src-tauri/Cargo.lock", read("src-tauri/Cargo.lock").replace(/(\[\[package\]\]\r?\nname = "zone-player"\r?\nversion = )"[^"]+"/, `$1"${requested}"`));
  save("src/app/releaseInfo.ts", read("src/app/releaseInfo.ts").replace(/(APP_VERSION = )"[^"]+"/, `$1"${requested}"`));
}
const versions = [JSON.parse(read("package.json")).version, JSON.parse(read("package-lock.json")).version,
  read("src-tauri/Cargo.toml").match(/^version\s*=\s*"([^"]+)"/m)?.[1], read("src/app/releaseInfo.ts").match(/APP_VERSION = "([^"]+)"/)?.[1],
  read("src-tauri/Cargo.lock").match(/\[\[package\]\]\r?\nname = "zone-player"\r?\nversion = "([^"]+)"/)?.[1]];
if (versions.some(version => version !== config.version)) throw Error(`版本号不一致：${config.version} / ${versions.join(" / ")}`);
if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(`Zone ${config.version}：版本号一致`);
