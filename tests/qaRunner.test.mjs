import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { selectLayers, runCommand } from '../scripts/qa/run.mjs';

test('risk selection retains specialized persistence, device and installer requirements', () => {
  const required = files => selectLayers(files).layers.filter(layer => layer.recommended).map(layer => layer.id);
  assert.deepEqual(required(['README.md']), ['fast']);
  assert.ok(required(['src-tauri/src/music/store.rs']).includes('faults'));
  assert.ok(required(['src/hooks/useAudioEngine.ts']).includes('hardware'));
  assert.ok(required(['packaging/build-msix.ps1']).includes('installer'));
  assert.ok(required(['src/styles/player.css']).includes('visual'));
});

test('QA runner cannot turn a failed command or a zero-test run into a passing matrix', async () => {
  const parent = resolve('.tmp/qa-runner-tests'); await mkdir(parent, { recursive: true });
  const project = await mkdtemp(join(parent, 'project-'));
  await mkdir(join(project, 'scripts/qa'), { recursive: true });
  await copyFile(resolve('scripts/qa/run.mjs'), join(project, 'scripts/qa/run.mjs'));
  await writeFile(join(project, 'source.txt'), 'initial\n');
  const git = args => execFileSync('git', args, { cwd: project, stdio: 'pipe' });
  git(['init', '--initial-branch=main']); git(['add', '.']);
  git(['-c', 'user.name=QA fixture', '-c', 'user.email=qa@example.invalid', 'commit', '-m', 'test fixture']);
  await writeFile(join(project, 'source.txt'), 'changed\n');
  const fakeCli = join(project, 'fixture-npm.mjs');
  for (const mode of ['nonzero', 'no-tests']) {
    await writeFile(fakeCli, `console.log('fixture claims PASS'); process.exit(${mode === 'nonzero' ? 7 : 0});`);
    const run = spawnSync(process.execPath, [join(project, 'scripts/qa/run.mjs'), '--base', 'HEAD', '--layer', 'fast'], {
      cwd: project, encoding: 'utf8', env: { ...process.env, npm_execpath: fakeCli }, timeout: 30000,
    });
    assert.equal(run.status, 1, run.stdout + run.stderr);
    const latest = JSON.parse(await readFile(join(project, '.tmp/qa/latest.json'), 'utf8'));
    const matrix = JSON.parse(await readFile(latest.report, 'utf8'));
    assert.equal(matrix.status, 'failed');
    assert.equal(matrix.matrix.find(row => row.id === 'fast').status, 'failed');
    assert.equal(matrix.matrix.find(row => row.id === 'artifact').status, 'not-run');
    if (mode === 'nonzero') assert.equal(matrix.commands.find(command => command.status === 'failed').exitCode, 7);
    else assert.match(matrix.commands.find(command => command.status === 'failed').error, /positive Node test count/);
  }
});

test('QA timeout stops its owned command and retains a diagnostic log', async () => {
  const parent = resolve('.tmp/qa-runner-tests'); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'timeout-'));
  const log = join(directory, 'timeout.log');
  const result = await runCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { log, timeout: 250 });
  assert.equal(result.timedOut, true);
  assert.notEqual(result.exitCode, 0);
  assert.equal(typeof await readFile(log, 'utf8'), 'string');
});
