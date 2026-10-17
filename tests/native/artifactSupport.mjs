import { createHash } from 'node:crypto';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

export const hash = value => createHash('sha256').update(value).digest('hex');
export function within(root, path) {
  const difference = relative(root, path);
  return difference !== '' && difference !== '..' && !difference.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(difference);
}
export async function validateArtifact(manifestPath) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.format !== 'ZoneNativeCI' || manifest.version !== 1
    || !/^com\.zone\.player\.ci\.run-[a-z0-9-]+$/.test(manifest.identifier)
    || manifest.executable !== 'zone-player.exe' || !/^[a-f0-9]{40}$/.test(manifest.sourceSha)) {
    throw Error('Refusing an artifact without a dedicated CI application identity.');
  }
  const directory = await realpath(dirname(manifestPath));
  const executable = await realpath(resolve(directory, manifest.executable));
  if (!within(directory, executable)) throw Error('Artifact executable escapes its directory.');
  const binary = await readFile(executable);
  if (hash(binary) !== manifest.executableSha256 || !binary.includes(Buffer.from(manifest.identifier))) {
    throw Error('Artifact hash or embedded application identity does not match.');
  }
  return { manifest, executable };
}
export async function writeWave(path) {
  const rate = 22050, frames = rate * 2;
  const bytes = Buffer.alloc(44 + frames * 2);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++) bytes.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * i / rate) * 3000), 44 + i * 2);
  await writeFile(path, bytes);
  return hash(bytes);
}
