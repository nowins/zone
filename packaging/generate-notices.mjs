import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
const cargo = JSON.parse(execFileSync('cargo', ['metadata', '--manifest-path', 'src-tauri/Cargo.toml', '--format-version', '1', '--filter-platform', 'x86_64-pc-windows-msvc'], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
const nodes = new Map(cargo.resolve.nodes.map(node => [node.id, node]));
const included = new Set();
function visit(id) {
  if (included.has(id)) return;
  included.add(id);
  for (const dep of nodes.get(id)?.deps ?? []) {
    if (dep.dep_kinds.some(kind => kind.kind !== 'dev')) visit(dep.pkg);
  }
}
visit(cargo.resolve.root);
const records = [];
const archived = JSON.parse(readFileSync(join(root, 'packaging/license-sources.json'), 'utf8'));
function licenses(directory, explicit) {
  const files = readdirSync(directory).filter(name => /^(licen[sc]e|copying|notice)([.\-_]|$)/i.test(name));
  if (explicit && existsSync(join(directory, explicit))) files.push(explicit);
  for (const folder of ['LICENSES', 'licenses']) {
    if (existsSync(join(directory, folder))) files.push(...readdirSync(join(directory, folder)).map(name => join(folder, name)));
  }
  return [...new Set(files)].sort().flatMap(name => {
    try { return [`${name}\n${readFileSync(join(directory, name), 'utf8').replace(/\r\n/g, '\n').trim()}`]; }
    catch { return []; }
  });
}
for (const [location, item] of Object.entries(lock.packages)) {
  if (!location || item.dev || item.devOptional) continue;
  const directory = join(root, location);
  const pkg = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  records.push({ name: `npm: ${pkg.name} ${pkg.version}`, license: pkg.license, url: typeof pkg.repository === 'object' ? pkg.repository.url : pkg.repository, texts: licenses(directory) });
}
for (const pkg of cargo.packages) {
  if (!included.has(pkg.id) || pkg.id === cargo.resolve.root) continue;
  let texts = licenses(dirname(pkg.manifest_path), pkg.license_file);
  if (!texts.length) texts = (archived[`${pkg.name}@${pkg.version}`] ?? []).map(item => `${item.file}\n来源：${item.source}\n${readFileSync(join(root, 'packaging/licenses', item.file), 'utf8').trim()}`);
  records.push({ name: `Rust: ${pkg.name} ${pkg.version}`, license: pkg.license, url: `${pkg.repository ?? ''}\n对应版本源码：https://crates.io/crates/${pkg.name}/${pkg.version}`, texts });
}
const missing = records.filter(record => !record.texts.length);
if (missing.length) throw Error(`缺少许可证原文：\n${missing.map(record => record.name).join('\n')}`);
const content = 'Zone 第三方软件许可\n\n以下组件的许可原文来自安装的 npm 包与 Cargo 源码。项目本身的许可不由此文件授予。\n\n' + records.sort((a, b) => a.name.localeCompare(b.name, 'en')).map(record => `${'='.repeat(72)}\n${record.name}\nSPDX: ${record.license ?? '见原文'}\n${record.url ?? ''}\n\n${record.texts.join('\n\n')}`).join('\n\n') + '\n';
const destination = join(root, 'packaging/THIRD_PARTY_NOTICES.txt');
if (process.argv.includes('--check')) {
  if (!existsSync(destination) || readFileSync(destination, 'utf8') !== content) throw Error('第三方许可已变化，请运行 npm run notices:generate 并核对产物');
} else writeFileSync(destination, content, 'utf8');
console.log(`第三方许可：${records.length} 个组件，已${process.argv.includes('--check') ? '核对' : '生成'}`);
