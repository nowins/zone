import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { createLibraryFixture } from './library-fixture.mjs';

if (!globalThis.gc) throw Error('Run with node --expose-gc.');
const root = process.cwd();
const git = args => execFileSync('git', args, { encoding: 'utf8' }).trim();
const base = git(['rev-parse', '--verify', '--end-of-options', `${process.argv[2] ?? 'origin/main'}^{commit}`]);
await mkdir('.tmp/perf', { recursive: true });
const hash = value => createHash('sha256').update(value).digest('hex');
for (const label of ['reference', 'current']) {
  await build({ stdin: { contents: `export {searchLibrary} from './src/utils/librarySearch';export {buildCollectionIndex} from './src/utils/collectionEntities';`, resolveDir: root, loader: 'ts' },
    outfile: `.tmp/perf/search-${label}.mjs`, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent',
    plugins: label === 'reference' ? [{ name: 'pinned-source', setup(builder) {
      builder.onLoad({ filter: /[\\/]src[\\/].*\.ts$/ }, args => ({
        contents: git(['show', `${base}:${relative(root, args.path).replaceAll('\\', '/')}`]),
        loader: 'ts', resolveDir: dirname(args.path),
      }));
    } }] : [],
  });
}
const reference = await import(pathToFileURL(resolve('.tmp/perf/search-reference.mjs')));
const current = await import(pathToFileURL(resolve('.tmp/perf/search-current.mjs')));
const signature = value => hash(JSON.stringify({ tracks: value.tracks.map(t => t.id), artists: value.artists.map(a => a.artist),
  albums: value.albums.map(a => a.key), playlists: value.playlists.map(p => [p.playlist.id, p.tracks.map(t => t.id)]) }));
function sample(operation) {
  globalThis.gc();
  const memory = process.memoryUsage(), cpu = process.cpuUsage(), started = performance.now();
  let value = operation();
  const ms = performance.now() - started, used = process.cpuUsage(cpu), end = process.memoryUsage();
  globalThis.gc();const retained = process.memoryUsage().heapUsed - memory.heapUsed;
  const resultSha256 = signature(value);value = null;globalThis.gc();
  return { ms, cpuMs: (used.user + used.system) / 1000, callEndHeapDeltaBytes: end.heapUsed - memory.heapUsed,
    retainedWithResultBytes: retained, releasedHeapDeltaBytes: process.memoryUsage().heapUsed - memory.heapUsed,
    rssBytes: end.rss, resultSha256 };
}
function summary(samples) {
  const median = key => samples.map(s => s[key]).sort((a, b) => a - b)[3];
  return { samples, medianMs: median('ms'), p95Ms: Math.max(...samples.map(s => s.ms)),
    medianCpuMs: median('cpuMs'), medianCallEndHeapDeltaBytes: median('callEndHeapDeltaBytes'),
    medianRetainedWithResultBytes: median('retainedWithResultBytes'), medianReleasedHeapDeltaBytes: median('releasedHeapDeltaBytes') };
}
const result = { format: 'ZonePairedSearchObservation', version: 1, baseSha: base, currentSha: git(['rev-parse', 'HEAD']),
  currentDirty: Boolean(git(['status', '--porcelain'])),
  bundles: Object.fromEntries(await Promise.all(['reference', 'current'].map(async label => [label, hash(await readFile(`.tmp/perf/search-${label}.mjs`))]))),
  environment: { node: process.version, os: os.release(), cpu: os.cpus()[0].model, logicalProcessors: os.cpus().length, memoryBytes: os.totalmem() },
  warmupPerVersion: 2, samplesPerVersion: 7, cases: [],
  limitations: ['Alternating AB/BA inside one Node process, not a WebView/UI or native playback measurement',
    'GC excluded from timing; heap measured at call end is not peak allocation; released delta is not a leak proof',
    'No calibrated pass/fail budget; seven-sample p95 is the sample maximum; host background load is uncontrolled'] };
for (const count of [10000, 50000]) {
  const data = createLibraryFixture(count), index = current.buildCollectionIndex(data.tracks);
  for (const query of ['歌曲', 'not-present-1729']) {
    const input = { ...data, albums: index.albums, artists: index.artists, query };
    for (let i = 0; i < 2; i++) { reference.searchLibrary(input);current.searchLibrary(input); }
    const samples = { reference: [], current: [] };
    for (let i = 0; i < 7; i++) {
      for (const label of i % 2 ? ['current', 'reference'] : ['reference', 'current']) {
        samples[label].push(sample(() => (label === 'reference' ? reference : current).searchLibrary(input)));
      }
      assert.equal(samples.reference.at(-1).resultSha256, samples.current.at(-1).resultSha256);
    }
    const row = { count, query, reference: summary(samples.reference), current: summary(samples.current), resultsIdentical: true };
    result.cases.push(row);await writeFile('.tmp/perf/paired.json', JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ count, query, referenceMs: row.reference.medianMs, currentMs: row.current.medianMs,
      referenceHeapBytes: row.reference.medianCallEndHeapDeltaBytes, currentHeapBytes: row.current.medianCallEndHeapDeltaBytes }));
  }
}
