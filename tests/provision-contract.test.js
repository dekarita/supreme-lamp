const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const provision = fs.readFileSync('payloads/Provision-GhrdpVps.ps1', 'utf8');
const cert = fs.readFileSync('payloads/Enable-RdpTlsCertificate.ps1', 'utf8');
const server = fs.readFileSync('payloads/ghrdp-server.ps1', 'utf8');
const workflow = fs.readFileSync('.github/workflows/main.yml', 'utf8');

test('static VPS account, interactive password and no argv auth key', () => {
  assert.match(provision, /\$TargetUser\s*=\s*'rdpuser'/);
  assert.doesNotMatch(provision, /\[string\]\$TargetUser\s*=/);
  assert.match(provision, /Read-Host\s+-Prompt[^\n]*-AsSecureString/);
  assert.match(provision, /Get-LocalUser -Name \$TargetUser/);
  assert.match(provision, /tailscale up --auth-key \("file:" \+ \$keyFile\.FullName\)/);
  assert.doesNotMatch(provision, /tailscale up --auth(?:key|-key)\s+\$env:TS_AUTHKEY/);
  assert.match(provision, /finally\s*\{\s*Remove-Item -LiteralPath \$keyFile\.FullName/);
});

test('NLA/CredSSP, LE cert and tailnet-only firewall precede opening RDP', () => {
  assert.match(provision, /UserAuthentication -Value 1 -Type DWord/);
  assert.match(provision, /SecurityLayer -Value 2 -Type DWord/);
  assert.match(provision, /& \$certScript -Fqdn \$fqdn/);
  assert.match(cert, /tailscale cert --cert-file \$crtPath --key-file \$keyPath \$Fqdn/);
  assert.match(cert, /GetNameInfo\(/);
  assert.match(cert, /\$chain\.Build\(\$loaded\)/);
  assert.match(cert, /SetSSLCertificateSHA1Hash/);
  assert.match(cert, /Persisted machine key not found/);
  assert.match(cert, /S-1-5-20/);
  assert.match(provision, /-RemoteAddress '100\.64\.0\.0\/10' -InterfaceAlias \$tsAlias/);
  assert.match(provision, /-LocalAddress \$tsIp/);
  assert.ok(provision.indexOf('New-NetFirewallRule -Name') < provision.indexOf('fDenyTSConnections -Value 0'));
  assert.match(server, /\$dns -ne \$fqdnN/); // no "LE issuer but wrong host" false positive
});

test('VPS identity and token are persisted without an RDP password', () => {
  assert.match(provision, /hostKind = 'vps'; dnsName = \$fqdn/);
  assert.match(provision, /config\.json/);
  assert.match(provision, /hostKind\.txt/);
  assert.match(provision, /dash-token\.txt/);
  assert.match(provision, /Protect-Path -Path \$tokenPath/);
  assert.doesNotMatch(provision, /\$cfg\s*\|\s*Add-Member[^\n]*rdpPass/);
  assert.match(provision, /for \(\$attempt = 1; \$attempt -le 10;/);
});

test('VNC_PASS missing fails closed before install, with summary/link and config reason', () => {
  const start = workflow.indexOf('- name: Web desktop (noVNC + TightVNC');
  const end = workflow.indexOf('      - name:', start + 10);
  assert.ok(start >= 0 && end > start);
  const step = workflow.slice(start, end);
  const guard = step.indexOf('if (-not $env:VNC_PASS)');
  assert.ok(guard >= 0 && guard < step.indexOf('Invoke-TvnPasswordLadder -Pass'));
  assert.match(step, /https:\/\/github\.com\/dekarita\/supreme-lamp\/settings\/secrets\/actions/);
  assert.match(step, /GITHUB_STEP_SUMMARY/);
  assert.match(step, /webdeskReason' -NotePropertyValue 'vnc-pass-missing'/);
  assert.match(step, /vncPassAdminUrl' -NotePropertyValue \$link/);
  assert.match(step, /webdeskUrl' -NotePropertyValue ''/);
  assert.match(step, /throw "VNC_PASS missing\. Halted by design/);
  assert.doesNotMatch(step, /TightVNC install error:.*Exception\.Message/);
});

test('stage gate retries transient Tailscale DNS reads before halting', () => {
  assert.match(workflow, /for \(\$dnsTry = 1; \$dnsTry -le 10; \$dnsTry\+\+\)/);
  assert.match(workflow, /\[stage\] dns read attempt/);
  assert.match(workflow, /Start-Sleep -Seconds 5/);
});
