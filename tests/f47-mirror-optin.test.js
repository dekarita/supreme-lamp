// [F47] Mirror per-run opt-in, token plumbing, AES-256 honesty and probe
// visibility gates (offline - no PowerShell interpreter needed here).
//
// §0 ground truth this file answers: the failure row `phase=policy, "no mirror
// host is enabled"` was CORRECT behaviour (mirror default-OFF is a locked
// gate); what was missing was the enable path as a first-class dispatch input,
// the probe matrix on the Mirror page, and a real AES-256 mode behind the
// documented title. These tests pin all three plus the refusals: the shipped
// default stays false, the token is process-env-only, and no host-policy
// evasion may appear in any mirror surface.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

const read = (p) => readFileSync(p, "utf8").replace(/\r\n?/g, "\n");
const code = (text) => text.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");

const main = read(".github/workflows/main.yml");
const gates = read(".github/workflows/launch-gates.yml");
const module = read("payloads/ghrdp-mirror.ps1");
const watcher = read("payloads/ghrdp-watcher.ps1");
const lab = read("tests/f46-mirror-policy.ps1");

// The dispatch-inputs block only. NOTE: splitting on the literal `on:` is not
// enough - `description:` also ends in `on:`, which is why the older check was
// vacuous. Take the text between `workflow_dispatch:` and the top-level
// `permissions:` key instead.
const inputsBlock = (() => {
  const start = main.indexOf("workflow_dispatch:");
  const end = main.indexOf("\npermissions:", start);
  assert.ok(start > 0 && end > start, "main.yml must have a workflow_dispatch block before permissions");
  return main.slice(start, end);
})();

test("F47-1 the per-run opt-in is a first-class dispatch input, default false", () => {
  const enable = inputsBlock.match(/mirror_enable:\n(?:.*\n)*?\s+default: (true|false)/);
  assert.ok(enable, "main.yml must declare a mirror_enable dispatch input");
  assert.equal(enable[1], "false", "mirror_enable must default to false");
  assert.match(inputsBlock, /type: boolean/, "mirror_enable must be a boolean input");
  const enc = inputsBlock.match(/mirror_encrypt:\n(?:.*\n)*?\s+default: (true|false)/);
  assert.ok(enc, "main.yml must declare a mirror_encrypt dispatch input");
  assert.equal(enc[1], "false", "mirror_encrypt must default to false");
  // the F11-5.2 lock is untouched: no bare `mirror:` input, MIRROR_INPUT only
  // ever compared to 'true'.
  assert.equal(/^\s+mirror:/m.test(inputsBlock), false, "a bare `mirror:` dispatch input may not reappear");
  assert.match(main, /MIRROR_INPUT -eq 'true'/, "the unchanged mirror gate must stay");
  const badCmp = main.split("\n").filter((l) => /MIRROR_INPUT'?\s*(-ne|-eq)\s*'?(true|false)'?/.test(l) && !/MIRROR_INPUT -eq 'true'/.test(l));
  assert.deepEqual(badCmp, [], "MIRROR_INPUT may only ever be compared to 'true'");
  assert.match(main, /MIRROR_INPUT: \$\{\{ github\.event\.inputs\.mirror_enable == true && 'true' \|\| 'false' \}\}/, "MIRROR_INPUT must be driven by the dispatch input");
  assert.match(main, /MIRROR_ENCRYPT_INPUT: \$\{\{ github\.event\.inputs\.mirror_encrypt == true && 'true' \|\| 'false' \}\}/, "MIRROR_ENCRYPT_INPUT must be driven by the dispatch input");
});

test("F47-2 the token is process-env-only and never reaches config.json", () => {
  assert.match(main, /GOFILE_TOKEN: \$\{\{ secrets\.GOFILE_TOKEN \}\}/, "the secret must be read into step env");
  assert.match(main, /\[Environment\]::SetEnvironmentVariable\('GHRDP_GOFILE_TOKEN', \$gofileToken, 'User'\)/, "the token must be published to the worker's process environment");
  assert.match(main, /SetEnvironmentVariable\('GHRDP_GOFILE_TOKEN', \$null, 'User'\)/, "cleanup must clear the process-env token");
  // config.json stores the enabled flag + host id only.
  assert.match(main, /mirrorHosts = @\(\$mirrorHostsCfg\)/, "config.json must carry the per-run mirrorHosts entry");
  assert.match(main, /id = 'gofile'; displayName = 'gofile\.io'.*enabled = \$true/, "the opted-in host entry must set enabled=true");
  // a config.json property line is indented and starts with the bare key; the
  // PowerShell local ($gofileToken) is not a config write.
  assert.ok(!/\n\s+gofileToken\s*=/.test(main), "the gofile token may never be written to config.json");
  assert.ok(!/tokenConfigKey\s*=/.test(main), "config.json may not carry a token config key from the stage step");
  assert.ok(!/gofile-token\.txt/.test(main), "the stage step may never write a token file");
  assert.ok(!/\?token=|&token=/.test(main), "no token may appear in a URL");
  // the module reads the process env FIRST, so the dispatch path never needs a
  // config key or a file.
  const fn = module.slice(module.indexOf("function Get-F46HostToken"), module.indexOf("function Protect-F46SecretText"));
  assert.ok(fn.indexOf("$env:GHRDP_GOFILE_TOKEN") < fn.indexOf("'gofileToken'"), "GHRDP_GOFILE_TOKEN must be the first token source");
});

test("F47-3 mirror_enable without the secret is a loud fail-closed stage halt", () => {
  assert.match(main, /if \(\$mirrorOn -and -not \$gofileToken\) \{/, "the stage step must branch on a missing token");
  assert.match(main, /::error::\[F47\] mirror_enable=true but the repo secret GOFILE_TOKEN is not set/, "the halt must be loud");
  assert.match(main, /settings\/secrets\/actions/, "the halt must link the repo Secrets settings");
  assert.match(main, /throw 'F47: mirror_enable=true requires the repo secret GOFILE_TOKEN/, "the stage must throw, never continue");
  assert.match(main, /NO BYPASS/, "the halt must state there is no bypass");
  assert.match(main, /\[validate\] F47 mirror opt-in/, "the validate step must report the opt-in state");
  assert.ok(!/autoAccount = \$true/.test(main), "no silent guest-account fallback may be armed");
});

test("F47-4 AES-256 is real: 32-byte key, named algorithm, honest mime", () => {
  assert.match(module, /keyBytes = 32/, "the key length must be 32 bytes");
  assert.match(module, /gcmNonceBytes = 12/, "the GCM nonce length must be 12 bytes");
  assert.match(module, /gcmTagBytes = 16/, "the GCM tag length must be 16 bytes");
  assert.match(module, /encryptedMime = 'application\/x-ghrdp-mirror'/, "encrypted parts must be stamped with the mirror mime");
  assert.match(module, /function New-F46MirrorKey/, "the per-run key generator must exist");
  assert.match(module, /function Invoke-F46EncryptFile/, "the encryptor must exist");
  assert.match(module, /function Invoke-F46DecryptFile/, "the decryptor must exist (operator + lab round trip)");
  assert.match(module, /function Test-F46AesGcmUsable/, "AES-GCM availability must be proven, never assumed");
  assert.match(module, /AES-256-GCM/, "the GCM mode must be reported by name");
  assert.match(module, /AES-256-CBC-PBKDF2/, "the fallback mode must be reported by name");
  assert.match(module, /if \(@\(\$k\)\.Length -ne \[int\]\$script:F46GofileContract\.keyBytes\) \{ return \$null \}/, "a short key must be refused, never stretched");
  assert.match(module, /function New-F46UploadRequestSpec/, "the multipart contract must be assembled in one place");
  assert.match(module, /param\(\$HostCfg, \[string\]\$Path, \[string\]\$Name, \[string\]\$Token, \[int\]\$TimeoutSec = 120, \$Target = \$null, \[string\]\$ContentType = ''\)/, "the uploader must accept the part Content-Type");
});

test("F47-5 the worker encrypts for real or refuses - it never fakes a flag", () => {
  assert.match(watcher, /Invoke-F46EncryptFile -Path \(\[string\]\$f\.FullName\) -OutPath \$encPath -KeyBase64 \$mirrorKeyText/, "the worker must call the shipped encryptor");
  assert.match(watcher, /-EncryptRequested \$shouldEncrypt -Encrypted \$encApplied -ContentType \$uploadMime/, "the attempt must carry the true encrypt flags + mime");
  assert.match(watcher, /\$encApplied = \$false/, "the encrypted flag must start false");
  assert.match(watcher, /refusing to upload plaintext/, "a missing key must still refuse plaintext");
  assert.match(watcher, /\$uploadMime = \[string\]\$script:F46GofileContract\.encryptedMime/, "the encrypted upload must be stamped with the mirror mime");
  assert.match(watcher, /Protect-F46SecretText -Text \(\[string\]\$res\.hostMessage\) -Secrets @\(\$token, \$mirrorKeyText\)/, "the key must be in the log redaction set");
  assert.match(watcher, /key=redacted\(32B, config mirrorKey\)/, "the encrypt log line must name the key, never print it");
  assert.match(watcher, /encAlg = \$mirrorEncAlg/, "progress must carry the algorithm actually used");
  assert.match(watcher, /GHRDP_GOFILE_TOKEN|\$env:GHRDP_GOFILE_TOKEN|Get-F46HostToken/, "the worker must read the token through the shared ladder");
  assert.ok(!/mirrorKey\s*=\s*\$token|\$cfg\.gofileToken\s*=/.test(watcher), "the worker may never persist the token");
});

test("F47-6 the probe matrix is visible on the Mirror page with operator options", () => {
  const page = read("src/pages/Mirror.tsx");
  const matrix = read("src/components/domain/MirrorHostMatrix.tsx");
  assert.match(page, /<MirrorHostMatrix \/>/, "the Mirror page must render the host matrix card");
  assert.match(matrix, /fetch\("\/diag"/, "the matrix must be read live from /diag");
  assert.match(matrix, /d\.mirrorHosts/, "the matrix must render the /diag mirrorHosts rows");
  assert.match(matrix, /data-testid="mirror-host-matrix"/, "the matrix table must be addressable");
  assert.match(matrix, /data-testid="mirror-host-row"/, "each {host,status,note} row must render");
  assert.match(matrix, /data-testid="mirror-host-operator-options"/, "the operator-options note must render");
  assert.match(matrix, /isBlockedRow/, "a blocked row must be classified");
  assert.match(matrix, /s === "403" \|\| s === "401"/, "403/401 must count as blocked-from-egress");
  assert.match(matrix, /VPS|optionVps/, "the VPS-egress operator option must be offered");
  assert.match(matrix, /optionAccept/, "the accept-unavailable option must be offered");
  assert.match(main, /### F46 mirror host probe \(read-only, runner egress\)/, "the dispatch step summary must print the same table");
  assert.match(main, /\[F47\] mirror opt-in for THIS run/, "the step summary must state the per-run opt-in");
  const body = code(matrix);
  for (const banned of [/Mozilla\/\d/, /X-Forwarded-For/i, /WebProxy/i, /rotat/i, /spoof/i]) {
    assert.ok(!banned.test(body), "the mirror page must not suggest or perform host-policy evasion");
  }
});

test("F47-7 the card title equals the worker mode, and the key is masked", () => {
  const card = read("src/components/domain/MirrorCard.tsx");
  const keys = read("src/components/domain/KeysCard.tsx");
  const en = JSON.parse(read("src/i18n/en.json"));
  assert.match(card, /m\.encryptedAny\s*\n?\s*\? t\("mirror\.titleLong"\)/, "encrypted rows must claim the encrypted title");
  assert.match(card, /: t\("mirror\.titlePlain"\)/, "plaintext must keep the plaintext title");
  assert.equal(en.mirror.titleLong, "Mirror - AES-256 encrypted runner upload", "the encrypted claim must name the mode");
  assert.match(en.mirror.titlePlain, /plaintext/i, "the default title must say plaintext");
  assert.match(card, /mirror\.encryptAlg/, "the reported algorithm must be shown next to the honesty line");
  assert.match(read("src/lib/domain/progress.ts"), /encAlg/, "the view model must carry the reported algorithm");
  assert.match(keys, /MaskedField id="mirrorKey"/, "the per-run key must be masked in the Keys card");
  assert.ok(!/<span id="mirrorKey"/.test(keys), "the key must not be rendered in clear text");
  assert.match(keys, /never logged/, "the key row must state it is never logged");
});

test("F47-8 the lab proves the wire contract, the key and the mime", () => {
  for (const needle of [
    "GHRDP_GOFILE_TOKEN",
    "Bearer f47-wire-token",
    'name="file"',
    "application/x-ghrdp-mirror",
    "GHRDP-F47-PLAINTEXT-MARKER",
    "AES-256-(GCM|CBC-PBKDF2)",
    "New-F46MirrorKey",
    "Invoke-F46DecryptFile",
    "HttpListener",
    "downloadPage",
  ]) {
    assert.ok(lab.includes(needle), `the F47 lab must cover ${needle}`);
  }
  assert.match(lab, /Length -eq 32/, "the lab must assert the 32-byte key length");
  assert.match(lab, /networkCalls -eq 0/, "the token-missing case must prove zero network tries");
  assert.match(lab, /no token in the URL/, "the lab must assert the token stays out of the URL");
  assert.match(lab, /ciphertext \(no plaintext marker on the wire\)/, "the lab must prove the wire carries ciphertext");
  assert.match(lab, /different key does not recover the plaintext/, "the lab must prove the container is authenticated");
  assert.match(lab, /redacted from any log\/artifact text/, "the lab must prove the key is redacted");
  assert.match(gates, /tests\/f46-mirror-policy\.ps1/, "windows-native must run the F46/F47 policy lab");
  assert.match(gates, /F47 mirror opt-in \+ token plumbing \+ AES-256 gates/, "launch-gates must carry the F47 gate step");
});

test("F47-9 docs describe the opt-in, the token path and the AES-256 mode", () => {
  assert.ok(existsSync("docs/MIRROR-HOSTS.md"), "docs/MIRROR-HOSTS.md must exist");
  const doc = read("docs/MIRROR-HOSTS.md");
  for (const needle of [
    "mirror_enable",
    "mirror_encrypt",
    "GOFILE_TOKEN",
    "GHRDP_GOFILE_TOKEN",
    "application/x-ghrdp-mirror",
    "AES-256-GCM",
    "AES-256-CBC-PBKDF2",
    "process env",
    "VPS egress",
  ]) {
    assert.ok(doc.includes(needle), `docs/MIRROR-HOSTS.md must document ${needle}`);
  }
  assert.ok(!/Mozilla|proxy rotat|evade the|bypass the block/i.test(doc), "the doc must not describe evasion");
});

test("F47-10 no malformed try/finally (the parse failure this lane caught)", () => {
  // windows-native reported "The Try statement is missing its Catch or Finally
  // block" 11 times in ghrdp-mirror.ps1: `finally { try { X } } catch { }`
  // closes the finally BEFORE the catch. Pin the shape so it cannot return -
  // a nested try inside a finally must carry its own catch INSIDE the finally.
  const bad = /finally \{ try \{[^{}]*\} \} catch \{ \}/;
  for (const [name, text] of [
    ["ghrdp-mirror.ps1", module],
    ["ghrdp-watcher.ps1", watcher],
    ["f46-mirror-policy.ps1", lab],
    ["main.yml", main],
  ]) {
    assert.ok(!bad.test(text), `${name}: malformed 'finally { try { X } } catch { }' (the catch must sit inside the finally)`);
  }
  // every SINGLE-LINE try in the crypto path must carry its catch/finally on
  // the same line (a multi-line try opens its block on the next lines).
  for (const line of module.split("\n")) {
    if (/\btry \{.*\}/.test(line) && !/\b(catch|finally)\b/.test(line)) {
      assert.fail("a single-line try without catch/finally appeared: " + line.trim());
    }
  }
});
