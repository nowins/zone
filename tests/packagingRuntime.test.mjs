import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const directory = resolve('.tmp/packaging-runtime');
mkdirSync(directory, { recursive: true });
let sequence = 0;
function powershell(code, environment = {}) {
  const path = resolve(directory, `probe-${sequence++}.ps1`);
  writeFileSync(path, '\ufeff' + code, 'utf8');
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('ZONE_')) delete env[key];
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path], { encoding: 'utf8', env: { ...env, ...environment } });
  return { status: result.status, output: result.stdout + result.stderr };
}
const store = resolve('packaging/build-store.ps1').replaceAll("'", "''");
test('formal Store preflight rejects missing signing and hosted release configuration', { skip: process.platform !== 'win32' }, () => {
  const result = powershell(`& '${store}' -ValidateOnly`);
  assert.notEqual(result.status, 0);
  for (const key of ['ZONE_CERT_THUMBPRINT', 'ZONE_INSTALLER_URL', 'ZONE_PRIVACY_URL', 'ZONE_SUPPORT_URL', 'ZONE_DOWNLOAD_URL', 'ZONE_PUBLISHER']) assert.ok(result.output.includes(key), key);
});
test('Store preflight rejects insecure and credential-bearing links before building', { skip: process.platform !== 'win32' }, () => {
  for (const url of ['http://example.com/privacy', 'https://user:pass@example.com/privacy', 'https://localhost/privacy']) {
    const result = powershell(`& '${store}' -AllowUnsigned -ValidateOnly`, { ZONE_PRIVACY_URL: url });
    assert.notEqual(result.status, 0, url);
    assert.match(result.output, /ZONE_PRIVACY_URL/);
  }
});
test('Store preflight requires an immutable filename for the current version', { skip: process.platform !== 'win32' }, () => {
  const result = powershell(`& '${store}' -AllowUnsigned -ValidateOnly`, { ZONE_INSTALLER_URL: 'https://example.com/latest.exe' });
  assert.notEqual(result.status, 0); assert.match(result.output, /Zone_\d+\.\d+\.\d+_x64-setup\.exe/);
});
test('Store preflight rejects locally trusted development certificates as formal signing', { skip: process.platform !== 'win32' }, () => {
  const result = powershell(`
    Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1')
    $cert = Get-ChildItem Cert:\\CurrentUser\\My | Where-Object { $_.HasPrivateKey -and $_.Subject -eq $_.Issuer } | Select-Object -First 1
    if (-not $cert) { Write-Output 'No self-signed fixture installed'; exit 0 }
    $env:ZONE_CERT_THUMBPRINT = $cert.Thumbprint
    try { & '${store}' -AllowUnsigned -ValidateOnly; throw 'Self-signed certificate accepted' }
    catch { if ($_.Exception.Message -notmatch '自签证书') { throw }; Write-Output 'Development certificate rejected' }
  `);
  assert.equal(result.status, 0, result.output); assert.match(result.output, /Development certificate rejected|No self-signed fixture installed/);
});
test('MSIX packaging stops after a failed native build instead of reusing a stale exe', { skip: process.platform !== 'win32' }, () => {
  const msix = resolve('packaging/build-msix.ps1').replaceAll("'", "''");
  const result = powershell(`
    function npx { $global:LASTEXITCODE = 31 }
    function winapp { throw 'Unexpected packaging call' }
    try { & '${msix}'; throw 'Build failure was ignored' }
    catch { if ($_.Exception.Message -notmatch 'release.*构建失败') { throw }; Write-Output 'Stopped before staging and packaging' }
  `);
  assert.equal(result.status, 0, result.output); assert.match(result.output, /Stopped before staging/);
});

const msix = resolve('packaging/build-msix.ps1').replaceAll("'", "''");
const identity = {
  ZONE_MSIX_PACKAGE_NAME: '12345.ExampleZone',
  ZONE_MSIX_PUBLISHER: 'CN=12345678-1234-1234-1234-123456789012',
  ZONE_MSIX_PUBLISHER_DISPLAY_NAME: 'Example Publisher',
  ZONE_PRIVACY_URL: 'https://example.com/privacy',
  ZONE_SUPPORT_URL: 'https://example.com/support',
};

test('MSIX Store preflight requires identity and public policy links without EXE signing or hosting', { skip: process.platform !== 'win32' }, () => {
  const missing = powershell(`& '${msix}' -ForStore -ValidateOnly`);
  assert.notEqual(missing.status, 0);
  for (const key of Object.keys(identity)) assert.ok(missing.output.includes(key), key);
  assert.ok(!missing.output.includes('ZONE_CERT_THUMBPRINT'));
  assert.ok(!missing.output.includes('ZONE_INSTALLER_URL'));
  const valid = powershell(`& '${msix}' -ForStore -ValidateOnly`, identity);
  assert.equal(valid.status, 0, valid.output);
});

test('MSIX Store preflight rejects placeholder identity, unsafe links, development signing and stale build reuse', { skip: process.platform !== 'win32' }, () => {
  for (const [arguments_, environment] of [
    ['-ForStore -ValidateOnly', { ...identity, ZONE_MSIX_PACKAGE_NAME: 'ZonePlayer' }],
    ['-ForStore -ValidateOnly', { ...identity, ZONE_SUPPORT_URL: 'https://user:secret@example.com/support' }],
    ['-ForStore -ValidateOnly', { ...identity, ZONE_MSIX_PACKAGE_NAME: 'bad/name' }],
    ['-ForStore -ValidateOnly -Cert development.pfx', identity],
    ['-ForStore -ValidateOnly -SkipBuild', identity],
  ]) {
    const result = powershell(`& '${msix}' ${arguments_}`, environment);
    assert.notEqual(result.status, 0, result.output);
  }
  const development = powershell(`& '${msix}' -ValidateOnly`);
  assert.equal(development.status, 0, development.output);
  assert.match(development.output, /ZonePlayer.Validation/);
});

test('Hyper-V matrix rejects an unrelated second VM before restoring the first VM', { skip: process.platform !== 'win32' }, () => {
  const runner = resolve('packaging/test-msix-hyperv.ps1').replaceAll("'", "''");
  const fixture = resolve(directory, 'hyperv-guard').replaceAll("'", "''");
  const result = powershell(`
    $ErrorActionPreference = 'Stop'
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    New-Item -ItemType Directory -Path '${fixture}' -Force | Out-Null
    $name = 'ZonePlayer.Validation'; $publisher = 'CN=Zone MSIX Validation'
    $rsa = [Security.Cryptography.RSA]::Create(2048)
    $request = [Security.Cryptography.X509Certificates.CertificateRequest]::new($publisher, $rsa, [Security.Cryptography.HashAlgorithmName]::SHA256, [Security.Cryptography.RSASignaturePadding]::Pkcs1)
    $cert = $request.CreateSelfSigned([DateTimeOffset]::Now.AddDays(-1), [DateTimeOffset]::Now.AddDays(1))
    [IO.File]::WriteAllBytes('${fixture}/public.cer', $cert.Export([Security.Cryptography.X509Certificates.X509ContentType]::Cert))
    $cert.Dispose(); $rsa.Dispose()
    foreach ($entry in @(@('old','1.0.0.0'), @('new','1.0.1.0'))) {
      $path = '${fixture}/' + $entry[0] + '.msix'
      if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path }
      $zip = [IO.Compression.ZipFile]::Open($path, [IO.Compression.ZipArchiveMode]::Create)
      $stream = $zip.CreateEntry('AppxManifest.xml').Open()
      $writer = [IO.StreamWriter]::new($stream)
      $writer.Write('<Package><Identity Name="' + $name + '" Publisher="' + $publisher + '" Version="' + $entry[1] + '" ProcessorArchitecture="x64" /></Package>')
      $writer.Dispose(); $zip.CreateEntry('AppxSignature.p7x') | Out-Null; $zip.Dispose()
    }
    $ids = @('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222')
    $checkpoint = '33333333-3333-3333-3333-333333333333'
    @{ machines = @(@{os='Windows10';vmId=$ids[0];checkpointId=$checkpoint;credentialFile='ignored.xml'}, @{os='Windows11';vmId=$ids[1];checkpointId=$checkpoint;credentialFile='ignored.xml'}) } | ConvertTo-Json -Depth 4 | Set-Content '${fixture}/matrix.json' -Encoding UTF8
    function Import-Module {}
    function Get-VM { param($Id) [pscustomobject]@{Id=$Id;Name='Fixture';Notes=$(if ($Id.ToString() -eq $ids[0]) {'Zone MSIX disposable test VM'} else {'Ubuntu business VM'})} }
    function Get-VMSnapshot { [pscustomobject]@{Id=[Guid]$checkpoint} }
    function Import-Clixml { [Management.Automation.PSCredential]::new('fixture', [Security.SecureString]::new()) }
    function Restore-VMSnapshot { throw 'Unsafe restore executed' }
    function Start-VM { throw 'Unsafe start executed' }
    try {
      & '${runner}' -Config '${fixture}/matrix.json' -BaselinePackage '${fixture}/old.msix' -CandidatePackage '${fixture}/new.msix' -Certificate '${fixture}/public.cer'
      throw 'Unrelated VM accepted'
    } catch {
      if ($_.Exception.Message -notmatch '专用测试标记') { throw }
      Write-Output 'Rejected all VM mutations before restore'
    }
  `);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /Rejected all VM mutations before restore/);
});

test('guest lifecycle script refuses host execution and arbitrary working directories before installation', { skip: process.platform !== 'win32' }, () => {
  const guest = resolve('packaging/test-msix-guest.ps1').replaceAll("'", "''");
  const result = powershell(`
    function Get-CimInstance { [pscustomobject]@{Model='Physical workstation';Manufacturer='Fixture'} }
    function Import-Certificate { throw 'Unsafe certificate import' }
    function Add-AppxPackage { throw 'Unsafe host installation' }
    try { & '${guest}' -Directory $env:TEMP -ExpectedOS Windows11; throw 'Arbitrary directory accepted' }
    catch { if ($_.Exception.Message -notmatch '专用.*目录') { throw } }
    $directory = Join-Path $env:ProgramData 'ZoneMsixTest/44444444444444444444444444444444'
    try { & '${guest}' -Directory $directory -ExpectedOS Windows11; throw 'Host accepted' }
    catch { if ($_.Exception.Message -notmatch '不能修改宿主机') { throw } }
    Write-Output 'Host and arbitrary directory rejected before installation'
  `);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /Host and arbitrary directory rejected before installation/);
});

test('offline WebView2 staging rejects arbitrary destinations before downloading or extracting', { skip: process.platform !== 'win32' }, () => {
  const script = resolve('packaging/prepare-msix-runtime.ps1').replaceAll("'", "''");
  const result = powershell(`
    function Invoke-WebRequest { throw 'Unexpected download' }
    function expand.exe { throw 'Unexpected extraction' }
    try { & '${script}' -Destination $env:TEMP; throw 'Arbitrary destination accepted' }
    catch { if ($_.Exception.Message -notmatch 'MSIX.*临时打包目录') { throw } }
    Write-Output 'Rejected arbitrary destination before download and extraction'
  `);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /Rejected arbitrary destination/);
});

test('restored test VMs start from saved state, resume paused state and reject unrelated VMs', { skip: process.platform !== 'win32' }, () => {
  const helper = resolve('packaging/hyperv-vm-state.ps1').replaceAll("'", "''");
  const result = powershell(`
    . '${helper}'
    $global:started = 0; $global:resumed = 0
    $fixture = [pscustomobject]@{ Id = [Guid]::NewGuid(); Notes = 'Zone MSIX disposable test VM'; State = 'Saved' }
    function Get-VM { $fixture }
    function Start-VM { $global:started++ }
    function Resume-VM { $global:resumed++ }
    foreach ($state in @('Saved','Off','Paused','Running')) { $fixture.State = $state; Start-MsixTestVM $fixture }
    if ($started -ne 2 -or $resumed -ne 1) { throw 'Restore state was not handled correctly' }
    $fixture.Notes = 'Unrelated VM'; $fixture.State = 'Saved'
    try { Start-MsixTestVM $fixture; throw 'Unrelated VM accepted' }
    catch { if ($_.Exception.Message -notmatch '专用测试标记') { throw } }
    if ($started -ne 2 -or $resumed -ne 1) { throw 'Unrelated VM was changed' }
    Write-Output 'Restored saved and paused states handled; unrelated VM rejected'
  `);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /Restored saved and paused states handled/);
});
