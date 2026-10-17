import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const definitions = [
  ['fast', '构建与自动回归', '项目 Node/npm；涉及 Rust 时需要 MSVC/Rust'],
  ['artifact', '真实原生产物', '可交互 Windows x64、WebView2 与微软签名驱动'],
  ['faults', '隔离故障与恢复', '同原生产物；仅对本次生成的 CI 身份资料制造故障'],
  ['visual', '视觉基线', '经人工批准的参考截图、固定窗口/DPI/字体与比较工具'],
  ['performance', '性能基线', '固定参考机、真实标签/封面夹具与已批准预算'],
  ['hardware', '音频与系统设备', '专用 Windows 客户端、音频录回/设备与明确授权'],
  ['installer', '安装升级生命周期', '专用 Windows 10/11 VM、快照、测试凭据和匹配安装包'],
];
export function selectLayers(files) {
  const paths = files.map(path => path.replaceAll('\\', '/'));
  const code = paths.some(path => !/\.md$/.test(path));
  const native = paths.some(path => /^(src\/|src-tauri\/|scripts\/ci\/|tests\/.*[Aa]rtifact|\.github\/|\.gitattributes$|packaging\/.*\.(mjs|ps1|json))/.test(path));
  const persistence = paths.some(path => /src\/App\.tsx|useMusicLibrary|legacyMigration|src-tauri\/src\/(db\/|music\/store|library\.rs)|tests\/run-native-artifact|scripts\/qa\//.test(path));
  const reasons = {
    fast: '所有改动检查差异；代码改动补构建/回归。',
    artifact: native ? '涉及应用、原生、构建或产物测试链路。' : '本次差异未建议此层。',
    faults: persistence ? '涉及持久化或验证故障恢复的执行链路。' : '本次差异未建议此层。',
  };
  const recommended = new Set(['fast']);
  if (native) recommended.add('artifact');
  if (persistence) { recommended.add('artifact'); recommended.add('faults'); }
  if (paths.some(path => /^src\/(views|components|styles|motion)\//.test(path) || path === 'src/styles.css')) recommended.add('visual');
  if (paths.some(path => /useCollection|collectionEntities|src-tauri\/src\/(library|music\/store)/.test(path))) recommended.add('performance');
  if (paths.some(path => /useAudioEngine|usePlaybackControls|audio_protocol|audio_transcode|system_media/.test(path))) recommended.add('hardware');
  if (paths.some(path => /packaging\/(build-|Package\.appxmanifest|test-msix)|src-tauri\/tauri.*\.conf\.json|webview_runtime/.test(path))) recommended.add('installer');
  return { code, rust: paths.some(path => /^src-tauri\//.test(path)), layers: definitions.map(([id, name, environment]) => ({
    id, name, environment, recommended: recommended.has(id), reason: reasons[id] ?? (recommended.has(id) ? '根据差异建议专用验证。' : '本次差异未建议此层。'),
    status: 'not-run',
  })) };
}

export async function runCommand(command, args, { cwd, env, log, timeout = 600000 } = {}) {
  await writeFile(log, '');
  const child = spawn(command, args, { cwd, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', writes = Promise.resolve(), timedOut = false;
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => {
    output += bytes.toString();
    writes = writes.then(() => appendFile(log, bytes));
  });
  const timer = setTimeout(() => {
    timedOut = true;
    // Stop only this owned command tree, never an application selected by name.
    if (child.pid && child.exitCode === null) {
      if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      else { try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill(); } }
    }
  }, timeout);
  const status = await new Promise(resolve => { child.on('error', error => resolve({ exitCode: null, error: error.message })); child.on('exit', exitCode => resolve({ exitCode })); });
  clearTimeout(timer); await writes;
  return { ...status, timedOut, output };
}

async function main() {
  const root = resolve(import.meta.dirname, '../..');
  const argument = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
  const layer = argument('layer', 'plan'), base = argument('base', 'origin/main');
  if (!['plan', 'auto', 'fast', 'artifact', 'faults'].includes(layer)) throw Error('Use --layer plan|auto|fast|artifact|faults.');
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const baseSha = git(['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`]).trim();
  const split = value => value.split('\0').filter(Boolean);
  const files = [...new Set([...split(git(['diff', '--name-only', '-z', `${baseSha}...HEAD`])),
    ...split(git(['diff', '--name-only', '-z', 'HEAD'])), ...split(git(['ls-files', '--others', '--exclude-standard', '-z']))])];
  const plan = selectLayers(files);
  const directory = join(root, '.tmp/qa', randomUUID()); await mkdir(directory, { recursive: true });
  const hash = value => createHash('sha256').update(value).digest('hex');
  const report = { sourceSha: git(['rev-parse', 'HEAD']).trim(), baseSha, changedFiles: files,
    dirty: Boolean(git(['status', '--porcelain']).trim()), diffSha256: hash(git(['diff', 'HEAD'])),
    startedAt: new Date().toISOString(), mode: layer, status: 'not-run', matrix: plan.layers, commands: [] };
  let failed = false, counter = 0;
  const npmCli = process.env.npm_execpath ?? join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  const npm = (task) => [process.execPath, [npmCli, 'run', task]];
  async function execute(label, command, args, cwd = root, extraEnv = {}) {
    const log = join(directory, `${++counter}-${label}.log`);
    const started = Date.now();
    const result = await runCommand(command, args, { cwd, env: { ...process.env, ...extraEnv }, log });
    const entry = { label, command, args, log, elapsedMs: Date.now() - started, exitCode: result.exitCode, timedOut: result.timedOut, error: result.error };
    if (result.exitCode === 0 && label === 'node-tests' && !/\btests\s+[1-9]\d*/.test(result.output)) entry.error = 'No positive Node test count was reported.';
    if (result.exitCode === 0 && label === 'rust-tests' && !/test result: ok\. [1-9]\d* passed/.test(result.output)) entry.error = 'No positive Rust test count was reported.';
    entry.status = result.exitCode === 0 && !result.timedOut && !entry.error ? 'passed' : 'failed';
    report.commands.push(entry); console.log(`${entry.status}: ${label} (${log})`);
    if (entry.status === 'failed') { failed = true; throw Error(`Validation failed: ${label}`); }
    return result.output;
  }
  const row = id => report.matrix.find(item => item.id === id);
  const selected = id => layer === id || (layer === 'auto' && row(id).recommended);
  try {
    if (selected('fast')) {
      try {
        await execute('committed-diff-check', 'git', ['diff', '--check', `${baseSha}...HEAD`]);
        await execute('staged-diff-check', 'git', ['diff', '--cached', '--check']);
        await execute('working-diff-check', 'git', ['diff', '--check']);
        if (plan.code) { await execute('frontend-build', ...npm('build')); await execute('node-tests', ...npm('test')); }
        if (plan.rust) { await execute('rust-check', 'cargo', ['check', '--locked'], join(root, 'src-tauri')); await execute('rust-tests', 'cargo', ['test', '--locked', '--lib'], join(root, 'src-tauri')); }
        row('fast').status = 'passed';
      } catch (error) { row('fast').status = 'failed'; throw error; }
    }
    if (selected('artifact') || selected('faults')) {
      if (process.platform !== 'win32') {
        row('artifact').reason = '未执行：需要可交互 Windows x64 与 WebView2。';
        row('faults').reason = row('artifact').reason;
      } else {
        const nativeEnv = { CARGO_TARGET_DIR: join(root, '.tmp/qa-native-target') };
        try {
          const buildOutput = await execute('native-build', ...npm('build:ci:native'), root, nativeEnv);
          await execute('webdriver', 'powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'scripts/ci/setup-webdriver.ps1')]);
          const buildRecord = buildOutput.split(/\r?\n/).reverse().flatMap(line => {
            try { const value = JSON.parse(line); return value.artifact && value.manifest && value.executableSha256 ? [value] : []; } catch { return []; }
          })[0];
          if (!buildRecord) throw Error('Native build did not report its exact artifact.');
          const manifest = buildRecord.manifest;
          const driver = JSON.parse((await readFile(join(root, '.tmp/ci-tools/webdriver.json'), 'utf8')).replace(/^\uFEFF/, '')).driver;
          const args = [join(root, 'tests/run-native-artifact.mjs'), '--manifest', manifest, '--driver', driver, '--report', join(directory, 'native')];
          if (selected('faults')) args.push('--faults');
          await execute('native-smoke', process.execPath, args);
          const outcome = JSON.parse(await readFile(join(directory, 'native/result.json'), 'utf8'));
          if (!outcome.ok || !outcome.coverage?.core || !outcome.coverage?.shellIsolation || outcome.sourceSha !== report.sourceSha) throw Error('Native artifact result has insufficient or mismatched evidence.');
          row('artifact').status = 'passed'; report.artifact = { sourceSha: outcome.sourceSha, executableSha256: outcome.executableSha256, result: join(directory, 'native/result.json') };
          if (selected('faults')) {
            if (!outcome.coverage.sqliteLock || !outcome.coverage.unavailableSource) throw Error('Requested fault cases did not execute.');
            row('faults').status = 'passed';
          }
        } catch (error) { row(selected('faults') ? 'faults' : 'artifact').status = 'failed'; failed = true; throw error; }
      }
    }
  } catch (error) { report.error = error.stack ?? String(error); }
  for (const item of report.matrix) if (item.status === 'not-run') item.reason = `${item.reason} ${failed ? '前序失败，未继续。' : '未执行或缺少该层前提；不作通过结论。'}`;
  report.finishedAt = new Date().toISOString();
  report.status = failed ? 'failed' : layer === 'plan' ? 'not-run' : report.matrix.some(item => item.recommended && item.status === 'not-run') ? 'incomplete' : 'passed';
  await writeFile(join(directory, 'matrix.json'), JSON.stringify(report, null, 2));
  const markdown = ['| 层 | 状态 | 依据／限制 |', '|---|---|---|', ...report.matrix.map(item => `| ${item.name} | ${item.status} | ${item.reason} |`)].join('\n');
  await writeFile(join(directory, 'matrix.md'), markdown);
  await mkdir(join(root, '.tmp/qa'), { recursive: true });
  await writeFile(join(root, '.tmp/qa/latest.json'), JSON.stringify({ report: join(directory, 'matrix.json') }));
  console.log(markdown); console.log(`Report: ${join(directory, 'matrix.json')}`);
  process.exitCode = failed ? 1 : report.status === 'incomplete' && layer !== 'plan' ? 2 : 0;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();
