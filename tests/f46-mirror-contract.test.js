// [F46] Mirror worker contract, policy parity and honesty gates (offline).
//
// The PowerShell policy in payloads/ghrdp-mirror.ps1 must be the SAME contract
// as the F44/S3 retry policy (src/components/explorer/api/retryPolicy.ts +
// errors.ts): fail-fast 401/403/413/415, transient-only dns|tcp|tls|http,
// 5 attempts, jittered backoff with a Retry-After FLOOR. The worker must emit
// one structured line per attempt and never the old bare "upload failed after
// 5 tries" string. Mirror uploads stay default-OFF; no evasion pattern may
// appear in any mirror surface.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

const read = (p) => readFileSync(p, "utf8").replace(/\r\n?/g, "\n");
// Code-only view: documented explanations (comment lines) are allowed to NAME a
// banned pattern while documenting why it is forbidden; only real code counts.
const code = (text) => text.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
const module = read("payloads/ghrdp-mirror.ps1");
const watcher = read("payloads/ghrdp-watcher.ps1");
const server = read("payloads/ghrdp-server.ps1");
const fx = read("payloads/ghrdp-fx.ps1");
const main = read(".github/workflows/main.yml");
const gates = read(".github/workflows/launch-gates.yml");

test("F46-1 the policy constants match the F44/S3 TypeScript contract", () => {
  const errors = read("src/components/explorer/api/errors.ts");
  const policy = read("src/components/explorer/api/retryPolicy.ts");
  const ff = errors.match(/FAIL_FAST_HTTP:\s*readonly number\[\]\s*=\s*\[([^\]]*)\]/);
  assert.ok(ff, "FAIL_FAST_HTTP not found in errors.ts");
  const tsFailFast = ff[1].split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
  const psFailFast = module.match(/\$script:F46FailFastStatuses = @\(([^)]*)\)/);
  assert.ok(psFailFast, "F46FailFastStatuses not found");
  const psFF = psFailFast[1].split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
  assert.deepEqual(psFF.sort(), tsFailFast.sort(), "fail-fast statuses must match errors.ts");
  const tsTransient = policy.match(/TRANSIENT_PHASES:\s*readonly UploadPhase\[\]\s*=\s*\[([^\]]*)\]/);
  const tsPhases = [...tsTransient[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
  const psTransient = module.match(/\$script:F46TransientPhases = @\(([^)]*)\)/);
  const psPhases = [...psTransient[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
  assert.deepEqual(psPhases.sort(), tsPhases.sort(), "transient phases must match retryPolicy.ts");
  const tsMax = Number(policy.match(/MAX_TRANSIENT_ATTEMPTS = (\d+)/)[1]);
  assert.equal(Number(module.match(/\$script:F46MaxAttempts = (\d+)/)[1]), tsMax, "max attempts must match");
  for (const [tsName, psName] of [["BACKOFF_BASE_MS", "F46BackoffBaseMs"], ["BACKOFF_CAP_MS", "F46BackoffCapMs"], ["BACKOFF_FLOOR_MS", "F46BackoffFloorMs"], ["RETRY_AFTER_CAP_MS", "F46RetryAfterCapMs"]]) {
    const ts = Number(policy.match(new RegExp(`${tsName} = (\\d+)`))[1]);
    const ps = Number(module.match(new RegExp(`\\$script:${psName} = (\\d+)`))[1]);
    assert.equal(ps, ts, `${psName} must equal ${tsName}`);
  }
  assert.match(module, /Retry-After hint is a FLOOR/, "the Retry-After floor rule must be documented in the module");
  assert.match(module, /function Format-F46AttemptTableText/, "the attempt table formatter must exist under its documented name");
});

test("F46-2 the documented gofile contract is pinned and token-less (F48 guest mode)", () => {
  assert.match(module, /serversPath = '\/servers'/, "GET /servers must be pinned (probe + two-step flow)");
  assert.match(module, /uploadPathAuto = '\/uploadfile'/, "the current reference upload path must be pinned");
  assert.match(module, /uploadPathFleet = '\/contents\/uploadfile'/, "the fleet upload path must be pinned");
  assert.match(module, /multipartField = 'file'/, "the multipart field name must be `file`");
  assert.match(module, /idFields = @\('fileId', 'id'\)/, "the response id field must accept the current `id` and the legacy `fileId`");
  assert.match(module, /pageFields = @\('downloadPage', 'directLink'\)/, "the page field must accept `downloadPage` and legacy `directLink`");
  assert.match(module, /envelopeField = 'status'/, "the status envelope must be branched on");
  assert.match(module, /function Send-F46GofileUpload/, "the uploader must exist");
  // [F48 §0] token-less guest contract: no auth scheme, no account mint, no
  // auth header, no token rung anywhere in the module (comments included).
  assert.ok(!code(module).includes("authScheme"), "the Bearer auth scheme must be gone (code lines)");
  assert.ok(!code(module).includes("Authorization"), "no auth header may exist toward the host (code lines)");
  assert.ok(!module.includes("New-F46GofileAccount"), "the account-minting rung must be gone");
  assert.ok(!module.includes("Get-F46HostToken"), "the token ladder must be gone");
  assert.match(module, /Format-F48AuthReason/, "the labeled auth refusal reason must exist");
  assert.match(module, /host requires account token; token-less mode unsupported/, "the exact F48 auth reason must be pinned");
  assert.match(module, /authMode = 'guest'/, "the default authMode must be guest");
  assert.ok(!/token=\$Token|token=' \+ \$Token|\?token=/.test(code(module)), "a token must never be put in a URL");
});

test("F46-3 the legacy watcher emits one structured line per attempt", () => {
  assert.match(watcher, /ghrdp-mirror\.ps1/, "the watcher must dot-source the module");
  assert.match(watcher, /Invoke-F46MirrorAttempt/, "the watcher must call the shared attempt engine");
  assert.match(watcher, /Format-F46AttemptLine/, "attempt lines must be formatted by the module");
  assert.match(watcher, /Format-F46FailureSummary/, "a terminal failure must name host/phase/status/attempts");
  assert.match(watcher, /Format-F46Reason/, "the UI reason string must be phase+status+msg");
  assert.match(watcher, /mirrorDiag/, "the attempt table must reach progress.json");
  assert.match(watcher, /mirrorNextAt/, "retries must be scheduled per file");
  assert.match(watcher, /Get-F46BackoffMs/, "the retry delay must come from the shared policy");
  assert.match(watcher, /Get-F46MaxAttempts/, "the attempt budget must come from the shared policy");
  assert.ok(!watcher.includes("upload failed after 5 tries"), "the bare five-try string must be retired");
  assert.ok(!watcher.includes("FAILED after {0} tries"), "the bare 'FAILED after N tries' line must be retired");
  assert.ok(!/\$maxTries\b/.test(watcher), "the fixed maxTries counter must be gone");
  assert.ok(!/\$tries\[/.test(watcher), "the blind tries map must be gone");
  assert.match(watcher, /phase=parse status=- msg=/, "a missing module must still produce a labeled reason");
  assert.match(watcher, /refusing to upload plaintext/, "the encrypt lock must be explicit, never a silent plaintext upload");
  assert.match(watcher, /encrypted=\{3\}/, "the upload line must carry the true encrypted flag");
  assert.match(watcher, /\$encApplied = \$false/, "the encrypted flag must start false and only change with a real ciphertext");
});

test("F46-4 the worker never uses evasion patterns", () => {
  for (const [name, text] of [["mirror module", module], ["watcher", watcher], ["server", server], ["fx module", fx]]) {
    const body = code(text);
    assert.ok(!/Mozilla\/\d/.test(body), `${name}: a spoofed browser User-Agent must not appear`);
    assert.ok(!/\$headers\[.X-Forwarded-For/.test(body), `${name}: header spoofing must not appear`);
    // [F91] a word-boundary lookbehind: `streamProxy = $true` (a /api/version
    // feature flag for the audio relay) is not `proxy =` and was never the
    // evasion this gate bans; an actual proxy assignment still trips it.
    assert.ok(!/(?<![A-Za-z0-9_.-])proxy\s*=|WebProxy|\[System\.Net\.WebProxy\]/i.test(body), `${name}: proxy rotation must not appear`);
    assert.ok(!/rotat/i.test(body), `${name}: identity/IP rotation must not appear`);
  }
  assert.ok(!/-A 'Mozilla/.test(watcher), "the watcher must not spoof a User-Agent in its link check");
});

test("F46-5 the server Diagnose output carries the read-only matrix + attempt table", () => {
  assert.match(server, /ghrdp-mirror\.ps1/, "the server must load the mirror module");
  assert.match(server, /Get-F52HostMatrix/, "the Diagnose probe reads the same cached read-only host matrix (F52)");
  assert.match(server, /mirrorHosts = @\(\$mirrorRows\)/, "the probe matrix must be in /diag");
  assert.match(server, /mirrorAttempts = @\(\$mirrorAttempts\)/, "the attempt table must be in /diag");
  assert.match(server, /mirrorPolicy = \$mirrorPolicy/, "the policy must be reported verbatim");
  const probeBlock = module.slice(module.indexOf("function Invoke-F46HostProbe"), module.indexOf("function Invoke-F46HostProbe") + 2400);
  assert.match(probeBlock, /read-only|no content is uploaded/i, "the probe must be documented read-only");
  assert.match(module, /policy\/endpoint level rejection/, "an all-403 egress must be documented as a policy dead-end");
});

test("F46-6 the fx uploader delegates to the one shared contract", () => {
  assert.match(fx, /function Send-FxGofileUpload/, "the uploader wrapper must stay");
  assert.match(fx, /Send-F46GofileUpload -HostCfg \$hostCfg -Path \$Path -Name \$name -TimeoutSec 120/, "the wrapper must delegate to the shared contract (guest, no credential)");
  assert.ok(!fx.includes("Get-FxGofileToken"), "the fx host-token ladder must be gone");
  assert.ok(!fx.includes("GHRDP_FX_GOFILE" + "_TOKEN"), "the fx token env var must be gone");
  assert.ok(!fx.includes("gofile-token.txt"), "the fx token file rung must be gone");
  assert.match(fx, /Get-F46MaxAttempts/, "the fx retry budget must come from the shared policy");
  assert.match(fx, /Get-F46BackoffMs/, "the fx retry delay must come from the shared policy");
  assert.ok(!fx.includes("https://<store>.gofile.io/contents/uploadfile"), "the stale inline endpoint comment/flow must be gone");
});

test("F46-7 mirror stays default-OFF and the probe never uploads in CI", () => {
  assert.match(module, /enabled = \$false/, "a host must default to disabled");
  assert.match(main, /MIRROR_INPUT -eq 'true'/, "the unchanged mirror gate must stay");
  // [F47] the old split("on:") slice ended at the first `description:` (which
  // also ends in "on:"), so this check was vacuous. Slice the real block.
  const dispatchBlock = main.slice(main.indexOf("workflow_dispatch:"), main.indexOf("\npermissions:"));
  assert.ok(dispatchBlock.includes("runner_target"), "the dispatch block must be the real inputs block");
  assert.equal(/^\s+mirror:/m.test(dispatchBlock), false, "no bare `mirror:` dispatch input may reappear (mirror_enable/mirror_encrypt are the F47 opt-in inputs)");
  const defFalse = dispatchBlock.match(/mirror_enable:[\s\S]*?default: (true|false)/);
  assert.ok(defFalse && defFalse[1] === "true", "F59: mirror_enable must default to true (dispatch); the shipped host default stays disabled");
  assert.match(main, /F46 mirror host read-only probe/, "main.yml must run the read-only probe");
  assert.match(main, /no content upload/i, "the probe step must state that it uploads nothing");
  assert.match(main, /rdp-diag\/mirror-\*/, "the mirror-diag artifact must carry probe + attempt table");
  assert.match(main, /payloads\/ghrdp-mirror\.ps1/, "main.yml must stage the module");
  assert.match(gates, /'payloads\/ghrdp-mirror\.ps1'/, "windows-native must parse the module");
  assert.match(gates, /tests\/f46-mirror-policy\.ps1/, "windows-native must run the F46 policy lab");
});

test("F46-9 the UI renders the full reason and claims encryption honestly", () => {
  const card = read("src/components/domain/MirrorCard.tsx");
  const progress = read("src/lib/domain/progress.ts");
  const html = read("payloads/ui.html");
  const t = JSON.parse(read("src/i18n/en.json")).mirror;
  assert.ok(!/error\.slice\(0, ?4?[0-9]\)/.test(card), "the v2 error cell must not slice the reason");
  assert.ok(!/substring\(0, ?4?[0-9]\)/.test(html), "the v1 error cell must not substring the reason");
  assert.match(card, /mirror-reason-full/, "the v2 reason must render in full");
  assert.match(html, /errfull/, "the v1 reason must render in full");
  assert.match(card, /claimTitle/, "the card title must be derived from the reported encryption");
  assert.match(card, /mirror\.titlePlain/, "the plaintext claim must exist");
  assert.match(card, /mirror\.titleEncryptLocked/, "the encrypt-locked claim must exist");
  assert.equal(t.titleLong, "Mirror - AES-256 encrypted runner upload", "the encrypted claim stays for encrypted rows (F47 wording)");
  assert.match(t.titlePlain, /plaintext/i, "the default title must say plaintext");
  assert.match(progress, /encryptMode/, "the UI model must carry the reported encryptMode");
  assert.match(progress, /encryptedAny/, "the UI model must derive encryptedAny from the worker rows");
  assert.match(progress, /attempts/, "the UI model must carry the attempt records");
  assert.ok(existsSync("src/tests/smoke/f46-mirror-truth.test.tsx"), "the DOM truth test must exist");
});

test("F46-10 the mock host declares the whole policy matrix", () => {
  const handlers = read("src/components/explorer/data/fixtures/gofile-mock-server/handlers.ts");
  for (const scenario of ["success", "403", "413", "415", "429", "500", "502", "tls-reset"]) {
    assert.ok(handlers.includes(`'${scenario}'`), `the mock host must declare scenario ${scenario}`);
  }
  assert.match(handlers, /HttpResponse\.error\(\)/, "tls-reset must be a transport failure, not an HTTP code");
  const mockPaths = {
    "/servers": "the server-list (probe) path",
    "/uploadfile": "the documented reference upload path",
    "/contents/uploadfile": "the documented fleet upload path",
    "downloadPage: MOCK_GOFILE_DOWNLOAD_PAGE": "the documented downloadPage field (fileId/directLink stay as the legacy alias)",
  };
  for (const [token, why] of Object.entries(mockPaths)) {
    assert.ok(handlers.includes(token), `the MSW mock host must pin ${why} (${token})`);
  }
  const smoke = read("src/tests/smoke/fx-gofile-mock.test.tsx");
  assert.match(smoke, /expectNoAuthHeaders/, "the mock upload request must be inspected for auth headers (none allowed)");
  assert.ok(!smoke.includes("MOCK_GOFILE" + "_TOKEN"), "no token fixture may remain in the mock lane");
  assert.match(smoke, /MOCK_GOFILE_UPLOAD_ORIGIN/, "the documented upload origin must be exercised");
  assert.match(smoke, /tls-reset is a transport rejection/, "the transport failure must be asserted as a rejection");
  const lab = read("tests/f46-mirror-policy.ps1");
  assert.match(lab, /@\(\$r403\.attempts\)\.Count -eq 1/, "the lab must assert fail-fast attempt counts");
  assert.match(lab, /@\(\$r429\.attempts\)\.Count -eq 5/, "the lab must assert the transient attempt budget");
  for (const scenario of ["403", "413", "415", "429", "500", "502", "tls-reset"]) {
    assert.ok(lab.includes(`^${scenario}$`), `the policy lab must cover ${scenario}`);
  }
});

test("F46-8 docs pin the contract, the policy and the operator options", () => {
  assert.ok(existsSync("docs/MIRROR-HOSTS.md"), "docs/MIRROR-HOSTS.md must exist");
  const doc = read("docs/MIRROR-HOSTS.md");
  for (const needle of ["GET https://api.gofile.io/servers", "upload.gofile.io/uploadfile", "contents/uploadfile", "downloadPage", "401 / 403 / 413 / 415", "Retry-After", "read-only", "VPS egress", "token-less guest mode", "host requires account token; token-less mode unsupported", "Probe procedure", "X-Gofile-Token"]) {
    assert.ok(doc.includes(needle), `docs/MIRROR-HOSTS.md must document ${needle}`);
  }
  assert.ok(!/Mozilla|proxy rotat|evade|bypass/i.test(doc), "the doc must not describe evasion");
});
