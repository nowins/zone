import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { canonical, digest, imageOperation, reviewDecision, summarizeDurations } from './native/baselineSupport.mjs';
import { compareNativeBaselines } from '../scripts/qa/compare-native-baselines.mjs';

test('baseline observations retain samples without creating an uncalibrated performance gate', () => {
  const samples = [500, 1, 2, 3, 4, 5, 100];
  const result = summarizeDurations(samples);
  assert.deepEqual(result.samples, samples); assert.equal(result.median, 4); assert.equal(result.p95, 500);
  assert.equal(result.verdict, 'observed'); assert.equal(result.threshold, null);
  assert.throws(() => summarizeDurations([1, 2, 3, 4, NaN]));
  assert.throws(() => summarizeDurations([1, 2, 3, 4, -1]));
  assert.equal(canonical({b: {y:2,x:1},a:3}), canonical({a:3,b:{x:1,y:2}}));
});

test('unreviewed references and changed rendering environments cannot become visual passes', () => {
  const candidate = {format:'ZoneNativeBaseline',captureStatus:'repeatable',compatibility:{browser:'one'},scenes:[{id:'songs'}]};
  const approval = {format:'ZoneNativeBaselineReference',version:1,review:{status:'approved',reviewer:'Human fixture reviewer',reviewedAt:'2026-10-17T00:00:00Z'},limits:{perChannelTolerance:0,maxChangedPixelRatio:0}};
  assert.equal(reviewDecision(candidate, candidate, null).status, 'needs-review');
  assert.equal(reviewDecision(candidate, candidate, {...approval,review:{status:'pending'}}).status, 'needs-review');
  assert.equal(reviewDecision(candidate, {...candidate,compatibility:{browser:'two'}}, approval).status, 'incompatible');
  assert.equal(reviewDecision(candidate, candidate, approval).status, 'comparable');
  assert.throws(() => reviewDecision(candidate,candidate,{...approval,limits:{}}));
  assert.throws(() => reviewDecision({...candidate,captureStatus:'incomplete'},candidate,approval));
});

test('real PNG comparison detects changed pixels, preserves reference bytes and enforces reviewed limits', {skip:process.platform!=='win32'}, async () => {
  const parent=resolve('.tmp/native-baseline-tests'); await mkdir(parent,{recursive:true});
  const root=await mkdtemp(join(parent,'case-')), referenceRoot=join(root,'reviewed'); await mkdir(referenceRoot);
  const generation=join(root,'generate.ps1');
  await writeFile(generation, `param([string]$Directory)\nAdd-Type -AssemblyName System.Drawing\n$image=[Drawing.Bitmap]::new(3,3)\n$graphics=[Drawing.Graphics]::FromImage($image)\n$graphics.Clear([Drawing.Color]::White)\n$image.Save((Join-Path $Directory 'reference.png'),[Drawing.Imaging.ImageFormat]::Png)\n$image.SetPixel(1,1,[Drawing.Color]::Magenta)\n$image.Save((Join-Path $Directory 'changed.png'),[Drawing.Imaging.ImageFormat]::Png)\n$graphics.Dispose(); $image.Dispose()\n`);
  await promisify(execFile)('powershell.exe',['-NoProfile','-File',generation,'-Directory',root],{windowsHide:true});
  const reference=join(root,'reference.png'), changed=join(root,'changed.png'), before=digest(await readFile(reference));
  const difference=await imageOperation('Compare',changed,join(root,'diff.png'),{ReferencePath:reference,Tolerance:0});
  assert.equal(difference.changedPixels,1); assert.equal(difference.changedRatio,1/9); assert.equal(difference.maxChannelDelta,255);
  assert.equal((await imageOperation('Compare',reference,join(root,'same-diff.png'),{ReferencePath:reference,Tolerance:0})).changedPixels,0);
  assert.equal((await imageOperation('Crop',changed,join(root,'crop.png'),{X:1,Y:1,Width:1,Height:1})).width,1);
  await assert.rejects(imageOperation('Crop',changed,join(root,'bad.png'),{Width:4,Height:4}));
  const fixture={format:'ZoneNativeBaseline',version:1,captureStatus:'repeatable',artifactSourceSha:'a'.repeat(40),compatibility:{fixture:'unit-image-only'},measurements:{},
    scenes:[{id:'songs',image:'songs.png',sha256:digest(await readFile(changed)),viewport:{crop:{width:3,height:3}}}]};
  await writeFile(join(root,'songs.png'),await readFile(changed));
  const candidatePath=join(root,'result.json'); await writeFile(candidatePath,JSON.stringify(fixture));
  const referenceReport={...fixture,scenes:[{...fixture.scenes[0],sha256:before}]};
  await writeFile(join(referenceRoot,'songs.png'),await readFile(reference));
  const bytes=JSON.stringify(referenceReport); await writeFile(join(referenceRoot,'result.json'),bytes);
  const approval={format:'ZoneNativeBaselineReference',version:1,candidate:'result.json',candidateSha256:digest(bytes),
    review:{status:'approved',reviewer:'Unit fixture only, not an app baseline',reviewedAt:'2026-10-17T00:00:00Z'},limits:{perChannelTolerance:0,maxChangedPixelRatio:0}};
  const approvalPath=join(referenceRoot,'reference.json'); await writeFile(approvalPath,JSON.stringify(approval));
  assert.equal((await compareNativeBaselines(candidatePath,null,join(root,'pending'))).status,'needs-review');
  assert.equal((await compareNativeBaselines(candidatePath,approvalPath,join(root,'comparison'))).status,'failed');
  await assert.rejects(compareNativeBaselines(candidatePath,approvalPath,referenceRoot),/outside/);
  await assert.rejects(compareNativeBaselines(candidatePath,approvalPath,join(referenceRoot,'..still-inside')),/outside/);
  assert.equal(digest(await readFile(reference)),before);
  await writeFile(join(referenceRoot,'songs.png'),Buffer.from('tampered PNG'));
  await assert.rejects(compareNativeBaselines(candidatePath,approvalPath,join(root,'tampered')),/recorded hash/);
});

test('native baseline resize refuses a different executable before any window mutation', {skip:process.platform!=='win32'}, async () => {
  await assert.rejects(promisify(execFile)('powershell.exe',['-NoProfile','-File',resolve('tests/native/setBaselineWindow.ps1'),
    '-RootPid',String(process.pid),'-ExpectedExecutable',resolve('.tmp/not-the-owned-executable.exe'),
    '-Identifier','com.zone.player.ci.run-negative','-Width','920','-Height','620'],{windowsHide:true}), /exact owned executable/);
});
