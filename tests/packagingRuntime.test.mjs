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
