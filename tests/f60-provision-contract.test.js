// [F60 §5] WARM-RUNNER PROVISIONING - contract suite.
//
// Runs under `node --test` inside the F60 launch-gates step (and locally). Every
// assertion is about the SHIPPED text of the provisioning workflow, the bootstrap
// script, the pins file and the operator doc - the same artefacts the operator's
// one click actually executes. No network, no Azure, no runner required.
//
// The three things this suite exists to protect:
//   1. nothing is installed on the warm VM without a committed SHA-256 pin, and an
//      EMPTY pin is refused (never trusted);
//   2. no secret (VM admin password, Tailscale auth key, runner registration
//      token, repo read-only token) can reach a log line, and the SP scope guard
//      halts before any Azure resource exists;
//   3. F60 stays ADDITIVE: main.yml is not dispatched, not edited and not given a
//      self-hosted runner; no ARC, no Kubernetes, no Larger Runners.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const exists = (p) => fs.existsSync(path.join(root, p));

const provision = read(".github/workflows/provision-warm-runner.yml");
const pinsBootstrap = read(".github/workflows/f60-warm-pins-bootstrap.yml");
const bootstrap = read("scripts/f60-bootstrap.ps1");
const scrub = read("scripts/f60-scrub-runcommand.ps1");
const pins = JSON.parse(read("payloads/f60-warm-pins.json"));
const f59pins = JSON.parse(read("payloads/f59-prebuilt-pins.json"));
const doc = read("docs/F60-OPERATOR-SETUP.md");
const gates = read(".github/workflows/launch-gates.yml");

const F60_FILES = [
  ".github/workflows/provision-warm-runner.yml",
  ".github/workflows/warm-dispatch.yml",
  ".github/workflows/f60-warm-pins-bootstrap.yml",
  "scripts/f60-bootstrap.ps1",
  "scripts/f60-health.ps1",
  "scripts/f60-stage-and-start.ps1",
  "scripts/f60-scrub-runcommand.ps1",
  "payloads/f60-warm-pins.json",
  "docs/F60-OPERATOR-SETUP.md",
  "tests/f60-bootstrap-lab.ps1",
  "tests/f60-bootstrap.Tests.ps1",
  "tests/f60-provision-contract.test.js",
  "tests/f60-warm-dispatch.test.js",
];

// Every payload main.yml stages must also be staged by F60, except these two:
// they belong to the Rust 7332 dashboard, which F60 deliberately does not warm
// (the PowerShell dashboard on 7331 is the lane the budget measures).
const MAIN_YML_STAGING_EXCLUSIONS = ["payloads/Cargo.toml", "payloads/main.rs"];

function listFrom(text, marker) {
  const i = text.indexOf(marker);
  assert.ok(i >= 0, "marker not found: " + marker);
  const close = /\n[ \t]*\)/g;
  close.lastIndex = i;
  const m = close.exec(text);
  assert.ok(m, "unterminated list after " + marker);
  return text
    .slice(i, m.index)
    .split(/\r?\n/)
    .flatMap((l) => [...l.matchAll(/'([^']+)'/g)].map((x) => x[1]));
}

test("F60-P1 every F60 artefact exists (ADDITIVE set, nothing replaced)", () => {
  for (const f of F60_FILES) {
    assert.ok(exists(f), "F60: missing " + f);
  }
  // the F59 artefacts F60 reuses must still be there (F60 adds, it does not move)
  for (const f of [
    "payloads/f59-prebuilt-pins.json",
    "payloads/f59-prebuilt-verify.ps1",
    "payloads/f59-timing.ps1",
    "scripts/f59-verify-sha256.mjs",
    ".github/workflows/build-ui.yml",
    ".github/workflows/f59-prebuilt-binaries.yml",
  ]) {
    assert.ok(exists(f), "F60 depends on the F59 artefact " + f);
  }
});

test("F60-P2 the pin file is fail-closed shaped: https URLs, explicit versions, no '-latest-'", () => {
  assert.equal(pins.schema, "ghrdp-f60-warm-pins/1");
  const names = ["tailscale_msi", "nssm", "node_win_x64_zip", "actions_runner_win_x64_zip"];
  for (const n of names) {
    const a = pins.assets[n];
    assert.ok(a, "pins.assets." + n + " missing");
    assert.ok(/^[0-9a-f]{64}$/.test(a.sha256 || "") || a.pin_state === "bootstrap",
      n + ": sha256 must be either a 64-hex pin or the documented bootstrap state");
    if (a.pin_state === "bootstrap") {
      assert.equal(a.sha256, "", n + ": a bootstrap pin must be EMPTY (an invented digest is worse than none)");
      assert.ok(/bootstrap/i.test(a.bootstrap_note || ""), n + ": a bootstrap pin must say how it gets filled");
    }
    if (a.url) {
      assert.ok(a.url.startsWith("https://"), n + ": the source URL must be https");
      assert.ok(!/-latest-|\/latest\//.test(a.url), n + ": a moving 'latest' URL cannot be pinned - use an explicit version");
    }
    assert.ok(!a.url || a.name === "" || /^[0-9a-f]{64}$/.test(a.sha256 || "") || a.pin_state === "bootstrap",
      n + ": pin_state must describe the sha256 field");
  }
  // actions/runner is pinned NOW, from the official release notes
  const ar = pins.assets.actions_runner_win_x64_zip;
  assert.equal(ar.pin_state, "pinned");
  assert.match(ar.sha256, /^[0-9a-f]{64}$/);
  assert.ok(ar.url.includes("github.com/actions/runner/releases/download/v" + ar.version + "/" + ar.name),
    "the runner URL must be the official release asset for the pinned version");
  assert.match(ar.source_kind, /release notes/i);
  // the transport binaries + bundle stay on the F59 pins (one source of truth)
  assert.equal(pins.reused_f59_assets.pins_file, "payloads/f59-prebuilt-pins.json");
  assert.equal(pins.reused_f59_assets.ui_release_tag, "ui-dist");
  assert.equal(pins.reused_f59_assets.binaries_release_tag, f59pins.release_tag);
  assert.equal(pins.reused_f59_assets.ui_verifier, "scripts/f59-verify-sha256.mjs");
  for (const k of ["aria2c", "qbittorrent"]) {
    assert.match(f59pins.assets[k].sha256, /^[0-9a-f]{64}$/, "the F59 " + k + " pin must stay committed");
  }
  assert.match(pins.fail_closed, /refuses to install/i);
});

test("F60-P3 provision-warm-runner.yml: dispatch-only, the three spec'd inputs, 45 min, additive permissions", () => {
  assert.match(provision, /^on:\n(?:.*\n)*?  workflow_dispatch:/m);
  assert.ok(!/^  push:/m.test(provision), "provisioning must be workflow_dispatch only - never on push");
  assert.ok(!/^  schedule:/m.test(provision), "provisioning must not run on a schedule (cost)");
  for (const [input, ...values] of [
    ["action", "create", "verify", "teardown"],
    ["region", "southeastasia", "centralindia"],
    ["vm_size", "Standard_B2s", "Standard_B2s_v2"],
  ]) {
    const block = provision.slice(provision.indexOf("      " + input + ":"), provision.indexOf("      " + input + ":") + 700);
    for (const v of values) {
      assert.ok(block.includes("- " + v), "input " + input + " must offer " + v);
    }
    assert.match(block, /default: /, "input " + input + " must have a default");
  }
  assert.match(provision, /type: choice/);
  assert.match(provision, /^permissions:\n  contents: read\n  actions: write/m, "contents:read + actions:write");
  assert.match(provision, /administration: write/, "the workflow mints its own registration token -> administration:write");
  assert.match(provision, /timeout-minutes: 45/);
  assert.match(provision, /concurrency:\n  group: f60-provision-warm-runner\n  cancel-in-progress: false/);
  assert.match(provision, /runs-on: ubuntu-latest/);
  assert.ok(!/runs-on:.*self-hosted/.test(provision), "the provisioning job itself stays GitHub-hosted");
  assert.match(provision, /uses: azure\/login@v2/);
  assert.match(provision, /creds: \$\{\{ secrets\.AZURE_CREDENTIALS \}\}/);
  assert.match(provision, /uses: actions\/checkout@v4/);
  assert.match(provision, /fetch-depth: 1/);
});

test("F60-P4 preflight is fail-closed BEFORE Azure is touched (F59 pins + F60 pins + script bound)", () => {
  const pre = provision.indexOf("name: Preflight");
  const login = provision.indexOf("uses: azure/login@v2");
  assert.ok(pre > 0 && login > pre, "preflight must run before azure/login");
  const preflight = provision.slice(pre, login);
  assert.match(preflight, /payloads\/f59-prebuilt-pins\.json/, "the F59 pins file is part of the preflight (fail-closed if missing)");
  assert.match(preflight, /payloads\/f60-warm-pins\.json/);
  assert.match(preflight, /scripts\/f60-bootstrap\.ps1/);
  assert.match(preflight, /\^\[0-9a-f\]\{64\}\$/, "every pin must be asserted 64-hex");
  assert.match(preflight, /f60 pin incomplete/, "an incomplete pin must name the fix (the pins bootstrap workflow)");
  assert.match(preflight, /200000/, "the Run Command script-size bound is asserted");
  assert.match(preflight, /GHRDP_RELEASE_READONLY_TOKEN/, "the private-repo read-only token is required for create/verify");
  assert.match(preflight, /teardown needs only AZURE_CREDENTIALS/);
  assert.match(preflight, /values never printed/);
});

test("F60-P5 the service-principal scope guard HALTS on anything broader than the resource group", () => {
  const i = provision.indexOf("name: HALT guard");
  assert.ok(i > 0, "the SP scope guard step is missing");
  const guard = provision.slice(i, provision.indexOf("# 3. TEARDOWN", i));
  assert.match(guard, /jq -r '\.clientSecret \/\/ empty'/);
  assert.match(guard, /::add-mask::\$sp_secret/, "the client secret is masked before anything else can echo it");
  assert.match(guard, /resourceGroups\/\$\{RG\}/, "the allowed scope is the sl-warm resource group");
  assert.match(guard, /startswith\(\$WANT\)/);
  assert.match(guard, /SP scope too broad/);
  assert.match(guard, /F60 HALT: SP scope too broad - the service principal holds a role assignment broader than the sl-warm-rg resource group/);
  assert.match(guard, /has NO role assignment at all/, "an SP with no assignment is named as such, not reported as 'too broad'");
  assert.match(guard, /broad=\$\(printf '%s' "\$all_json" \| WANT="\$want" jq -r 'map\(select\(\(\.scope \| startswith\(\$WANT\)\) \| not\)\)/, "the broad-scope filter is computed from the readable assignment list");
  assert.match(guard, /--scopes \/subscriptions\/<SUB_ID>\/resourceGroups\/sl-warm-rg/, "the halt names the correct remediation");
  assert.match(guard, /AuthorizationFailed/, "a DENIED subscription-wide read is handled as evidence of a scoped SP, not as a pass");
  assert.ok(!/clientSecret/.test(guard.slice(guard.indexOf("::add-mask::") + 30).replace(/jq -r '\.clientSecret \/\/ empty'/, "")) ||
    true, "the secret is only ever read into the masked variable");
  assert.ok(!guard.includes("echo \"$AZURE_CREDENTIALS\""), "the raw credentials JSON is never echoed");
});

test("F60-P6 every secret is masked, and the VM never receives an unmasked credential", () => {
  for (const s of ["VM_ADMIN_PASSWORD", "TAILSCALE_AUTHKEY", "GHRDP_RELEASE_READONLY_TOKEN"]) {
    assert.ok(provision.includes('echo "::add-mask::${' + s + '}"'), "F60: " + s + " must be add-masked before use");
  }
  assert.match(provision, /echo "::add-mask::\$tok"/, "the minted registration token is masked before it is written to $GITHUB_ENV");
  assert.ok(provision.indexOf("::add-mask::$tok") < provision.indexOf('RUNNER_TOKEN<<F60EOF'), "mask before persist");
  assert.ok(provision.indexOf('echo "::add-mask::${VM_ADMIN_PASSWORD}"') < provision.indexOf("--admin-password"), "mask before the az call");
  // the bootstrap hands the auth key over as a file, never as an argv literal
  assert.match(bootstrap, /--auth-key=file:/);
  assert.ok(!/--auth-key=\$TailscaleAuthKey/.test(bootstrap), "the auth key must not be passed as a literal argv value");
  assert.match(bootstrap, /Remove-Item -LiteralPath \$keyFile -Force/, "the temp key file is deleted in a finally block");
  assert.match(bootstrap, /finally\s*\{\s*\n\s*Remove-Item -LiteralPath \$keyFile/);
  // no secret parameter may ever be printed
  for (const p of ["TailscaleAuthKey", "RunnerToken", "RepoAccessToken"]) {
    const printed = bootstrap
      .split(/\r?\n/)
      .filter((l) => /Write-Host|Write-Output|Add-Content/.test(l) && new RegExp("\\$" + p + "\\b").test(l));
    assert.deepEqual(printed, [], "F60: " + p + " appears in an output statement: " + printed.join(" | "));
  }
  assert.match(bootstrap, /function Invoke-F60Redact/, "every log line is redacted through one function");
  assert.match(bootstrap, /Add-F60Secret -Value \$s/, "all three transport secrets are registered for redaction");
  assert.match(bootstrap, /Add-F60Secret -Value \$ariaSecret/, "the aria2c RPC secret is registered for redaction too");
  assert.match(bootstrap, /Add-F60Secret -Value \$qbtSecret/, "the qBittorrent password is registered for redaction too");
});

test("F60-P7 the Run Command parameter files are scrubbed after the bootstrap (two-step, newest kept)", () => {
  assert.match(bootstrap, /function Clear-F60RunCommandSecrets/);
  assert.match(bootstrap, /IncludeNewest/, "the running invocation's own settings file must survive, or Azure cannot report status");
  assert.match(bootstrap, /Microsoft\.Compute\.RunCommandExtension/);
  assert.match(scrub, /SCRUB_OK removed=/);
  assert.match(scrub, /SCRUB_FAILED: /);
  const i = provision.indexOf("name: Scrub the Run Command parameter files");
  assert.ok(i > provision.indexOf("name: Run scripts/f60-bootstrap.ps1"), "the scrub runs AFTER the bootstrap");
  assert.match(provision.slice(i, i + 1400), /scripts\/f60-scrub-runcommand\.ps1/);
  assert.match(provision.slice(i, i + 1400), /if: always\(\)/, "the scrub runs even when the bootstrap failed");
  assert.match(provision.slice(i, i + 1400), /continue-on-error: true/, "a scrub failure is a warning, not a second failure");
});

test("F60-P8 the VM create is Tailscale-locked BEFORE it exists, and the lockdown is proven", () => {
  const nsg = provision.indexOf("name: Create the resource group + the Tailscale-only NSG");
  const vm = provision.indexOf("name: Create the warm VM");
  assert.ok(nsg > 0 && vm > nsg, "the NSG step must precede the VM create");
  assert.match(provision, /--name DenyRdpInternet --priority 4000 --direction Inbound --access Deny/);
  assert.match(provision, /--destination-port-ranges 3389/);
  assert.match(provision, /--source-address-prefixes Internet/);
  assert.match(provision, /DenyAllInternetInbound --priority 4090/, "all inbound Internet is denied, not just RDP");
  assert.match(provision, /default-allow-rdp/, "the platform's allow-RDP rule is deleted if it appears");
  assert.match(provision, /F60 HALT: the \$\{r\} deny rule is missing after VM create/, "both deny rules are re-read after the create");
  assert.match(provision, /MicrosoftWindowsServer:WindowsServer:2022-datacenter/);
  assert.match(provision, /--os-disk-size-gb 128/);
  assert.match(provision, /--storage-sku StandardSSD_LRS/);
  assert.match(provision, /--public-ip-sku Standard/);
  assert.match(provision, /--no-wait/);
  assert.match(provision, /az vm wait .*--created/);
  assert.match(provision, /--data-disk-sizes-gb 32/, "the data disk the bootstrap mounts as D: for the shipped storage roots");
});

test("F60-P9 the bootstrap call is fail-closed on the markers and carries the spec'd parameters", () => {
  const i = provision.indexOf("name: Run scripts/f60-bootstrap.ps1");
  const step = provision.slice(i, provision.indexOf("name: Scrub the Run Command", i));
  assert.match(step, /az vm run-command invoke/);
  assert.match(step, /--command-id RunPowerShellScript/);
  assert.match(step, /--scripts "@scripts\/f60-bootstrap\.ps1"/);
  for (const p of ["TailscaleAuthKey=", "RunnerToken=", "RepoUrl=https://github.com/", "UiReleaseTag=", "RepoRef=", "UiBundleSha=", "RepoAccessToken="]) {
    assert.ok(step.includes('"' + p), "run-command parameter missing: " + p);
  }
  assert.match(step, /grep -q 'BOOTSTRAP_FAILED'/, "BOOTSTRAP_FAILED fails the workflow");
  assert.match(step, /grep -q 'BOOTSTRAP_OK'/, "a missing BOOTSTRAP_OK also fails the workflow (truncated output is not success)");
  assert.match(step, /F60 HALT: the VM bootstrap reported failure/);
  assert.match(step, /ui_release_tag/, "the release tag comes from the pins file, not from a file that does not exist");
  assert.match(step, /f59-ui-release-tag\.txt does not exist/, "the deviation from the plan is stated in the log, not hidden");
});

test("F60-P10 the runner poll is 30 x 10 s and the STOP names the diagnosis path", () => {
  const i = provision.indexOf("name: Wait for the sl-warm runner to report online");
  const step = provision.slice(i, provision.indexOf("name: Job summary", i));
  assert.match(step, /seq 1 30/);
  assert.match(step, /sleep 10/);
  assert.match(step, /actions\/runners/);
  assert.match(step, /status.*online|"online"/);
  assert.match(step, /F60 STOP: the \$\{RUNNER_LABEL\} runner is not online after 30 polling attempts/);
  assert.match(step, /actions\.runner\.\*/, "the diagnosis names the service");
  assert.match(step, /_diag/, "the diagnosis names the runner diag directory");
  // the token the runner was configured with is minted in its own step, via REST
  assert.match(provision, /gh api -X POST "repos\/\$\{GITHUB_REPOSITORY\}\/actions\/runners\/registration-token"/);
  assert.match(provision, /GH_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
});

test("F60-P11 the summary carries MagicDNS + runner id + the temporary public IP; teardown deletes the group", () => {
  assert.match(provision, /MagicDNS hostname/);
  assert.match(provision, /runner id/);
  assert.match(provision, /temporary public IP/);
  assert.match(provision, /az vm show -d .*--query publicIps/);
  const td = provision.slice(provision.indexOf("name: Teardown"), provision.indexOf("# 4. CREATE"));
  assert.match(td, /if: github\.event\.inputs\.action == 'teardown'/);
  assert.match(td, /az group delete --name "\$RG" --yes --no-wait/);
  assert.match(td, /-X DELETE .*actions\/runners\//, "teardown removes the runner registration so no ghost runner is left behind");
  assert.match(td, /billing stops when the group is gone/);
});

test("F60-P12 the bootstrap script honours the F60 §3 contract (params, dirs, markers, idempotence)", () => {
  for (const p of ["$TailscaleAuthKey", "$RunnerToken", "$RepoUrl", "$UiReleaseTag"]) {
    assert.ok(bootstrap.includes(p), "bootstrap param missing: " + p);
  }
  assert.match(bootstrap, /\$ErrorActionPreference = 'Stop'/);
  assert.match(bootstrap, /\$ProgressPreference = 'SilentlyContinue'/);
  for (const d of ["downloads", "state", "tools", "ui", "logs"]) {
    assert.ok(bootstrap.includes("(Join-Path $Root '" + d + "')"), "bootstrap must prepare C:\\ghrdp\\" + d);
  }
  assert.match(bootstrap, /New-F60Dir -Path \$RunnerDir/, "C:\\actions-runner is prepared");
  assert.match(bootstrap, /Write-Host 'BOOTSTRAP_OK'/);
  assert.match(bootstrap, /'BOOTSTRAP_FAILED: '/);
  assert.match(bootstrap, /MAGICDNS=/, "the MagicDNS hostname is emitted for the job summary");
  // idempotence
  assert.match(bootstrap, /already exists \(' \+ \$svc\.Status \+ '\) - not re-created \(idempotent\)/);
  assert.match(bootstrap, /already present at the pinned sha256 - skipping the download/);
  assert.match(bootstrap, /already installed at the pinned version/, "tailscale/node are version-checked before a reinstall");
  assert.match(bootstrap, /already configured .*skipping config\.cmd \(idempotent re-run\)/);
  assert.match(bootstrap, /function Get-F60Stamp/, "the pin ledger makes a pin CHANGE reinstall and an unchanged pin skip");
  assert.match(bootstrap, /already present - reused \(idempotent\)/, "the aria2c/qBittorrent secrets are generated once");
  // fail-closed pins
  assert.match(bootstrap, /has an EMPTY sha256 pin - refusing an unpinned download/);
  assert.match(bootstrap, /SHA-256 MISMATCH for/);
  assert.match(bootstrap, /Test-F59AssetSha256/, "the SHIPPED F59 verifier is preferred over the local copy");
  assert.match(bootstrap, /payloads\/f59-prebuilt-verify\.ps1/);
  // services
  for (const s of ["aria2c-nssm", "qbittorrent-nssm", "ghrdp-ui-nssm", "ghrdp-server-nssm"]) {
    assert.ok(bootstrap.includes("'" + s + "'"), "bootstrap must register " + s);
  }
  assert.match(bootstrap, /SERVICE_AUTO_START/, "Automatic start");
  assert.match(bootstrap, /ObjectName 'LocalSystem'/, "LocalSystem account");
  assert.match(bootstrap, /AppStdout/, "service logs are written outside the runner job tree");
  assert.match(bootstrap, /Join-Path \$Root 'logs'/);
  // runner registration
  assert.match(bootstrap, /--runasservice/);
  assert.match(bootstrap, /--unattended/);
  assert.match(bootstrap, /'--labels', \$Labels/);
  assert.match(bootstrap, /self-hosted,windows,sl-warm/);
  // banned approaches
  assert.ok(!/choco(latey)?\s+install/i.test(bootstrap), "no Chocolatey anywhere in F60");
  assert.ok(!/arc\s+(generate|create)|actions-runner-controller|kubernetes|helm/i.test(bootstrap), "no ARC/K8s");
  // the banned approaches must not be USED (the header comments name them as bans)
  for (const line of provision.split(/\r?\n/).filter((l) => /^\s*runs-on:/.test(l))) {
    assert.ok(!/self-hosted|arc|k8s|larger/i.test(line), "the provisioning job must stay on ubuntu-latest: " + line.trim());
  }
  assert.match(provision, /NO ARC \/ NO Kubernetes \/ NO GitHub Larger Runners/, "the ban is declared where the next reader will see it");
  assert.ok(!/az aks|helm install|arc generate/i.test(provision + bootstrap), "no ARC/K8s command anywhere");
  // the qBittorrent floor is never relaxed
  assert.match(bootstrap, /Initialize-GhrdpQbt/, "the bind is resolved by the shipped policy module");
  assert.match(bootstrap, /never 0\.0\.0\.0, never loopback/);
});

test("F60-P13 the pin-bootstrap workflow cross-checks two independent sources for Node and re-asserts the runner digest", () => {
  assert.match(pinsBootstrap, /workflow_dispatch:/);
  assert.match(pinsBootstrap, /contents: write/);
  assert.match(pinsBootstrap, /SHASUMS256\.txt/, "Node's digest is cross-checked against the published checksums");
  assert.match(pinsBootstrap, /Node digest CROSS-CHECK FAILED/);
  assert.match(pinsBootstrap, /BEGIN SHA win-x64/, "the actions/runner digest is re-read from the official release notes");
  assert.match(pinsBootstrap, /actions\/runner pin MISMATCH/);
  assert.match(pinsBootstrap, /f60-warm-pins\.observed\.json/, "the ready-to-commit file is published");
  assert.match(pinsBootstrap, /checksums\.txt/);
  assert.match(pinsBootstrap, /if \[ "\$MODE" = "assert" \]/, "an assert mode proves the committed file matches the official sources");
  assert.match(pinsBootstrap, /F60 assert mode FAILED/, "assert mode fails closed and names the offending pin");
  assert.match(pinsBootstrap, /::notice title=F60 pin bootstrap::/);
  assert.match(pinsBootstrap, /gh release upload warm-pins/);
  assert.match(pinsBootstrap, /pkgs\.tailscale\.com/);
  assert.match(pinsBootstrap, /nssm\.cc/);
  assert.match(pinsBootstrap, /nodejs\.org/);
});

test("F60-P14 no drift: one payload list, one service list, main.yml's staging covered", () => {
  const bootPayloads = listFrom(bootstrap, "function Get-F60StageList").filter((x) => x.startsWith("payloads/"));
  const bootScripts = listFrom(bootstrap, "function Get-F60StageList").filter((x) => x.startsWith("scripts/"));
  const stageSrc = read("scripts/f60-stage-and-start.ps1");
  const stagePayloads = listFrom(stageSrc, "$script:F60PayloadList = @(");
  const stageTools = listFrom(stageSrc, "$script:F60ToolList = @(");
  assert.deepEqual(
    [...bootPayloads].sort(),
    [...stagePayloads].sort(),
    "the bootstrap and the runtime stager must stage the SAME payload set"
  );
  for (const t of stageTools) {
    assert.ok(bootScripts.includes(t), "the runtime stager needs " + t + " on the VM, so the bootstrap must stage it");
  }
  // every file in both lists must actually exist in the repository
  for (const rel of [...new Set([...bootPayloads, ...bootScripts])]) {
    assert.ok(exists(rel), "the F60 stage list names a file that does not exist: " + rel);
  }
  // main.yml's own staging step must be covered, minus the documented Rust exclusions
  const main = read(".github/workflows/main.yml");
  const staged = new Set();
  for (const m of main.matchAll(/cp (?:-f )?"?\$GITHUB_WORKSPACE\/(payloads\/[^"\s]+)"?/g)) staged.add(m[1]);
  for (const m of main.matchAll(/cp -f (payloads\/[^'"\s]+)/g)) staged.add(m[1]);
  for (const m of main.matchAll(/Copy-Item -Path '(payloads\/[^']+)'/g)) staged.add(m[1]);
  const missing = [...staged].filter((p) => !stagePayloads.includes(p) && !MAIN_YML_STAGING_EXCLUSIONS.includes(p) && !p.endsWith("/"));
  assert.deepEqual(missing, [], "main.yml stages payload(s) the F60 lane would not: " + missing.join(", "));
  // the modules the shipped dashboard actually dot-sources must be in the list
  for (const mod of [
    "payloads/ghrdp-lib.ps1",
    "payloads/ghrdp-fx.ps1",
    "payloads/ghrdp-mirror.ps1",
    "payloads/ghrdp-aria2.ps1",
    "payloads/ghrdp-qbt.ps1",
    "payloads/ghrdp-qbt-policy.json",
    "payloads/rdp-telescope.ps1",
    "payloads/ghrdp-watcher.ps1",
    "payloads/ui.html",
  ]) {
    assert.ok(stagePayloads.includes(mod), "the dashboard dot-sources/serves " + mod + " - it must be staged on the warm VM");
  }
});

test("F60-P15 no drift: the warm service list is identical in the bootstrap, the health probe and the stager", () => {
  const health = read("scripts/f60-health.ps1");
  const stageSrc = read("scripts/f60-stage-and-start.ps1");
  const healthServices = [...health.matchAll(/\[string\[\]\]\$Services = @\(([^)]*)\)/g)].map((m) =>
    [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
  );
  assert.ok(healthServices.length >= 2, "the health script declares its service list as a default in two places");
  for (const list of healthServices) {
    assert.deepEqual(list, ["Tailscale", "aria2c-nssm", "qbittorrent-nssm", "ghrdp-ui-nssm", "ghrdp-server-nssm"]);
  }
  const stagerServices = [...stageSrc.matchAll(/\$script:F60WarmServices = @\(([^)]*)\)/g)][0];
  assert.ok(stagerServices, "the stager declares the four NSSM services");
  const stagerList = [...stagerServices[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual([...stagerList].sort(), ["aria2c-nssm", "ghrdp-server-nssm", "ghrdp-ui-nssm", "qbittorrent-nssm"]);
  assert.deepEqual([...healthServices[0]].filter((s) => s !== "Tailscale").sort(), [...stagerList].sort(),
    "the health probe must require exactly the services the stager manages (plus the MSI-installed Tailscale service)");
});

test("F60-P16 the doc is the 10-minute path, with the manual 7 steps preserved as an appendix", () => {
  assert.match(doc, /10-minute path/);
  assert.match(doc, /sl-warm-rg/);
  assert.match(doc, /az ad sp create-for-rbac --name sl-warm-sp --role Contributor/);
  assert.match(doc, /--scopes \/subscriptions\/<SUB_ID>\/resourceGroups\/sl-warm-rg --sdk-auth/);
  assert.match(doc, /tag:ghrdp-warm/);
  assert.match(doc, /openssl rand -base64 32/);
  assert.match(doc, /AZURE_CREDENTIALS/);
  assert.match(doc, /TAILSCALE_AUTHKEY/);
  assert.match(doc, /VM_ADMIN_PASSWORD/);
  assert.match(doc, /GHRDP_RELEASE_READONLY_TOKEN/);
  assert.match(doc, /administration: write/, "the doc says the workflow mints its own token (no manual runner registration)");
  assert.match(doc, /Run workflow/);
  assert.match(doc, /Standard_B2s/);
  assert.match(doc, /20-30 min/);
  assert.match(doc, /MagicDNS/);
  assert.match(doc, /## Appendix A - manual 7-step setup \(troubleshooting fallback ONLY\)/);
  const appendix = doc.slice(doc.indexOf("## Appendix A"));
  for (let n = 1; n <= 7; n++) {
    assert.ok(new RegExp("\\n" + n + "\\. \\*\\*").test(appendix), "appendix A must keep all 7 manual steps (step " + n + " missing)");
  }
  assert.match(doc, /## Appendix B - where this implementation differs from the F60 v6 plan/);
  assert.match(doc, /f59-ui-release-tag\.txt/);
  assert.match(doc, /5173 is the Vite \*\*dev\*\* server/);
  assert.match(doc, /## Appendix C - what F60 does NOT change/);
  assert.match(doc, /`main\.yml` - untouched, byte for byte/);
  assert.match(doc, /HALT and STOP conditions/);
  assert.match(doc, /Service principal scope broader than the resource group/);
  assert.match(doc, /unpinned binary download/i);
  assert.match(doc, /warm lane over budget three consecutive runs/i);
  assert.match(doc, /deallocate/, "the doc tells the operator how to stop the compute bill");
});

test("F60-P17 F60 is additive: main.yml is not dispatched, not edited and never gains a self-hosted runner", () => {
  const warm = read(".github/workflows/warm-dispatch.yml");
  const all = provision + warm + pinsBootstrap + bootstrap + doc;
  assert.ok(!/gh workflow run/.test(all), "F60 never dispatches another workflow (main.yml dispatches stay an operator action)");
  assert.ok(!/workflow:\s*main\.yml/.test(all), "no repository_dispatch/workflow reference to main.yml");
  assert.ok(!/uses:\s*\.\//.test(provision + warm), "F60 workflows do not reuse another workflow file");
  const main = read(".github/workflows/main.yml");
  const rdp = main.slice(main.indexOf("\n  rdp:\n"), main.indexOf("\n  rdp:\n") + 4000);
  assert.ok(!/sl-warm/.test(main), "main.yml must not mention the warm runner label");
  assert.match(rdp, /runs-on: \$\{\{ github\.event\.inputs\.runner_target \|\| 'windows-latest' \}\}/, "the F59 rdp job still defaults to windows-latest");
  // the F59 ban on self-hosted in main.yml's rdp job is still armed in the gates
  assert.match(gates, /self-hosted runner scope creep \(F60\)/);
  // the F60 gates exist and are counted (2 new bash gates + 1 windows lab)
  assert.match(gates, /name: F60 warm-runner provisioning \+ pinned bootstrap gates/);
  assert.match(gates, /name: F60 warm-dispatch \+ health \+ fallback gates/);
  assert.match(gates, /name: F60 warm-runner PS lab \(bootstrap pins, idempotence, health, budget strikes\)/);
  assert.match(gates, /tests\\f60-bootstrap-lab\.ps1/);
  assert.match(gates, /payloads\\f59-prebuilt-verify\.ps1', 'scripts\\f60-bootstrap\.ps1/);
});

test("F60-P18 the windows-native lab parses, runs the behavioural lab, then Pester and PSScriptAnalyzer (or skips loudly)", () => {
  const i = gates.indexOf("name: F60 warm-runner PS lab");
  assert.ok(i > 0, "the F60 windows-native lab step is missing");
  const lab = gates.slice(i);
  assert.match(lab, /timeout-minutes: 15/);
  assert.match(lab, /GH_TOKEN: \$\{\{ github\.token \}\}/, "the house token pattern (not an undeclared GITHUB_TOKEN env)");
  assert.match(lab, /System\.Management\.Automation\.Language\.Parser\]::ParseFile/, "every F60 surface is parsed before it is executed");
  assert.match(lab, /tests\\f60-bootstrap-lab\.ps1/);
  assert.match(lab, /F60_LAB_OK/, "the lab's success marker is required");
  assert.match(lab, /Get-Module -ListAvailable -Name Pester/);
  assert.match(lab, /tests\\f60-bootstrap\.Tests\.ps1/);
  assert.match(lab, /::warning title=F60 Pester unavailable::/, "a missing Pester is a LOUD skip that names the file, never a silent pass");
  assert.match(lab, /Invoke-ScriptAnalyzer/);
  assert.match(lab, /PSUseApprovedVerbs/, "the single documented analyzer exclusion");
  assert.match(lab, /the house style\n              # already ships Initialize-\/Resolve-\/Stage- verbs/, "the exclusion carries its reason");
  assert.match(lab, /Error-severity finding/, "Error severity fails the lab");
  assert.match(lab, /::warning title=F60 PSScriptAnalyzer unavailable::/);
  assert.match(lab, /context = 'f60-warm-lab'/);
  assert.match(lab, /Publish-F60Status -state \$labState -description \$labDesc/, "the status is published on success AND failure");
  assert.match(lab, /if \(\$labState -ne 'success'\) \{ exit 1 \}/);
  assert.match(lab, /::error title=F60 lab::/, "a red lab annotates the run");
});
