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

test('CPU model alone is diagnostic while every other recorded rendering condition remains strict', async () => {
  const reference = JSON.parse(await readFile('tests/baselines/approved/result.json', 'utf8'));
  const approval = JSON.parse(await readFile('tests/baselines/approved/reference.json', 'utf8'));
  const before = canonical(reference);
  for (const cpu of ['AMD EPYC 9V45 96-Core Processor', 'Intel Xeon Platinum 8370C', undefined]) {
    const candidate = structuredClone(reference);
    if (cpu === undefined) delete candidate.compatibility.renderer.cpu;
    else candidate.compatibility.renderer.cpu = cpu;
    candidate.environment.cpu = cpu;
    assert.equal(reviewDecision(candidate, reference, approval).status, 'comparable');
  }
  const changes = [
    ['Windows', value => { value.compatibility.renderer.os = '10.0.26100'; }],
    ['architecture', value => { value.compatibility.renderer.architecture = 'arm64'; }],
    ['runner image', value => { value.compatibility.renderer.runnerImage = 'win25'; }],
    ['image version with different image bytes', value => { value.compatibility.renderer.imageVersion += '.changed'; value.scenes[0].sha256 = '0'.repeat(64); }],
    ['WebView2', value => { value.compatibility.renderer.browserVersion += '.changed'; }],
    ['font family', value => { value.compatibility.viewports[0].fonts.body = 'Arial'; }],
    ['font metrics', value => { value.compatibility.viewports[0].fonts.metrics[0][1] += 0.01; }],
    ['DPR', value => { value.compatibility.viewports[0].dpr = 1.25; }],
    ['native DPI', value => { value.scenes[0].nativeWindow.dpi = 120; }],
    ['missing native DPI', value => { delete value.scenes[0].nativeWindow.dpi; }],
    ['viewport', value => { value.compatibility.viewports[1].width += 1; }],
    ['screen', value => { value.compatibility.viewports[0].screen.width += 1; }],
    ['theme', value => { value.compatibility.viewports[0].theme = 'dark'; }],
    ['reduced motion', value => { value.compatibility.viewports[0].reducedMotion = false; }],
    ['fixture version', value => { value.compatibility.fixture.version += 1; }],
    ['fixture bytes', value => { value.compatibility.fixture.audioHashes[0] = '0'.repeat(64); }],
    ['fixture tracks', value => { value.compatibility.fixture.tracks[0] = 'Different song'; }],
    ['fixture favorite', value => { value.compatibility.fixture.favorite = 'CI Sample Two'; }],
    ['new renderer condition', value => { value.compatibility.renderer.gpu = 'different'; }],
    ['new compatibility condition', value => { value.compatibility.newCondition = true; }],
  ];
  for (const [condition, change] of changes) {
    const candidate = structuredClone(reference);
    candidate.compatibility.renderer.cpu = 'AMD EPYC 9V45 96-Core Processor';
    change(candidate);
    assert.equal(reviewDecision(candidate, reference, approval).status, 'incompatible', condition);
  }
  assert.equal(canonical(reference), before, 'Comparison must not rewrite approved evidence');
});

test('runner image revision drift is comparable only with identical recorded scene bytes and geometry', async () => {
  const reference = JSON.parse(await readFile('tests/baselines/approved/result.json', 'utf8'));
  const approval = JSON.parse(await readFile('tests/baselines/approved/reference.json', 'utf8'));
  const candidate = structuredClone(reference);
  assert.equal(reference.compatibility.renderer.imageVersion, '20261012.333.1');
  // Run 40633818188: the only compatibility difference; both PNG hashes match.
  candidate.compatibility.renderer.imageVersion = '20261022.344.1';
  const before = canonical({ candidate, reference, approval });
  const decision = reviewDecision(candidate, reference, approval);
  assert.equal(decision.status, 'comparable');
  assert.deepEqual(decision.compatibilityNotes, [{ field: 'renderer.imageVersion',
    reference: '20261012.333.1', candidate: '20261022.344.1',
    reason: 'Runner image revision differs, but every scene has identical PNG hashes and viewport geometry; PNG bytes must still be verified.' }]);
  assert.equal(reviewDecision(reference, candidate, approval).status, 'comparable');
  const changes = [
    value => { value.scenes[0].sha256 = '0'.repeat(64); },
    value => { delete value.scenes[0].sha256; },
    value => { value.scenes.pop(); },
    value => { value.scenes[0].viewport.crop.x += 1; },
    value => { value.compatibility.renderer.browserVersion += '.changed'; },
    value => { value.compatibility.fixture.audioHashes[0] = '0'.repeat(64); },
    value => { value.compatibility.viewports[0].fonts.metrics[0][1] += 1; },
    value => { value.compatibility.renderer.newCondition = true; },
    value => { value.scenes[0].nativeWindow.dpi = 120; },
    value => { delete value.compatibility.renderer.imageVersion; },
  ];
  for (const change of changes) {
    const changed = structuredClone(candidate); change(changed);
    assert.equal(reviewDecision(changed, reference, approval).status, 'incompatible');
  }
  assert.equal(canonical({ candidate, reference, approval }), before);
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
  const fixture={format:'ZoneNativeBaseline',version:1,captureStatus:'repeatable',artifactSourceSha:'a'.repeat(40),compatibility:{fixture:'unit-image-only',renderer:{os:'Windows fixture',cpu:'reference CPU',imageVersion:'original image'}},measurements:{},
    scenes:[{id:'songs',image:'songs.png',sha256:digest(await readFile(changed)),viewport:{crop:{width:3,height:3}}}]};
  await writeFile(join(root,'songs.png'),await readFile(changed));
  const candidatePath=join(root,'result.json'); await writeFile(candidatePath,JSON.stringify(fixture));
  const referenceReport={...fixture,compatibility:structuredClone(fixture.compatibility),scenes:[{...fixture.scenes[0],sha256:before}]};
  await writeFile(join(referenceRoot,'songs.png'),await readFile(reference));
  const bytes=JSON.stringify(referenceReport); await writeFile(join(referenceRoot,'result.json'),bytes);
  const approval={format:'ZoneNativeBaselineReference',version:1,candidate:'result.json',candidateSha256:digest(bytes),
    review:{status:'approved',reviewer:'Unit fixture only, not an app baseline',reviewedAt:'2026-10-17T00:00:00Z'},limits:{perChannelTolerance:0,maxChangedPixelRatio:0}};
  const approvalPath=join(referenceRoot,'reference.json'); await writeFile(approvalPath,JSON.stringify(approval));
  assert.equal((await compareNativeBaselines(candidatePath,null,join(root,'pending'))).status,'needs-review');
  // Use different CPU metadata for both the passing and failing pixel cases.
  fixture.compatibility.renderer.cpu = 'different CPU';
  await writeFile(candidatePath,JSON.stringify(fixture));
  const failed = await compareNativeBaselines(candidatePath,approvalPath,join(root,'comparison'));
  assert.equal(failed.status,'failed');
  assert.equal(failed.scenes[0].changedPixels,1);
  assert.deepEqual(failed.scenes[0].limits,{perChannelTolerance:0,maxChangedPixelRatio:0});
  await writeFile(join(root,'songs.png'),await readFile(reference));
  fixture.scenes[0].sha256 = before;
  await writeFile(candidatePath,JSON.stringify(fixture));
  const passed = await compareNativeBaselines(candidatePath,approvalPath,join(root,'cpu-only'));
  assert.equal(passed.status,'passed'); assert.equal(passed.scenes[0].changedPixels,0);
  fixture.compatibility.renderer.imageVersion = 'updated image';
  await writeFile(candidatePath,JSON.stringify(fixture));
  const revisionOnly = await compareNativeBaselines(candidatePath,approvalPath,join(root,'image-revision-only'));
  assert.equal(revisionOnly.status,'passed'); assert.equal(revisionOnly.scenes[0].changedPixels,0);
  assert.equal(revisionOnly.compatibilityNotes[0].field,'renderer.imageVersion');
  // Equal claimed hashes must never bypass verification of the actual PNG bytes.
  await writeFile(join(root,'songs.png'),await readFile(changed));
  await assert.rejects(compareNativeBaselines(candidatePath,approvalPath,join(root,'forged-image-revision')),/recorded hash/);
  fixture.scenes[0].sha256 = digest(await readFile(changed));
  await writeFile(candidatePath,JSON.stringify(fixture));
  const revisionAndPixels = await compareNativeBaselines(candidatePath,approvalPath,join(root,'image-revision-and-pixels'));
  assert.equal(revisionAndPixels.status,'incompatible'); assert.deepEqual(revisionAndPixels.scenes,[]);
  await writeFile(join(root,'songs.png'),await readFile(reference));
  fixture.scenes[0].sha256 = before;
  fixture.compatibility.renderer.os = 'different Windows';
  await writeFile(candidatePath,JSON.stringify(fixture));
  const incompatible = await compareNativeBaselines(candidatePath,approvalPath,join(root,'os-change'));
  assert.equal(incompatible.status,'incompatible'); assert.deepEqual(incompatible.scenes,[]);
  fixture.compatibility.renderer.os = referenceReport.compatibility.renderer.os;
  await writeFile(candidatePath,JSON.stringify(fixture));
  assert.equal(await readFile(join(referenceRoot,'result.json'),'utf8'),bytes);
  assert.equal(digest(await readFile(join(referenceRoot,'songs.png'))),before);
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
