import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { canonical, digest, imageOperation, summarizeDurations } from './baselineSupport.mjs';

export async function captureNativeBaselines({ command, script, asynchronous, clickText, until, ownedProcesses,
  executable, manifest, report, fixtureHashes }) {
  const directory = join(report, 'baselines'); await mkdir(directory);
  const result = { format: 'ZoneNativeBaseline', version: 1, artifactSourceSha: manifest.sourceSha,
    executableSha256: manifest.executableSha256, identifier: manifest.identifier, captureStatus: 'incomplete',
    visualReview: 'pending', performanceVerdict: 'observed', generatedAt: new Date().toISOString(), scenes: [], measurements: {},
    limits: ['Two generated WAV files; no artwork, large-library, cold-start, audible-output or normal-motion claims.',
      'UI timings use renderer performance.now through readiness plus two animation frames; no WebDriver transport time.',
      'No approved visual reference or calibrated performance budget is created automatically.'] };
  try {
    await command('POST', '/ms/cdp/execute', { cmd: 'Emulation.setEmulatedMedia', params: { features: [
      { name: 'prefers-reduced-motion', value: 'reduce' }, { name: 'prefers-color-scheme', value: 'light' }] } });
    await until(() => script(() => matchMedia('(prefers-reduced-motion: reduce)').matches), 'Reduced motion reached the real application');
    await clickText('//nav[@aria-label="收藏视图"]', '歌曲');
    await until(() => script(() => document.querySelectorAll('.collection-track-row').length === 2), 'Baseline fixture ready');
    const data = await asynchronous(async () => {
      await document.fonts.ready;
      const api = window.__TAURI_INTERNALS__;
      const snapshot = [], pivot = [];
      const frames = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const navigate = async (label, selector) => {
        const start = performance.now();
        Array.from(document.querySelectorAll('nav[aria-label="收藏视图"] button')).find(button => button.textContent === label).click();
        const deadline = start + 10000;
        const ready = () => document.querySelector('nav[aria-label="收藏视图"] button[aria-current="page"]')?.textContent === label
          && Array.from(document.querySelectorAll(selector)).some(node => node.getClientRects().length > 0 && !node.closest('[inert],[aria-hidden="true"]'));
        while (!ready()) {
          if (performance.now() > deadline) throw Error('Fixture navigation did not become ready');
          await new Promise(resolve => requestAnimationFrame(resolve));
        }
        await frames(); return performance.now() - start;
      };
      for (let i = 0; i < 8; i++) {
        const start = performance.now(), value = await api.invoke('music_get_library_snapshot');
        if (value.tracks.length !== 2) throw Error('Unexpected performance fixture');
        const elapsed = performance.now() - start;
        if (i > 0) snapshot.push(elapsed);
        await navigate('播放列表', '.playlist-create-button');
        const duration = await navigate('歌曲', '.collection-track-row');
        if (i > 0) pivot.push(duration);
      }
      return { snapshot, pivot };
    });
    result.measurements.snapshotIpc = { ...summarizeDurations(data.snapshot), warmupExcluded: 1, scope: 'Official native snapshot IPC for two generated tracks; renderer round-trip' };
    result.measurements.playlistToSongs = { ...summarizeDurations(data.pivot), warmupExcluded: 1, scope: 'Renderer DOM click from playlist list to two song rows, readiness plus two frames; reduced motion' };
    const viewports = [];
    for (const [width, height] of [[1180, 760], [920, 620]]) {
      const processes = ownedProcesses(); assert.equal(processes.length, 1);
      const resized = await promisify(execFile)('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
        resolve(import.meta.dirname, 'setBaselineWindow.ps1'), '-RootPid', String(processes[0]),
        '-ExpectedExecutable', executable, '-Identifier', manifest.identifier, '-Width', String(width), '-Height', String(height)],
      { windowsHide: true, encoding: 'utf8', timeout: 30000 });
      await until(() => script((w, h) => innerWidth === w && innerHeight === h, width, height), `Actual native client viewport ${width}x${height}`, 10000);
      await command('POST', '/actions', { actions: [{ type: 'pointer', id: 'baseline-pointer', parameters: { pointerType: 'mouse' }, actions: [{ type: 'pointerMove', origin: 'viewport', x: 5, y: 5, duration: 0 }] }] });
      const state = await asynchronous(async () => {
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        await document.fonts.ready;
        for (let i = 0; i < 4; i++) await new Promise(resolve => requestAnimationFrame(resolve));
        const section = document.querySelector('.collection-band'), rect = section.getBoundingClientRect();
        const rows = Array.from(section.querySelectorAll('.collection-track-row'));
        if (rows.length !== 2 || !document.querySelector('audio').paused) throw Error('Baseline must have exactly two paused tracks');
        if (section.getAnimations({subtree:true}).some(animation => animation.playState === 'running')) throw Error('Baseline region still animates');
        const theme = document.documentElement.dataset.surfaceTheme;
        if (theme !== 'light') throw Error(`Unexpected surface theme: ${theme}`);
        const canvas = document.createElement('canvas'), context = canvas.getContext('2d');
        const metrics = ['Segoe UI', 'Microsoft YaHei UI'].map(font => { context.font = `14px "${font}"`; return [font, context.measureText('Zone 音乐 基线 0123456789').width]; });
        return { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
          theme, fonts: {body:getComputedStyle(document.body).fontFamily, metrics},
          crop: { x: Math.floor(rect.x * devicePixelRatio), y: Math.floor(rect.y * devicePixelRatio),
            width: Math.round(rect.width * devicePixelRatio), height: Math.ceil((rows.at(-1).getBoundingClientRect().bottom + 24 - rect.y) * devicePixelRatio) },
          rows: rows.map(row => row.querySelector('strong').textContent),
          favorites: rows.filter(row => row.querySelector('.collection-track-favorite[aria-pressed="true"]')).map(row => row.querySelector('strong').textContent),
          screen: {width:screen.width,height:screen.height} };
      });
      assert.deepEqual(state.rows, ['CI Sample One', 'CI Sample Two']);
      assert.deepEqual(state.favorites, ['CI Sample One']);
      assert.equal(state.reducedMotion, true);
      const id = `songs-${width}x${height}`, image = `${id}.png`, repeat = `${id}-repeat.png`;
      for (const file of [image, repeat]) {
        const png = await command('GET', '/screenshot');
        const full = join(directory, `${file.slice(0, -4)}-full.png`);
        await writeFile(full, Buffer.from(png, 'base64'));
        const dimensions = await imageOperation('Crop', full, join(directory, file), Object.fromEntries(Object.entries(state.crop).map(([key,value]) => [key[0].toUpperCase()+key.slice(1), value])));
        assert.equal(dimensions.width, state.crop.width); assert.equal(dimensions.height, state.crop.height);
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      const repetition = await imageOperation('Compare', join(directory, image), join(directory, `${id}-repeat-diff.png`), { ReferencePath: join(directory, repeat), Tolerance: 0 });
      assert.equal(repetition.changedPixels, 0, 'Repeated stable-region capture changed; reject this candidate instead of accepting noise.');
      result.scenes.push({ id, image, sha256: digest(await readFile(join(directory, image))), viewport: state, repetition,
        nativeWindow: JSON.parse(resized.stdout.replace(/^\uFEFF/, '')) });
      const { crop: _crop, rows: _rows, favorites: _favorites, ...stableEnvironment } = state;
      viewports.push(stableEnvironment);
    }
    const environment = { os: os.release(), architecture: os.arch(), cpu: os.cpus()[0]?.model, memoryBytes: os.totalmem(),
      runnerImage: process.env.ImageOS ?? null, imageVersion: process.env.ImageVersion ?? null,
      browserVersion: await script(() => navigator.userAgent) };
    result.compatibility = { fixture: { version: 1, audioHashes: fixtureHashes, tracks: ['CI Sample One', 'CI Sample Two'], favorite: 'CI Sample One' },
      renderer: { os: environment.os, architecture: environment.architecture, runnerImage: environment.runnerImage,
        imageVersion: environment.imageVersion, browserVersion: environment.browserVersion, cpu: environment.cpu }, viewports };
    result.environment = environment; result.compatibilitySha256 = digest(canonical(result.compatibility));
    result.captureStatus = 'repeatable';
    return result;
  } catch (error) { result.error = error.stack ?? String(error); throw error; }
  finally { await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2)); }
}
