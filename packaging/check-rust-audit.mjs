import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--manifest-path', 'src-tauri/Cargo.toml', '--format-version', '1', '--filter-platform', 'x86_64-pc-windows-msvc'], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
const nodes = new Map(metadata.resolve.nodes.map(node => [node.id, node]));
const included = new Set();
function visit(id) {
  if (included.has(id)) return;
  included.add(id);
  for (const dep of nodes.get(id)?.deps ?? []) if (dep.dep_kinds.some(kind => kind.kind !== 'dev')) visit(dep.pkg);
}
visit(metadata.resolve.root);
const packages = new Set(metadata.packages.filter(pkg => included.has(pkg.id)).map(pkg => `${pkg.name}@${pkg.version}`));
const result = spawnSync('cargo', ['audit', '--json'], { cwd: resolve(root, 'src-tauri'), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
if (result.error || !result.stdout.trim()) throw Error(result.error?.message ?? result.stderr);
const report = JSON.parse(result.stdout);
if (!report.vulnerabilities || !report.warnings) throw Error(`Rust 安全扫描未完成：${result.stderr}`);
const relevant = entry => packages.has(`${entry.package.name}@${entry.package.version}`);
const vulnerabilities = report.vulnerabilities.list.filter(relevant);
const unsound = (report.warnings.unsound ?? []).filter(relevant);
const yanked = (report.warnings.yanked ?? []).filter(relevant);
const unmaintained = (report.warnings.unmaintained ?? []).filter(relevant);
for (const entry of [...vulnerabilities, ...unsound, ...yanked, ...unmaintained]) console.log(`${entry.advisory?.id ?? 'yanked'} ${entry.package.name} ${entry.package.version}: ${entry.advisory?.title ?? '已撤回版本'}`);
console.log(`Win32 依赖审计：${vulnerabilities.length} 个漏洞、${unsound.length} 个不健全警告、${yanked.length} 个撤回版本、${unmaintained.length} 个停止维护警告`);
const excluded = [...report.vulnerabilities.list, ...(report.warnings.unsound ?? [])].filter(entry => !relevant(entry));
if (excluded.length) console.log(`未进入 Win32 构建的目标依赖：${excluded.map(entry => `${entry.package.name}@${entry.package.version}`).join('、')}`);
if (vulnerabilities.length || unsound.length || yanked.length) process.exitCode = 1;
