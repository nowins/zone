import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const pin = JSON.parse(readFileSync(resolve(root, 'packaging/whisper-source.json'), 'utf8'));
const folder = resolve(root, 'src-tauri/binaries/whisper');
try {
  const engine = JSON.parse(readFileSync(resolve(folder, 'engine.json'), 'utf8').replace(/^\uFEFF/, ''));
  const hash = createHash('sha256').update(readFileSync(resolve(folder, 'zone-whisper.exe'))).digest('hex');
  if (engine.version !== pin.version || engine.commit !== pin.commit || engine.sourceSha256 !== pin.sha256 || engine.protocol !== 1 || engine.sha256 !== hash) throw Error('引擎版本或哈希不匹配');
  readFileSync(resolve(folder, 'LICENSE-whisper.txt'));
  console.log(`本地 CPU 引擎校验通过：whisper.cpp ${engine.version} ${hash}`);
} catch (error) {
  throw Error(`缺少通过校验的本地 CPU 引擎。先运行 scripts/build-whisper.ps1 -Archive <官方源码.zip>，或显式使用 -DownloadSource。${error.message}`);
}
