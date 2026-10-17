import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

if (process.platform !== 'win32') throw Error('Native artifact build requires Windows x64.');
const root = resolve(import.meta.dirname, '../..');
const run = `run-${process.env.GITHUB_RUN_ID ?? 'local'}-${process.env.GITHUB_RUN_ATTEMPT ?? '1'}-${randomUUID().slice(0, 8)}`;
const directory = join(root, '.tmp/ci-native', run);
const artifact = join(directory, 'artifact');
await mkdir(artifact, { recursive: true });
const identifier = `com.zone.player.ci.${run}`;
const configuration = join(directory, 'tauri.ci.json');
await writeFile(configuration, JSON.stringify({ identifier, productName: 'Zone CI' }, null, 2));
const log = join(directory, 'native-build.log');
const args = [join(root, 'node_modules/@tauri-apps/cli/tauri.js'), 'build', '--no-bundle', '--config', configuration, '--', '--locked'];
const child = spawn(process.execPath, args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let writes = Promise.resolve();
for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
  process.stdout.write(chunk);
  writes = writes.then(() => appendFile(log, chunk));
});
const status = await new Promise((yes, no) => { child.on('error', no); child.on('exit', yes); });
await writes;
if (status !== 0) throw Error(`Native build failed (${status}); see ${log}`);
const executable = resolve(process.env.CARGO_TARGET_DIR ?? join(root, 'src-tauri/target'), 'release/zone-player.exe');
const binary = await readFile(executable);
if (!binary.includes(Buffer.from(identifier))) throw Error('Built executable does not contain this isolated CI identity.');
const sha256 = value => createHash('sha256').update(value).digest('hex');
await copyFile(executable, join(artifact, 'zone-player.exe'));
await copyFile(join(root, 'packaging/THIRD_PARTY_NOTICES.txt'), join(artifact, 'THIRD_PARTY_NOTICES.txt'));
await copyFile(join(root, 'src-tauri/Cargo.lock'), join(artifact, 'Cargo.lock'));
const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const manifest = { format: 'ZoneNativeCI', version: 1, identifier, sourceSha,
  applicationVersion: JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version,
  executable: 'zone-player.exe', executableSha256: sha256(binary), configurationSha256: sha256(await readFile(configuration)),
  createdAt: new Date().toISOString(), architecture: process.arch,
  note: 'Unsigned CI executable with isolated data identity. Requires Windows x64 and WebView2. Not a Store package or release.' };
const manifestPath = join(artifact, 'build-info.json');
await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
await writeFile(join(root, '.tmp/ci-native/latest.json'), JSON.stringify({ manifest: manifestPath }, null, 2));
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `artifact=${artifact}\nmanifest=${manifestPath}\n`);
console.log(JSON.stringify({ artifact, manifest: manifestPath, sourceSha, executableSha256: manifest.executableSha256 }));
