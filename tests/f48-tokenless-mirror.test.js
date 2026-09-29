// [F48] TOKEN-LESS MIRROR MODE gates (offline) - operator directive §0/§1/§3.
//
// Ground truth: F47 plumbed a mirror account token (secret -> step env ->
// user env -> attempt header) and halted staging when it was missing. F48
// deletes ALL of that: the mirror uploads ONLY with the anonymous guest
// multipart contract (no Authorization, no X-Gofile-Token, no Cookie toward
// the host, nothing in a URL), a missing credential is the NORMAL state
// (never a halt), authMode comes from probe/attempt results only, and CI
// fails if the banished secret name, a host-bound auth header, or a
// missing-token staging halt ever reappears. AES-256 honesty, the probe
// matrix and the default-OFF lock are F47 leftovers that stay enforced.
//
// NOTE (self-scan safe): this file must never contain the literal banished
// secret name either - the repo-wide gate greps for GOFILE[_]TOKEN and this
// suite spells every occurrence with the same bracket trick.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

const read = (p) => readFileSync(p, "utf8").replace(/\r\n?/g, "\n");
const code = (text) => text.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
const tsCode = (text) => text.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

const BANISHED = /GOFILE[_]TOKEN/; // never spelled literally anywhere below
const main = read(".github/workflows/main.yml");
const gates = read(".github/workflows/launch-gates.yml");
const modulePs = read("payloads/ghrdp-mirror.ps1");
const watcher = read("payloads/ghrdp-watcher.ps1");
const fx = read("payloads/ghrdp-fx.ps1");
const lib = read("payloads/ghrdp-lib.ps1");
const lab = read("tests/f46-mirror-policy.ps1");

const inputsBlock = (() => {
  const start = main.indexOf("workflow_dispatch:");
  const end = main.indexOf("\npermissions:", start);
  assert.ok(start > 0 && end > start, "main.yml must have a workflow_dispatch block before permissions");
  return main.slice(start, end);
})();

test("F48-1 the opt-in stays default false; encryption defaults true per F52", () => {
  const enable = inputsBlock.match(/mirror_enable:\n(?:.*\n)*?\s+default: (true|false)/);
  assert.ok(enable && enable[1] === "false", "mirror_enable must stay a boolean input defaulting to false");
  const enc = inputsBlock.match(/mirror_encrypt:\n(?:.*\n)*?\s+default: (true|false)/);
  assert.ok(enc && enc[1] === "true", "F52: mirror_encrypt defaults true; only explicit false elects manual plaintext");
  assert.equal(/^\s+mirror:/m.test(inputsBlock), false, "a bare `mirror:` dispatch input may not reappear");
  assert.match(main, /MIRROR_INPUT -eq 'true'/, "the unchanged mirror gate must stay");
  const badCmp = main.split("\n").filter((l) => /MIRROR_INPUT'?\\s*(-ne|-eq)\\s*'?(true|false)'?/.test(l) && !/MIRROR_INPUT -eq 'true'/.test(l));
  assert.deepEqual(badCmp, [], "MIRROR_INPUT may only ever be compared to 'true'");
  assert.match(main, /MIRROR_INPUT: \$\{\{ github\.event\.inputs\.mirror_enable == true && 'true' \|\| 'false' \}\}/, "MIRROR_INPUT must be driven by the dispatch input");
  assert.match(main, /MIRROR_ENCRYPT_INPUT: \$\{\{ github\.event\.inputs\.mirror_encrypt == true && 'true' \|\| 'false' \}\}/, "MIRROR_ENCRYPT_INPUT must be driven by the dispatch input");
});

test("F48-2 the banished secret name exists NOWHERE in the tree", () => {
  for (const f of [
    ".github/workflows/main.yml",
    ".github/workflows/launch-gates.yml",
    "docs/MIRROR-HOSTS.md",
    "STATE.md",
    "payloads/ghrdp-mirror.ps1",
    "payloads/ghrdp-watcher.ps1",
    "payloads/ghrdp-fx.ps1",
    "payloads/ghrdp-lib.ps1",
    "src/components/explorer/data/fixtures/gofile-mock-server/handlers.ts",
    "src/tests/smoke/fx-gofile-mock.test.tsx",
    "src/tests/smoke/f48-tokenless-mirror.test.tsx",
    "src/pages/Settings.tsx",
    "tests/f46-mirror-contract.test.js",
    "tests/f46-mirror-policy.ps1",
    "tests/f48-tokenless-mirror.test.js",
  ]) {
    const text = read(f);
    assert.ok(!BANISHED.test(text), `${f}: the banished mirror secret name must not appear`);
  }
  // the workflow must read NO secret for the mirror and publish NO env.
  assert.ok(!BANISHED.test(code(main)), "main.yml code may not reference the banished secret");
  assert.ok(!main.includes("GHRDP_GOFILE"), "no mirror token env var may be published (or cleared)");
  assert.ok(!/secrets\.[A-Z_]*GOFILE/i.test(main), "no gofile secret may be read anywhere");
});

test("F48-3 a missing credential is NORMAL: no halt, no warning, token-less validate line", () => {
  assert.ok(!/MISSING REQUIRED SECRET: GOFILE/.test(main), "the missing-secret halt banner must be gone");
  assert.ok(!/requires the repo secret/.test(main), "the fail-closed throw must be gone");
  assert.ok(!/F47 halt/.test(main), "the F47 summary-card halt must be gone");
  assert.ok(!/\$gofileToken/.test(main), "the stage step must not read a token variable");
  assert.ok(!/SetEnvironmentVariable\('GHRDP_GOFILE/.test(main), "the process-env publish must be gone");
  assert.match(main, /F48 mirror opt-in ON for this run: token-less guest mode/, "validate must report guest mode as NORMAL");
  assert.match(main, /\[F48\] mirror opt-in for THIS run/, "the stage step must log the token-less opt-in");
  assert.match(main, /mirrorHosts = @\(\$mirrorHostsCfg\)/, "config.json must carry the per-run mirrorHosts entry");
  assert.match(main, /id = 'gofile'; displayName = 'gofile\.io'.*enabled = \$true/, "the opted-in host entry must set enabled=true");
  assert.ok(!/\n\s+gofileToken\s*=/.test(main), "no token field may be written to config.json");
  assert.ok(!/gofile-token\.txt/.test(main), "no token file may be written or referenced");
  assert.ok(!/\?token=|&token=/.test(main), "no token may appear in a URL");
});

test("F48-4 the module is the guest contract: no auth header, labeled auth reason, authMode", () => {
  assert.ok(!code(modulePs).includes("Authorization"), "the mirror module may not attach an auth header");
  assert.ok(!code(modulePs).includes("X-Gofile-Token"), "the mirror module may not attach a host token header");
  assert.ok(!code(modulePs).includes("Cookie"), "the mirror module may not attach a cookie header");
  assert.ok(!modulePs.includes("Get-F46HostToken"), "the token ladder function must be deleted");
  assert.ok(!modulePs.includes("New-F46GofileAccount"), "the account-minting rung must be deleted");
  assert.ok(!modulePs.includes("authScheme"), "the auth scheme constant must be deleted");
  assert.ok(!modulePs.includes("autoAccount"), "the autoAccount ladder must be deleted");
  assert.ok(!modulePs.includes("tokenConfigKey"), "the token config key must be deleted");
  assert.match(modulePs, /Format-F48AuthReason/, "the labeled auth reason helper must exist");
  assert.match(modulePs, /host requires account token; token-less mode unsupported/, "the exact §2 reason must be pinned");
  assert.match(modulePs, /Operator options: \(1\) disable mirror \(mirror_enable=false\); \(2\) self-hosted operator target; \(3\) token mode - a separate future decision, out of scope here\./, "the §2 operator options must be rendered with the reason");
  assert.match(modulePs, /authMode = 'guest'/, "the shipped default authMode must be guest");
  assert.match(modulePs, /\$authMode = 'requires-account'/, "a 401/403 attempt result must flip authMode");
  assert.match(modulePs, /authMode=requires-account/, "the probe note must record the requires-account result");
  assert.match(modulePs, /multipartField = 'file'/, "the guest multipart field name must stay pinned");
  assert.ok(!/token=\$Token|\?token=/.test(code(modulePs)), "a credential may never travel in a URL");
  // §1.2 redaction now also greps stray token= strings.
  assert.match(modulePs, /\(\?:token\|apikey\|api_key\|password\|passwd\|secret\)/, "the redaction set must cover bare token= strings");
  assert.match(modulePs, /\*\*\*REDACTED\*\*\*/, "the redaction marker must stay");
});

test("F48-5 the watcher never reads a credential and records the authMode result", () => {
  assert.ok(!watcher.includes("Get-F46HostToken"), "the worker must not use the token ladder");
  assert.ok(!watcher.includes("GHRDP_GOFILE"), "the worker must not read a token env var");
  assert.match(watcher, /Invoke-F46MirrorAttempt -HostCfg \$mirrorHost -Path \$uploadPath -Name \$dispName -Size \$uploadLen -AttemptNo \$attemptNo/, "the attempt call must carry no -Token");
  assert.ok(!/-Token \$token/.test(watcher), "no -Token argument may remain");
  assert.match(watcher, /Protect-F46SecretText -Text \(\[string\]\$res\.hostMessage\) -Secrets @\(\$mirrorKeyText\)/, "the redaction set is the mirror key only");
  assert.match(watcher, /\$mirrorAuthMode = 'guest'/, "authMode must default to guest in the progress diag");
  assert.match(watcher, /if \(\$res\.authMode\) \{ \$mirrorAuthMode = \[string\]\$res\.authMode \}/, "authMode must be set from the attempt RESULT");
  assert.match(watcher, /authMode = \$mirrorAuthMode/, "mirrorDiag must carry authMode");
  assert.match(watcher, /key=redacted\(32B, config mirrorKey\)/, "the encrypt log line must stay (key named, never printed)");
  assert.match(watcher, /refusing to upload plaintext/, "the encrypt lock must stay");
});

test("F48-6 the fx surface is token-less: guest poll, guest upload, no hold-for-credential", () => {
  assert.ok(!fx.includes("Get-FxGofileToken"), "the fx token ladder must be deleted");
  assert.ok(!fx.includes("GHRDP_FX_GOFILE" + "_TOKEN"), "the fx token env rung must be deleted");
  assert.ok(!fx.includes("gofileToken"), "the fx config token rung must be deleted");
  assert.ok(!fx.includes("gofile-token.txt"), "the fx token file rung must be deleted");
  assert.ok(!fx.includes("GofileToken"), "the fx options token rung must be deleted");
  assert.ok(!code(fx).includes("Authorization"), "no auth header may be built toward the host");
  assert.match(fx, /token-less guest fetch/, "the preview fetch must state the guest contract");
  assert.match(fx, /token-less guest mode: no credential exists/, "the upload step must state that no credential exists");
  assert.ok(!/held: no host token/.test(fx), "a job may never be held for a missing credential");
  assert.match(fx, /Send-F46GofileUpload -HostCfg \$hostCfg -Path \$Path -Name \$name -TimeoutSec 120/, "the shared guest uploader must be called without a credential");
  assert.match(fx, /authMode = \$\(if \(\(Get-FxString \$configured 'authMode'\) -eq 'requires-account'\)/, "the fx index must carry the recorded authMode");
});

test("F48-7 the legacy lib host auth headers are deleted, not just neutered", () => {
  assert.ok(!lib.includes("accountToken="), "the host account Cookie must be gone from the lib");
  assert.ok(!code(lib).includes("GhrdpGofileToken"), "the lib must hold no host credential variable");
  assert.match(lib, /TOKEN-LESS MIRROR MODE/, "the replacement must document the token-less mode");
  assert.match(lib, /throw 'GHRDP: mirror\/publish path removed per remediation \(function neutered\)\.'/, "the lib path must stay neutered");
  // any Authorization line that remains must NOT target the host
  for (const line of code(lib).split("\n")) {
    if (/Authorization/.test(line)) {
      assert.ok(!/gofile/i.test(line), `lib: auth line targets the host: ${line.trim()}`);
    }
  }
});

test("F48-8 the schema gains authMode and never any token field", () => {
  const schema = read("src/components/explorer/data/schema.ts");
  assert.match(schema, /authMode\?: 'guest' \| 'requires-account'/, "GofileHostConfig must gain authMode");
  assert.ok(!/token/i.test(tsCode(schema).split("export interface GofileHostConfig")[1]?.split("}")[0] ?? ""), "GofileHostConfig may not carry a token field");
  const migration = read("src/components/explorer/data/migrations/v1_to_v2.ts");
  assert.match(migration, /authMode: \(h as \{ authMode\?: string \}\)\.authMode === 'requires-account' \? 'requires-account' : 'guest'/, "the migration must default authMode honestly");
  const endpoints = read("src/components/explorer/api/endpoints.ts");
  assert.match(endpoints, /entry\.authMode === 'requires-account'/, "the index parser must round-trip authMode");
  const defHost = JSON.parse(read("src/components/explorer/data/default-gofile-host.json"));
  assert.equal(defHost.authMode, "guest", "the default host record must be guest");
  assert.ok(!("gofileToken" in defHost || "token" in defHost), "the default host record may not carry a token");
});

test("F48-9 docs pin the guest contract, the probe procedure and the operator options - no token setup", () => {
  const doc = read("docs/MIRROR-HOSTS.md");
  for (const needle of [
    "TOKEN-LESS",
    "guest contract",
    "Probe procedure",
    "host requires account token; token-less mode unsupported",
    "Disable the mirror",
    "Self-hosted operator target",
    "separate future decision",
    "authMode",
    "no repository secret",
    "token-less guest mode",
    "invalidate that token on the host account page",
  ]) {
    assert.ok(doc.includes(needle), `docs/MIRROR-HOSTS.md must document ${needle}`);
  }
  assert.ok(!BANISHED.test(doc), "docs may not name the banished secret");
  assert.ok(!/gofile-token\.txt|gofileToken|tokenConfigKey|autoAccount|Set the repository secret/.test(doc), "docs may not carry any token setup instruction");
  assert.ok(!/Mozilla|proxy rotat|evade|bypass/i.test(doc), "the doc must not describe evasion");
});

test("F48-10 the UI says token-less guest mode; the Settings card documents secret hygiene", () => {
  const en = JSON.parse(read("src/i18n/en.json"));
  assert.match(en.mirrorHostMatrix.subtitle, /token-less guest mode/, "the HostMatrixCard note must read token-less guest mode");
  for (const key of ["optionDisable", "optionSelfHosted", "optionTokenFuture"]) {
    assert.match(en.mirrorHostMatrix[key], /\S/, `the ${key} operator option must render`);
  }
  const settings = read("src/pages/Settings.tsx");
  assert.match(settings, /Secret hygiene/, "the Settings card must carry the §4 hygiene note");
  assert.match(settings, /treated as compromised/, "the hygiene note must state the token is compromised");
  assert.match(settings, /Settings &gt; Secrets and variables &gt; Actions/, "the hygiene note must point at the Secrets page");
  assert.ok(!BANISHED.test(settings), "the Settings card may not spell the banished secret name");
  const keys = read("src/components/domain/KeysCard.tsx");
  assert.match(keys, /MaskedField id="mirrorKey"/, "the Keys card keeps the mirror key field");
  assert.ok(!/gofile/i.test(keys), "the Keys card must not gain a gofile token row");
  const matrix = read("src/components/domain/MirrorHostMatrix.tsx");
  assert.match(matrix, /optionTokenFuture/, "the matrix must render the F48 option set");
});

test("F48-11 launch-gates carries the three new greps and runs this suite", () => {
  assert.match(gates, /F48 token-less mirror gates/, "the F48 gate step must exist");
  assert.match(gates, /'GOFILE\[_\]TOKEN'/, "GATE 1 (banished name, anywhere) must be in CI");
  assert.match(gates, /Authorization\|X-Gofile-Token\|Cookie/, "GATE 2 (host-bound auth headers) must be in CI");
  assert.match(gates, /a missing-token staging halt reappeared/, "GATE 3 (no missing-token halt) must be in CI");
  assert.match(gates, /node --test tests\/f48-tokenless-mirror\.test\.js/, "the F48 suite must run in CI");
  assert.match(gates, /test -f src\/tests\/smoke\/f48-tokenless-mirror\.test\.tsx/, "the F48 DOM suite must exist in CI");
  assert.ok(!gates.includes("f47-mirror-optin"), "the F47 token test must be gone from CI");
  assert.ok(!BANISHED.test(gates), "the gate workflow itself may not spell the banished name");
  // the F47-era positive assertions of token plumbing must be gone
  assert.ok(!/secrets\\\.GOFILE/.test(gates), "the secret-read grep must be gone");
  assert.ok(!/requires the repo secret GOFILE/.test(gates), "the halt-presence grep must be gone");
});

test("F48-12 no malformed try/finally (the parse failure the windows lane caught)", () => {
  const bad = /finally \{ try \{[^{}]*\} \} catch \{ \}/;
  for (const [name, text] of [
    ["ghrdp-mirror.ps1", modulePs],
    ["ghrdp-watcher.ps1", watcher],
    ["f46-mirror-policy.ps1", lab],
    ["main.yml", main],
  ]) {
    assert.ok(!bad.test(text), `${name}: malformed 'finally { try { X } } catch { }' (the catch must sit inside the finally)`);
  }
  for (const line of modulePs.split("\n")) {
    if (/\btry \{.*\}/.test(line) && !/\b(catch|finally)\b/.test(line)) {
      assert.fail("a single-line try without catch/finally appeared: " + line.trim());
    }
  }
});

test("F48-13 the PS lab is token-less: guest spec, empty wire auth, labeled 401/403, redaction", () => {
  assert.ok(!lab.includes("GHRDP_GOFILE"), "the lab must hold no token env fixture");
  assert.ok(!/-Token \$/.test(lab), "the lab must pass no -Token argument");
  assert.ok(!lab.includes("Get-F46HostToken"), "the lab must not exercise a token ladder");
  assert.ok(!lab.includes("Bearer "), "the lab must hold no Bearer fixture");
  assert.match(lab, /\[F48/, "the lab must carry F48 sections");
  assert.match(lab, /host requires account token; token-less mode unsupported/, "the lab must assert the labeled auth reason");
  assert.match(lab, /auth header count 0|no Authorization|headers\['Authorization'\] -eq ''|auth\b.*-eq ''/, "the lab must assert an empty auth header on the wire");
  assert.match(lab, /token=/, "the lab must cover stray token= redaction");
  assert.match(lab, /Length -eq 32/, "the lab must still assert the 32-byte key length");
  assert.match(lab, /networkCalls -eq 0/, "the lab must still prove zero network tries on preflight");
  assert.match(lab, /ciphertext \(no plaintext marker on the wire\)/, "the lab must still prove ciphertext on the wire");
  assert.match(lab, /redacted from any log\/artifact text/, "the lab must still prove the key is redacted");
});

test("F48-14 AES-256 honesty + probe visibility (F47 leftovers) stay enforced", () => {
  assert.match(modulePs, /keyBytes = 32/, "the key length must stay 32 bytes");
  assert.match(modulePs, /function Invoke-F46EncryptFile/, "the encryptor must stay");
  assert.match(modulePs, /function Invoke-F46DecryptFile/, "the decryptor must stay");
  assert.match(modulePs, /function Test-F46AesGcmUsable/, "AES-GCM availability must stay proven");
  assert.match(modulePs, /encryptedMime = 'application\/x-ghrdp-mirror'/, "the mirror mime must stay pinned");
  const page = read("src/pages/Mirror.tsx");
  const matrix = read("src/components/domain/MirrorHostMatrix.tsx");
  assert.match(page, /<MirrorHostMatrix \/>/, "the Mirror page must render the host matrix card");
  assert.match(matrix, /fetch\("\/diag"/, "the matrix must read live from /diag");
  assert.match(matrix, /data-testid="mirror-host-operator-options"/, "the operator options must render");
  const card = read("src/components/domain/MirrorCard.tsx");
  assert.ok(!/error\.slice\(0, ?4?[0-9]\)/.test(card), "the v2 error cell must not slice the reason");
  assert.match(card, /mirror-reason-full/, "the reason must render in full");
  const en = JSON.parse(read("src/i18n/en.json"));
  assert.equal(en.mirror.titleLong, "Mirror - AES-256 encrypted runner upload", "the encrypted claim must name the mode");
  assert.match(en.mirror.titlePlain, /plaintext/i, "the default title must say plaintext");
});
