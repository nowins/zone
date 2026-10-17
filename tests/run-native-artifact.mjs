import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { hash, validateArtifact, writeWave } from './native/artifactSupport.mjs';

if (process.platform !== 'win32') throw Error('Native artifact smoke requires a Windows desktop and WebView2.');
const root = resolve(import.meta.dirname, '..');
const argument = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const suppliedManifest = argument('manifest', undefined);
const manifestPath = suppliedManifest ?? JSON.parse(await readFile(join(root, '.tmp/ci-native/latest.json'), 'utf8')).manifest;
const { manifest, executable } = await validateArtifact(resolve(manifestPath));
const report = resolve(argument('report', join(dirname(dirname(executable)), 'smoke')));
await mkdir(report, { recursive: true });
const driverPath = resolve(argument('driver', join(root, '.tmp/ci-tools/msedgedriver.exe')));
if (!existsSync(driverPath)) throw Error('Run scripts/ci/setup-webdriver.ps1 first.');
// Refuse existing profiles before launching anything, even on a developer machine.
const dataDirectory = join(process.env.APPDATA, manifest.identifier);
const localDirectory = join(process.env.LOCALAPPDATA, manifest.identifier);
if ([dataDirectory, localDirectory].some(existsSync)) throw Error('CI application data already exists; build a fresh isolated identity.');
const media = join(report, 'media');
await mkdir(media);
const paths = [join(media, 'CI Sample One.wav'), join(media, 'CI Sample Two.wav')];
const originalHashes = await Promise.all(paths.map(writeWave));
const server = createServer();
await new Promise(yes => server.listen(0, '127.0.0.1', yes));
const port = server.address().port;
await new Promise(yes => server.close(yes));
const address = `http://127.0.0.1:${port}`;
const log = createWriteStream(join(report, 'webdriver-stdio.log'));
const driver = spawn(driverPath, [`--port=${port}`, '--host=127.0.0.1', '--allowed-ips=127.0.0.1', '--verbose', `--log-path=${join(report, 'webdriver.log')}`], {
  windowsHide: true, env: { ...process.env, TAURI_WEBVIEW_AUTOMATION: 'true' }, stdio: ['ignore', 'pipe', 'pipe'],
});
driver.stdout.pipe(log, { end: false }); driver.stderr.pipe(log, { end: false });
let driverError;
driver.on('error', error => { driverError = error; });
let session;
const steps = [];
const outcome = { sourceSha: manifest.sourceSha, executableSha256: manifest.executableSha256, identifier: manifest.identifier,
  startedAt: new Date().toISOString(), ok: false, steps,
  coverage: { core: false, sqliteLock: false, unavailableSource: false },
  boundaries: ['No audible-output, device-switch, sleep, installer, Store signing or upgrade claims.',
    'Real release executable, WebView2, Rust commands, SQLite and local audio protocol; no IPC mocks or replacement frontend.'] };
async function record(name, details = {}) { steps.push({ name, at: new Date().toISOString(), ...details }); console.log(name); }
async function request(method, path, body, timeout = 90000) {
  if (driverError) throw driverError;
  const response = await fetch(address + path, { method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(timeout) });
  const value = await response.json();
  if (!response.ok || value.value?.error) throw Error(`${method} ${path}: ${JSON.stringify(value.value ?? value)}`);
  return value.value;
}
async function until(check, label, timeout = 30000) {
  const end = Date.now() + timeout; let last;
  do {
    try { const value = await check(); if (value) return value; } catch (error) { last = error; }
    await new Promise(yes => setTimeout(yes, 200));
  } while (Date.now() < end);
  throw Error(`${label} timed out${last ? `: ${last.message}` : ''}`);
}
const command = (method, path, body) => request(method, `/session/${session}${path}`, body);
const script = (fn, ...args) => command('POST', '/execute/sync', { script: `return (${fn.toString()})(...arguments);`, args });
async function asynchronous(fn, ...args) {
  const result = await command('POST', '/execute/async', { script: `const done = arguments[arguments.length - 1];
    Promise.resolve().then(() => (${fn.toString()})(...Array.from(arguments).slice(0,-1)))
      .then(value => done({ok:true,value}), error => done({ok:false,error:String(error)}));`, args });
  if (!result.ok) throw Error(result.error);
  return result.value;
}
const invoke = (name, args = {}) => asynchronous((command, args) => window.__TAURI_INTERNALS__.invoke(command, args), name, args);
async function click(using, value) {
  await until(async () => {
    const element = await command('POST', '/element', { using, value });
    const id = element['element-6066-11e4-a52e-4f735466cecf'];
    await command('POST', `/element/${id}/click`, {});
    return true;
  }, value);
}
const clickText = (scope, text) => click('xpath', `${scope}//button[normalize-space(.)='${text}']`);
async function screenshot(name) {
  const bytes = await command('GET', '/screenshot');
  await writeFile(join(report, `${name}.png`), Buffer.from(bytes, 'base64'));
}
function ownedProcesses() {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command',
    "@(Get-CimInstance Win32_Process -Filter \"Name='zone-player.exe'\" | Where-Object { $_.ExecutablePath -eq $env:ZONE_CI_TEST_APP } | Select-Object -ExpandProperty ProcessId) | ConvertTo-Json -Compress"],
  { windowsHide: true, env: { ...process.env, ZONE_CI_TEST_APP: executable }, encoding: 'utf8', timeout: 15000 });
  if (result.status !== 0) throw Error(`Cannot inspect the owned application process: ${result.stderr}`);
  const value = result.stdout.trim() ? JSON.parse(result.stdout) : [];
  return Array.isArray(value) ? value : [value];
}
async function launch() {
  const created = await request('POST', '/session', { capabilities: { alwaysMatch: { browserName: 'webview2',
    'ms:edgeOptions': { binary: executable, webviewOptions: { userDataFolder: join(report, 'webview-profile') } } } } });
  session = created.sessionId;
  outcome.capabilities = created.capabilities;
  await command('POST', '/timeouts', { implicit: 0, script: 60000, pageLoad: 60000 });
  await until(() => script(() => Boolean(document.querySelector('.quickplay')) && !document.querySelector('.startup-loading')), 'Real application ready');
  assert.equal(await script(() => typeof window.__TAURI_INTERNALS__.invoke), 'function');
  assert.equal(ownedProcesses().length, 1, 'Exactly one owned native application must be running.');
}
async function closeNormally() {
  // This is a real window-control click; DELETE session is only later cleanup.
  await click('css selector', '.titlebar-settings');
  await clickText('//nav[@aria-label="设置分区"]', '常规');
  if (await script(() => document.querySelector('.settings-general [role="switch"]').getAttribute('aria-checked') === 'true')) {
    await click('css selector', '.settings-general [role="switch"]');
  }
  await until(() => script(() => Boolean(document.querySelector('.window-controls button[title="关闭"]'))), 'Exit preference applied');
  assert.equal(ownedProcesses().length, 1);
  let clickError;
  try { await click('css selector', '.window-controls button[title="关闭"]'); } catch (error) { clickError = error; }
  await until(() => ownedProcesses().length === 0, 'Native process exited through window control', 15000);
  if (clickError && !/no such window|invalid session|disconnected|web view not found|not connected/i.test(clickError.message)) throw clickError;
  await record('Native application exited through its real close control');
  await request('DELETE', `/session/${session}`).catch(() => {});
  session = undefined;
}
try {
  assert.equal(ownedProcesses().length, 0, 'Refuse an already running artifact.');
  await until(() => request('GET', '/status', undefined, 3000), 'WebDriver ready', 15000);
  await launch();
  await record('This build launched with an empty isolated library');
  assert.equal((await invoke('music_get_library_snapshot')).tracks.length, 0);
  await screenshot('01-empty');
  const scan = await asynchronous(async folder => {
    const api = window.__TAURI_INTERNALS__;
    const progress = api.transformCallback(() => {});
    try { return await api.invoke('music_scan_library', { folders: [{ path: folder, name: 'CI fixture' }], progress: `__CHANNEL__:${progress}` }); }
    finally { api.unregisterCallback(progress); }
  }, media);
  assert.equal(scan.tracks.length, 2);
  assert.ok(scan.tracks.every(track => paths.includes(track.path)), 'Scan must contain only generated fixture audio.');
  await command('POST', '/refresh', {});
  await until(() => script(() => Boolean(document.querySelector('.quickplay'))), 'Application restored scanned library');
  await clickText('//nav[@aria-label="主要导航"]', '收藏');
  await clickText('//nav[@aria-label="收藏视图"]', '歌曲');
  await until(() => script(() => document.querySelectorAll('.collection-track-row').length === 2), 'Scanned songs rendered');
  const range = await asynchronous(async path => {
    const url = window.__TAURI_INTERNALS__.convertFileSrc(path, 'zone-audio');
    const response = await fetch(url, { headers: { Range: 'bytes=0-43' } });
    return { status: response.status, contentRange: response.headers.get('Content-Range'), bytes: Array.from(new Uint8Array(await response.arrayBuffer())) };
  }, paths[0]);
  assert.equal(range.status, 206);
  assert.equal(range.bytes.length, 44);
  assert.equal(Buffer.from(range.bytes).subarray(0, 4).toString(), 'RIFF');
  assert.match(range.contentRange, /^bytes 0-43\//);
  await record('Real Rust scan, SQLite restore, rendered songs and local audio Range protocol passed');
  const favoriteTitle = await script(() => document.querySelector('.collection-track-row strong').textContent);
  const favoriteId = scan.tracks.find(track => track.title === favoriteTitle)?.id;
  assert.ok(favoriteId);
  await click('css selector', '.collection-track-favorite');
  await until(async () => (await invoke('music_get_library_snapshot')).playlists.find(list => list.id === 'favorites')?.trackIds.includes(favoriteId), 'UI favorite saved to SQLite');
  await clickText('//nav[@aria-label="收藏视图"]', '播放列表');
  await click('css selector', '.playlist-create-button');
  await click('css selector', '.playlist-kind-options button');
  const input = await command('POST', '/element', { using: 'css selector', value: '.playlist-dialog-create input' });
  await command('POST', `/element/${input['element-6066-11e4-a52e-4f735466cecf']}/value`, { text: 'CI 持久化列表' });
  await click('css selector', '.playlist-dialog-create button[type="submit"]');
  await until(async () => (await invoke('music_get_library_snapshot')).playlists.some(list => list.name === 'CI 持久化列表'), 'UI playlist saved to SQLite');
  await screenshot('02-persisted');
  await record('Real favorite and playlist UI actions persisted through native commands');
  assert.ok((await stat(join(dataDirectory, 'zone.sqlite'))).size > 0);
  if (process.argv.includes('--faults')) {
    const { DatabaseSync } = await import('node:sqlite');
    const databasePath = join(dataDirectory, 'zone.sqlite');
    // This path belongs to the fresh embedded CI identity already checked above.
    const database = new DatabaseSync(databasePath);
    let locked = false;
    try {
      database.exec('PRAGMA busy_timeout = 2000; BEGIN IMMEDIATE'); locked = true;
      await clickText('//nav[@aria-label="收藏视图"]', '歌曲');
      await click('css selector', '.collection-track-favorite[aria-pressed="true"]');
      await until(() => script(() => {
        const failed = JSON.parse(localStorage.getItem('zone-diagnostics-v1') ?? '[]')
          .some(entry => entry.event === 'save_playlists' && entry.outcome === 'error');
        return failed && Array.from(document.querySelectorAll('.action-toast[role="alert"]'))
          .some(node => node.textContent.includes('未保存') && node.querySelector('button'));
      }), 'Real locked playlist-write failure and notice', 20000);
      assert.equal(database.prepare('SELECT COUNT(*) AS n FROM music_playlist_items WHERE playlist_id = ? AND track_id = ?').get('favorites', favoriteId).n, 1,
        'A failed save must not replace the previous durable favorite.');
      await screenshot('04-locked-save');
    } finally { if (locked) database.exec('ROLLBACK'); database.close(); }
    await click('css selector', '.action-toast[role="alert"] button');
    await until(async () => !(await invoke('music_get_library_snapshot')).playlists.find(list => list.id === 'favorites').trackIds.includes(favoriteId), 'Retry saved the volatile edit after unlocking');
    await until(() => script(() => !document.querySelector('.action-toast[role="alert"]')), 'Save failure cleared after successful retry');
    outcome.coverage.sqliteLock = true;
    await record('Real SQLite write lock preserved durable state; UI retry saved the edit after unlock');
    await click('css selector', '.collection-track-favorite[aria-pressed="false"]');
    await until(async () => (await invoke('music_get_library_snapshot')).playlists.find(list => list.id === 'favorites').trackIds.includes(favoriteId), 'Restore favorite for restart check');
    const before = await invoke('music_get_library_snapshot');
    const failedScan = await asynchronous(async folder => {
      const api = window.__TAURI_INTERNALS__, progress = api.transformCallback(() => {});
      try { await api.invoke('music_scan_library', { folders: [{ path: folder, name: 'Unavailable CI fixture' }], progress: `__CHANNEL__:${progress}` }); return { rejected: false }; }
      catch (error) { return { rejected: true, error: String(error) }; }
      finally { api.unregisterCallback(progress); }
    }, join(media, 'missing-source'));
    assert.equal(failedScan.rejected, true);
    assert.match(failedScan.error, /已保留原资料库/);
    const after = await invoke('music_get_library_snapshot');
    assert.deepEqual(after.tracks, before.tracks);
    assert.deepEqual(after.folders, before.folders);
    assert.deepEqual(after.playlists, before.playlists);
    outcome.coverage.unavailableSource = true;
    await screenshot('05-recovered');
    await record('Unavailable-source scan rejected and retained the real library and playlists');
  }
  await closeNormally();
  await launch();
  const restored = await invoke('music_get_library_snapshot');
  assert.equal(restored.tracks.length, 2);
  assert.ok(restored.playlists.find(list => list.id === 'favorites').trackIds.includes(favoriteId));
  assert.ok(restored.playlists.some(list => list.name === 'CI 持久化列表'));
  await clickText('//nav[@aria-label="主要导航"]', '收藏');
  await clickText('//nav[@aria-label="收藏视图"]', '歌曲');
  await until(() => script(() => document.querySelectorAll('.collection-track-row').length === 2 && document.querySelectorAll('.collection-track-favorite[aria-pressed="true"]').length === 1), 'UI recovered songs and favorite');
  await clickText('//nav[@aria-label="收藏视图"]', '播放列表');
  await until(() => script(() => Array.from(document.querySelectorAll('.playlist-list button')).some(button => button.title === 'CI 持久化列表')), 'UI recovered playlist');
  await screenshot('03-restarted');
  await record('Fresh native process recovered library, favorite, playlist and close preference');
  await closeNormally();
  for (let i = 0; i < paths.length; i++) assert.equal(hash(await readFile(paths[i])), originalHashes[i], 'Source audio must remain unchanged.');
  outcome.coverage.core = true;
  outcome.ok = true;
} catch (error) {
  outcome.error = error.stack ?? String(error);
  console.error(outcome.error);
  if (session) {
    await screenshot('failure').catch(() => {});
    await script(() => document.documentElement.outerHTML).then(html => writeFile(join(report, 'failure.html'), html)).catch(() => {});
  }
  process.exitCode = 1;
} finally {
  if (session) await request('DELETE', `/session/${session}`, undefined, 10000).catch(() => {});
  driver.stdout.unpipe(log); driver.stderr.unpipe(log);
  driver.kill(); log.end();
  outcome.finishedAt = new Date().toISOString();
  await writeFile(join(report, 'result.json'), JSON.stringify(outcome, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFile } = await import('node:fs/promises');
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `\nNative artifact smoke: **${outcome.ok ? 'PASS' : 'FAIL'}**\n\nSource: ${manifest.sourceSha}\n\nExecutable SHA256: ${manifest.executableSha256}\n\n${steps.map(step => `- ${step.name}`).join('\n')}\n`);
  }
}
