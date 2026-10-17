import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, readFile, mkdir, copyFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { resolve, join } from 'node:path';
import { hash, validateArtifact, writeWave, within } from './native/artifactSupport.mjs';

test('artifact preflight rejects production identity, changed executables and escaping paths', async () => {
  const parent = resolve('.tmp/ci-artifact-guard'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'case-'));
  const identifier = 'com.zone.player.ci.run-unit-1234';
  const bytes = Buffer.from(`fixture-only ${identifier}`);
  const manifest = { format: 'ZoneNativeCI', version: 1, identifier, sourceSha: 'a'.repeat(40), executable: 'zone-player.exe', executableSha256: hash(bytes) };
  const file = join(root, 'build-info.json');
  await writeFile(join(root, 'zone-player.exe'), bytes);
  await writeFile(file, JSON.stringify(manifest));
  assert.equal((await validateArtifact(file)).manifest.identifier, identifier);
  await writeFile(file, JSON.stringify({ ...manifest, identifier: 'com.zone.player' }));
  await assert.rejects(validateArtifact(file), /dedicated CI/);
  await writeFile(file, JSON.stringify({ ...manifest, executable: '../zone-player.exe' }));
  await assert.rejects(validateArtifact(file), /dedicated CI/);
  await writeFile(file, JSON.stringify(manifest));
  await writeFile(join(root, 'zone-player.exe'), Buffer.from('changed executable'));
  await assert.rejects(validateArtifact(file), /hash or embedded/);
  assert.equal(within(root, resolve(root, '..', 'unrelated')), false);
  assert.equal(within(root, root), false);
});

test('generated audio fixture has a real bounded PCM WAV payload', async () => {
  const root = resolve('.tmp/ci-artifact-guard'); await mkdir(root, { recursive: true });
  const path = join(root, 'tone.wav'); const digest = await writeWave(path);
  const bytes = await readFile(path);
  assert.equal(hash(bytes), digest);
  assert.equal(bytes.subarray(0, 4).toString(), 'RIFF');
  assert.equal(bytes.subarray(8, 12).toString(), 'WAVE');
  assert.equal(bytes.readUInt32LE(4), bytes.length - 8);
  assert.equal(bytes.readUInt32LE(40), 22050 * 2 * 2);
  assert.notEqual(bytes.readInt16LE(46), 0);
});

test('version command updates and validates the tracked lock entry with LF and CRLF', async () => {
  const parent = resolve('.tmp/ci-artifact-guard'); await mkdir(parent, { recursive: true });
  for (const newline of ['\n', '\r\n']) {
    const project = await mkdtemp(join(parent, 'version-'));
    for (const file of ['package.json', 'package-lock.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock',
      'src-tauri/tauri.conf.json', 'src/app/releaseInfo.ts', 'packaging/check-version.mjs']) {
      const target = join(project, file); await mkdir(dirname(target), { recursive: true });
      await copyFile(resolve(file), target);
    }
    const lockPath = join(project, 'src-tauri/Cargo.lock');
    const original = await readFile(lockPath, 'utf8');
    await writeFile(lockPath, original.replace(/\r?\n/g, newline));
    execFileSync(process.execPath, [join(project, 'packaging/check-version.mjs'), '--set', '1.0.1']);
    assert.match(await readFile(lockPath, 'utf8'), /name = "zone-player"\r?\nversion = "1\.0\.1"/);
    execFileSync(process.execPath, [join(project, 'packaging/check-version.mjs')]);
    const lock = await readFile(lockPath, 'utf8');
    await writeFile(lockPath, lock.replace(/(name = "zone-player"\r?\nversion = )"1\.0\.1"/, '$1"1.0.2"'));
    assert.throws(() => execFileSync(process.execPath, [join(project, 'packaging/check-version.mjs')], { stdio: 'pipe' }));
  }
});
