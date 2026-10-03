import { build } from "esbuild";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs, createWriteStream } from "node:fs";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { summarizeResources, summarizeResourceStages } from "./native/podcastStabilityResources.mjs";

const execute = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const argument = (name, fallback) => args.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const minutes = Number(argument("minutes", "120"));
const cycles = Number(argument("cycles", "200"));
const crashDelayMs = Number(argument("crash-delay-ms", "10000"));
const switchRounds = Number(argument("switch-rounds", "1"));
const requestedPhase = argument("phase", "all");
if (!["all", "network", "short", "crash-playback", "crash-download", "soak"].includes(requestedPhase)) throw Error("Unknown stability phase");
if (process.platform !== "win32") throw Error("Native podcast stability tests require Windows and WebView2");
if (!Number.isInteger(minutes) || minutes < 1 || minutes > 240 || !Number.isInteger(cycles) || cycles < 1 || cycles > 2000) throw Error("Invalid bounded duration or cycle count");
if (!Number.isInteger(crashDelayMs) || crashDelayMs < 0 || crashDelayMs > 30000) throw Error("Invalid crash delay");
if (!Number.isInteger(switchRounds) || switchRounds < 1 || switchRounds > 5) throw Error("Invalid switch rounds");
const target = path.resolve(argument("target-dir", path.join(root, ".tmp", "podcast-stability-target")));
const report = path.join(root, ".tmp", "podcast-stability", `${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${process.pid}`);
const workspace = path.join(report, "native");
const ownedChildren = new Set();
async function terminateOwnedChildren() {
  for (const child of ownedChildren) {
    if (child.exitCode === null && child.pid) await execute("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }).catch(() => {});
  }
}
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, async () => { await terminateOwnedChildren(); process.exit(130); });
function replaceOnce(source, oldText, newText) {
  if (source.split(oldText).length !== 2) throw Error(`Fixture source anchor changed: ${oldText}`);
  return source.replace(oldText, newText);
}
await fs.mkdir(report, { recursive: true });
const suppliedExecutable = argument("executable", "");
let executable;
if (suppliedExecutable) {
  executable = path.resolve(suppliedExecutable);
  const preparedPath = path.join(path.dirname(path.dirname(executable)), "prepared.json");
  const prepared = JSON.parse(await fs.readFile(preparedPath, "utf8"));
  if (prepared.executable !== executable || !executable.startsWith(path.join(root, ".tmp", "podcast-stability") + path.sep)) throw Error("Use a prepared isolated fixture executable");
} else {
await fs.mkdir(workspace, { recursive: true });
await fs.cp(path.join(root, "src-tauri"), workspace, { recursive: true, filter: source =>
  !["target", "gen", ".cargo", ".tauri"].includes(path.basename(source)) });
const configurationPath = path.join(workspace, "tauri.conf.json");
const configuration = JSON.parse(await fs.readFile(configurationPath, "utf8"));
configuration.identifier = "com.zone.player.podcast.stability";
configuration.build.frontendDist = path.join(root, "dist");
configuration.app.windows = [];
configuration.bundle.resources = { [path.join(root, "packaging", "THIRD_PARTY_NOTICES.txt")]: "THIRD_PARTY_NOTICES.txt" };
await fs.writeFile(configurationPath, JSON.stringify(configuration, null, 2));
await fs.copyFile(path.join(root, "tests", "native", "podcastStability.rs"), path.join(workspace, "src", "podcastStability.rs"));
const lib = path.join(workspace, "src", "lib.rs");
await fs.writeFile(lib, `#[path = "podcastStability.rs"] mod podcast_stability;\n${replaceOnce(await fs.readFile(lib, "utf8"), "pub fn run() {", "#[allow(unreachable_code)]\npub fn run() { podcast_stability::run(); return;")}`);
const modulePath = path.join(workspace, "src", "podcast", "mod.rs");
await fs.writeFile(modulePath, replaceOnce(await fs.readFile(modulePath, "utf8"), "mod stream_protocol;", "pub(crate) mod stream_protocol;"));
for (const [file, functionName] of [["stream_protocol.rs", "serve_podcast_stream_protocol_with_network_policy"], ["downloads.rs", "download_episode_with_network_policy"]]) {
  const destination = path.join(workspace, "src", "podcast", file);
  await fs.writeFile(destination, replaceOnce(await fs.readFile(destination, "utf8"), `async fn ${functionName}(`, `pub(crate) async fn ${functionName}(`));
}
await build({ entryPoints: [path.join(root, "tests", "native", "podcastStability.tsx")],
  outfile: path.join(workspace, "src", "podcastStability.js"), loader: { ".woff2": "dataurl", ".woff": "dataurl", ".ttf": "dataurl", ".svg": "dataurl", ".png": "dataurl" }, bundle: true, format: "iife", platform: "browser",
  define: { "import.meta.env.DEV": "false", "process.env.NODE_ENV": '"production"' } });
async function command(executable, commandArgs, log) {
  const stream = createWriteStream(log);
  const child = spawn(executable, commandArgs, { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  ownedChildren.add(child);
  child.stdout.pipe(stream, { end: false }); child.stderr.pipe(stream, { end: false });
  const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("exit", resolve); });
  ownedChildren.delete(child); stream.end(); if (code !== 0) throw Error(`Command failed (${code}); see ${log}`);
}
console.log(`原生测试构建；报告目录：${report}`);
await command(process.execPath, [path.join(root, "node_modules", "typescript", "bin", "tsc"), "--noEmit", "--target", "ES2020", "--module", "ESNext", "--moduleResolution", "Node", "--jsx", "react-jsx", "--strict", "--esModuleInterop", "--skipLibCheck", "--lib", "DOM,DOM.Iterable,ES2020", "src/vite-env.d.ts", "tests/native/podcastStability.tsx"], path.join(report, "typecheck.log"));
await command("cargo", ["build", "--offline", "--manifest-path", path.join(workspace, "Cargo.toml"), "--target-dir", target], path.join(report, "build.log"));
const bin = path.join(report, "bin"); await fs.mkdir(bin);
executable = path.join(bin, "zone-player.exe");
await fs.copyFile(path.join(target, "debug", "zone-player.exe"), executable);
for (const dll of ["vcruntime140.dll", "vcruntime140_1.dll"]) {
  await fs.copyFile(path.join(process.env.WINDIR ?? "C:\\Windows", "System32", dll), path.join(bin, dll));
}
}
const bin = path.dirname(executable);
await fs.writeFile(path.join(report, "prepared.json"), JSON.stringify({ report, executable, minutes, cycles }, null, 2));
if (args.includes("--prepare-only")) { console.log(JSON.stringify({ report, executable })); process.exit(0); }
async function freePort() {
  const server = net.createServer(); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function readJson(file) { try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return null; } }
async function runPhase(phase, directory, port) {
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "config.json"), JSON.stringify({ phase, durationMs: minutes * 60000, cycles, port, crashDelayMs, switchRounds }));
  const child = spawn(executable, [], { cwd: bin, windowsHide: true,
    env: { ...process.env, ZONE_PODCAST_STABILITY_DIR: directory }, stdio: ["ignore", "pipe", "pipe"] });
  let code;
  child.on("exit", value => { code = value; ownedChildren.delete(child); });
  ownedChildren.add(child);
  await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  const log = createWriteStream(path.join(directory, `${phase}.log`)); child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  await fs.writeFile(path.join(directory, "process.json"), JSON.stringify({ pid: child.pid, executable, phase }));
  const sampler = spawn("powershell.exe", ["-NoProfile", "-File", path.join(root, "tests", "native", "samplePodcastProcess.ps1"),
    "-RootPid", String(child.pid), "-ExpectedExecutable", executable, "-OutputPath", path.join(directory, `${phase}-resources.jsonl`)], { windowsHide: true, stdio: "ignore" });
  ownedChildren.add(sampler); sampler.on("exit", () => ownedChildren.delete(sampler));
  sampler.on("error", error => console.error(`Resource sampler failed: ${error}`));
  const started = Date.now(); let printed = 0;
  while (code === undefined) {
    if (phase.startsWith("crash") && await readJson(path.join(directory, "checkpoint.json"))) {
      await delay(1100);
      if (code === undefined) await execute("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
      await delay(500); log.end(); sampler.kill();
      console.log(`${phase}：已强制终止隔离进程树`);
      return { phase, intentionallyTerminated: true, checkpoint: await readJson(path.join(directory, "checkpoint.json")) };
    }
    if (Date.now() - printed > 45000) {
      console.log(`${phase}：已运行 ${Math.round((Date.now() - started) / 1000)} 秒`); printed = Date.now();
    }
    await delay(1000);
  }
  log.end(); sampler.kill();
  const result = await readJson(path.join(directory, "result.json"));
  console.log(`${phase}：${result?.ok ? "通过" : "失败"}`);
  if (code !== 0 || !result?.ok) throw Error(`${phase} failed: ${JSON.stringify(result)}; ${directory}`);
  const resourcesFile = path.join(directory, `${phase}-resources.jsonl`);
  return { phase, ...result, resources: await summarizeResources(resourcesFile), resourceStages: await summarizeResourceStages(resourcesFile, path.join(directory, "events.jsonl")) };
}
const outcomes = [];
try {
  const phases = requestedPhase === "all" ? ["short", "crash-playback", "crash-download", "soak"] : [requestedPhase];
  for (const phase of phases) {
    const directory = path.join(report, phase); const port = await freePort();
    outcomes.push(await runPhase(phase, directory, port));
    if (phase.startsWith("crash")) outcomes.push(await runPhase(phase.replace("crash", "restore"), directory, port));
  }
  await fs.writeFile(path.join(report, "summary.json"), JSON.stringify({ ok: true, outcomes }, null, 2));
  console.log(`测试完成：${report}`);
} catch (error) {
  await terminateOwnedChildren();
  await fs.writeFile(path.join(report, "summary.json"), JSON.stringify({ ok: false, error: String(error), outcomes }, null, 2));
  throw error;
}
