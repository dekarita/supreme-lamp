const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const moduleText = fs.readFileSync('payloads/rdp-telescope.ps1', 'utf8');
const server = fs.readFileSync('payloads/ghrdp-server.ps1', 'utf8');
const workflow = fs.readFileSync('.github/workflows/main.yml', 'utf8');
const lab = fs.readFileSync('.github/workflows/autologin-lab.yml', 'utf8');
const ui = fs.readFileSync('payloads/ui.html', 'utf8');
const launcher = fs.readFileSync('payloads/ghrdp-rdp-launcher.cs', 'utf8');

test('F37 module is the shared JSONL contract and classifies X.224/TLS failures', () => {
  for (const stage of ['dns', 'tcp', 'tls', 'cred', 'logon', 'schannel', 'listener']) {
    assert.ok(moduleText.includes("'" + stage + "'"), `missing ${stage} stage`);
  }
  for (const field of ['schema=', 'traceId=', 'servedThumb=', 'chainStatus=', 'protocol=', 'cipher=', 'failurePoint=', 'boundThumb=', 'aclSids=']) {
    assert.ok(moduleText.includes(field), `missing contract field ${field}`);
  }
  assert.match(moduleText, /RemoteCertificateValidationCallback/);
  assert.match(moduleText, /rst-before-cert/);
  assert.match(moduleText, /name-mismatch/);
  assert.match(moduleText, /chain=/);
  assert.doesNotMatch(moduleText, /CredRead|CredentialBlob|CredentialBlobSize|passwordBytes/i,
    'telescope must never access credential secret/blob bytes');
});

test('F37 is deployed once and runner publishes a live 60-second telescope', () => {
  assert.ok(workflow.includes('payloads/rdp-telescope.ps1'));
  assert.ok(server.includes("Join-Path $Root 'rdp-telescope.ps1'"));
  assert.ok(server.includes('$script:TelescopeIntervalSec = 60'));
  assert.ok(server.includes('Get-RdpTelescope -Target $target'));
  assert.ok(server.includes('NotePropertyName telescope'));
  assert.ok(server.includes('servedThumb'));
});

test('F37 lab prints both dumps and blocks a red bind without the served==bound gate', () => {
  assert.ok(lab.includes("Write-F37Dump 'before-bind'"));
  assert.ok(lab.includes("Write-F37Dump 'after-bind-restart'"));
  assert.ok(lab.includes("$tls.servedThumb -ne $listener.boundThumb"));
  assert.ok(lab.includes('listener-handshake-ok'));
  assert.ok(lab.includes("-Type SSLServerAuthentication"));
});

test('F37 click trace propagates from dashboard URL through launcher to merged live status', () => {
  assert.ok(ui.includes('function ghrdpTraceId()'));
  assert.ok(ui.includes('&trace=\'+ghrdpTraceId()'));
  assert.ok(launcher.includes('TraceFromUri(uri)'));
  assert.ok(launcher.includes('RunClientTelescope(server, host, port)'));
  assert.ok(launcher.includes('RemoteCertificateValidationCallback'));
  assert.ok(launcher.includes('ghrdp-telescope.jsonl'));
  assert.ok(launcher.includes('"diag"'));
  assert.ok(ui.includes("ghrdp://diag?server="));
  assert.ok(launcher.includes('row["traceId"]'));
  assert.ok(server.includes('$hh.traceId = [string]$bj.traceId'));
  assert.ok(server.includes('traceId = $(if ([string]$hb.traceId'));
  assert.ok(ui.includes('function paintRdpTelescope(s)'));
  assert.ok(ui.includes('first red death-point='));
});

test('F37 dashboard timeline joins matching client, runner and auth evidence; first red is named', () => {
  const start = ui.indexOf('function paintRdpTelescope(s)');
  const end = ui.indexOf('// [F24 §3] AUTH-REJECT DISCRIMINATOR', start);
  assert.ok(start >= 0 && end > start);
  const els = {};
  const ctx = { document: { getElementById: id => els[id] || (els[id] = { style: {}, textContent: '' }) }, isFinite, Number, String };
  vm.createContext(ctx);
  vm.runInContext(ui.slice(start, end), ctx);
  ctx.paintRdpTelescope({ launcher: { beacons: [
    { traceId: 'a'.repeat(32), ts: 't1', details: 'telescope-dns-ok', ok: true },
    { traceId: 'a'.repeat(32), ts: 't2', details: 'telescope-tls-fail', ok: false }
  ] }, rdpListener: {
    telescope: { traceId: 'a'.repeat(32), ts: 't3', handshakeOk: false, servedThumb: 'AA', boundThumb: 'BB', items: [
      { traceId: 'a'.repeat(32), stage: 'tls', status: 'fail', failurePoint: 'rst-before-cert', ts: 't3' },
      { traceId: 'a'.repeat(32), stage: 'listener', status: 'ok', boundThumb: 'BB', hasKey: true, inStore: true, aclSids: ['S-1-5-20'] }
    ] }, telescopeAgeSec: 5, authEvents: { count4624: 0, count4625: 1, verdict: 'credential-mismatch' }
  } });
  assert.match(els.rdpTelescopeState.textContent, /first red death-point=client telescope-tls-fail/);
  assert.match(els.rdpTelescopeLines.textContent, /rst-before-cert/);
  assert.match(els.rdpTelescopeLines.textContent, /aclSids=S-1-5-20/);
  assert.match(els.rdpTelescopeLines.textContent, /credential-mismatch/);
  assert.match(els.rdpTelescopeLines.textContent, /servedThumb=AA boundThumb=BB/);
});
