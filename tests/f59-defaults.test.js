// [F59] DEFAULT FLIPS + PREBUILT ASSETS + STARTUP SPEED - contract suite.
//
// Runs under `node --test` inside the F59 launch-gates step (and locally). Every
// assertion here is about the SHIPPED text of the workflow files, the pins file,
// the shipped PowerShell modules and the two UI surfaces - the same artefacts the
// dispatch actually executes. No network, no runner required.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const main = read(".github/workflows/main.yml");
const gates = read(".github/workflows/launch-gates.yml");
const pins = JSON.parse(read("payloads/f59-prebuilt-pins.json"));

function dispatchBlock() {
  const start = main.indexOf("workflow_dispatch:");
  const end = main.indexOf("\npermissions:", start);
  assert.ok(start > 0 && end > start, "main.yml must have a workflow_dispatch block");
  return main.slice(start, end);
}
function inputDefault(name) {
  const m = dispatchBlock().match(new RegExp(name + ":\\n(?:[^\\n]*\\n)*?\\s+default:\\s*(true|false)"));
  return m && m[1];
}

test("F59-1 the three dispatch defaults are flipped", () => {
  assert.equal(inputDefault("mirror_enable"), "true", "F59: mirror_enable default must be true (token-less guest, no secret)");
  assert.equal(inputDefault("mirror_encrypt"), "false", "F59: mirror_encrypt default must be false (plaintext manual lane)");
  assert.equal(inputDefault("search_enable"), "true", "F59: search_enable default must be true (aria2c fetch live out of the box)");
  // the F49/F48 per-run semantics survive the flip
  assert.match(main, /MIRROR_INPUT: \$\{\{ github\.event\.inputs\.mirror_enable == true && 'true' \|\| 'false' \}\}/);
  assert.match(main, /MIRROR_INPUT -eq 'true'/);
  assert.match(main, /SEARCH_INPUT: \$\{\{ github\.event\.inputs\.search_enable == true && 'true' \|\| 'false' \}\}/);
});

test("F59-2 plaintext is the election when mirror_encrypt is not explicitly true", () => {
  assert.match(
    main,
    /MIRROR_PLAINTEXT_ELECTED: \$\{\{ github\.event_name == 'workflow_dispatch' && github\.event\.inputs\.mirror_encrypt != 'true' && 'true' \|\| 'false' \}\}/,
    "the plaintext election must fire for false AND for an omitted input; only explicit true keeps the encrypted lane"
  );
  assert.match(main, /\[F59\] PLAINTEXT MODE - uploads not encrypted/);
});

test("F59-3 the visible PLAINTEXT MODE banner exists in BOTH UIs and names the floor", () => {
  const tsx = read("src/components/domain/MirrorCard.tsx");
  const v1 = read("payloads/ui.html");
  for (const [name, src] of [["v2 MirrorCard.tsx", tsx], ["v1 ui.html", v1]]) {
    assert.match(src, /PLAINTEXT MODE — uploads not encrypted/, name + ": banner must say PLAINTEXT MODE - uploads not encrypted");
    assert.ok(src.includes("Downloads auto-upload and the runtime opt-in lane ALWAYS encrypt"), name + ": banner must state the auto-path encryption floor");
    assert.ok(src.includes("runner-local"), name + ": banner must state the key stays runner-local");
  }
  assert.match(tsx, /data-testid="mirror-plaintext-banner"/);
  assert.match(v1, /id="mirrorPlaintextBanner"/);
});

test("F59-4 AUTO-PATH SAFETY FLOOR: auto + runtime lanes always encrypt regardless of the dispatch default", () => {
  const mod = read("payloads/ghrdp-mirror.ps1");
  const watcher = read("payloads/ghrdp-watcher.ps1");
  assert.match(mod, /if \(\$Auto\) \{ return 'all' \}/, "Downloads auto-upload must stay encryptMode=all");
  assert.match(mod, /if \(Get-F49RuntimeOptIn -Cfg \$Cfg\) \{ return 'all' \}/, "the runtime opt-in lane must stay encryptMode=all");
  assert.match(mod, /Name 'encryptMode' -Value 'all'/);
  assert.match(watcher, /Get-F52WorkerMode -Cfg \$cfg -Auto \$f51AutoFile/);
  assert.match(read("tests/f46-mirror-policy.ps1"), /autoUpload = 'downloads-always-on'/);
  // the flag cannot reach these paths: neither lane reads MIRROR_ENCRYPT_INPUT
  const lanes = mod.slice(mod.indexOf("function Get-F52WorkerMode"), mod.indexOf("function Get-F52WorkerMode") + 1200);
  assert.equal(/MIRROR_ENCRYPT_INPUT/.test(lanes), false, "the auto/runtime lane must not consult the dispatch encryption flag");
});

test("F59-5 prebuilt binaries: pins file, official sources, no Chocolatey, fail-closed", () => {
  assert.equal(pins.release_tag, "prebuilt-binaries");
  assert.equal(pins.checksums_asset, "checksums.txt");
  for (const key of ["aria2c", "qbittorrent"]) {
    const a = pins.assets[key];
    assert.ok(a, key + " must be pinned");
    assert.match(a.name, /^[a-z0-9.\-]+\.(exe|zip)$/, key + " asset name");
    assert.match(a.source, /^https:\/\/(github\.com\/aria2\/aria2\/releases\/download\/|downloads\.sourceforge\.net\/project\/qbittorrent\/)/, key + " must come from an OFFICIAL project release URL");
  }
  assert.match(pins.assets.qbittorrent.upstream_sha256, /^[0-9A-Fa-f]{64}$/, "the upstream installer hash must be pinned");
  // Chocolatey is out of the path entirely
  for (const bad of [/choco install aria2/, /choco install qbittorrent/, /choco list --local-only/, /choco install qbittorrent-nox/]) {
    assert.equal(bad.test(main), false, "main.yml must not use Chocolatey: " + bad);
  }
  assert.match(main, /prebuilt-binaries/);
  assert.match(main, /gh release download/);
  assert.match(main, /f59-prebuilt-verify\.ps1/);
  assert.match(main, /Test-F59AssetSha256/);
  assert.match(main, /Test-F59ChecksumsLine/);
  const verify = read("payloads/f59-prebuilt-verify.ps1");
  assert.match(verify, /EMPTY sha256 pin - refusing an unverified asset/);
  assert.match(verify, /SHA-256 MISMATCH/);
  assert.match(verify, /disagrees with the committed pin/);
  // the binaries are consumed (not re-downloaded) by the transport steps
  assert.match(main, /Install aria2c 1\.36\.0 \(F59 prebuilt, SHA-256 verified\)/);
  assert.match(main, /Install qBittorrent 4\.6\.5 \(F59 prebuilt, SHA-256 verified\)/);
  assert.match(main, /no Chocolatey fallback by design/);
});

test("F59-6 prebuilt UI artifact: build-ui.yml publishes, main.yml downloads + verifies, fallback is explicit", () => {
  const bu = read(".github/workflows/build-ui.yml");
  assert.match(bu, /ui-dist-\$\{sha\}\.zip/);
  assert.match(bu, /sha256sum "\$asset"/);
  assert.match(bu, /gh release (view|create|upload) ui-dist/);
  assert.match(bu, /--clobber/);
  assert.match(bu, /push:/);
  assert.match(bu, /fetch-depth: 1/);
  assert.match(bu, /setup-node@v4/);
  assert.match(bu, /cache: 'npm'/);
  assert.match(bu, /actions\/cache@v4/);
  // main.yml: download first, SHA-256 verified, fail-closed, fallback only on a miss
  assert.match(main, /gh release download ui-dist --pattern "\$asset"/);
  assert.match(main, /scripts\/f59-verify-sha256\.mjs/);
  assert.match(main, /echo 'hit=false' >> "\$GITHUB_OUTPUT"/);
  assert.match(main, /if: steps\.ui-prebuilt\.outputs\.hit != 'true'/);
  assert.match(main, /F59 ui-prebuilt\] hit sha256-verified/);
  const verify = read("scripts/f59-verify-sha256.mjs");
  assert.match(verify, /SHA-256 mismatch/);
  assert.match(verify, /process\.exit\(1\)/);
  assert.match(verify, /no checksum line for/);
});

test("F59-7 actions cache + shallow checkout + parallelism + startup timing", () => {
  assert.match(main, /F59 prebuilt binary cache \(SHA-256 pinned assets\)/);
  assert.match(main, /key: f59-prebuilt-\$\{\{ runner\.os \}\}-\$\{\{ hashFiles\('payloads\/f59-prebuilt-pins\.json'\) \}\}/);
  assert.match(main, /fetch-depth: 1/);
  const checkouts = main.match(/actions\/checkout@v4\n\s+with:\n(?:\s+#[^\n]*\n)*\s+fetch-depth: 1/g) || [];
  assert.ok(checkouts.length >= 2, "both the ui job and the rdp job must use a shallow checkout");
  // parallel pre-warm: four concurrent legs started before the dashboard gate
  assert.match(main, /F59 parallel pre-warm \(Tailscale MSI \+ prebuilt binaries \+ PS parse\)/);
  const prewarm = main.slice(main.indexOf("F59 parallel pre-warm"), main.indexOf("name: Install Tailscale"));
  assert.ok((prewarm.match(/Start-F64BgJob/g) || []).length >= 4, "four background legs via Start-F64BgJob (ThreadJob with Start-Job fallback; Wait-Job still joins)");
  assert.match(prewarm, /Wait-Job -Job \$all -Timeout 900/);
  assert.match(prewarm, /GHRDP_F59_PREWARM=ready/);
  // the gate: prewarm must complete before the dashboard-reachable step
  assert.ok(main.indexOf("GHRDP_F59_PREWARM=ready") < main.indexOf("dashboard-reachable-from-job-start"));
  // startup timing jsonl + artifact
  assert.match(main, /startup-timing\.jsonl/);
  assert.match(main, /name: startup-timing\n/);
  assert.match(main, /payloads\/f59-timing\.ps1/);
  assert.match(read("payloads/f59-timing.ps1"), /Measure-Command/);
  assert.match(main, /dashboard-reachable-from-job-start/);
  assert.match(main, /::notice title=F59 dashboard-reachable::/);
});

test("F59-8 launch-gates carries the additive F59 gate + the PS lab, and apply-patch is untouched", () => {
  assert.match(gates, /- name: F59 default flips \+ prebuilt assets \+ startup timing gates\n\s+shell: bash/);
  assert.match(gates, /- name: F59 parallel pre-warm \+ fail-closed asset verify lab/);
  assert.match(gates, /tests\\f59-prewarm-parallel\.ps1/);
  assert.match(gates, /tests\/f59-defaults\.test\.js/);
  assert.equal(/F59/.test(read(".github/workflows/apply-patch.yml")), false, "apply-patch.yml must stay untouched");
  // the flipped-in-place assertions match the new defaults (old values gone)
  assert.equal(/awk '\/mirror_enable:\/\{f=1\} f&&\/default:\/\{print;exit\}' "\$wf" \| grep -qF 'default: false'/.test(gates), false);
  assert.match(gates, /F59: mirror ON by default/);
  assert.match(gates, /F59: plaintext default \+ mandatory banner/);
  assert.match(gates, /F59: search lane ON by default/);
});

test("F59-9 no self-hosted runner requirement is introduced (F60 note)", () => {
  assert.equal(/runs-on:\s*\[?self-hosted/.test(main), false, "F59 must not add a self-hosted runner requirement");
  assert.match(read("docs/F59-PREBUILT-BINARIES.md"), /F60/);
});
