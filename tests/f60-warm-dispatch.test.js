// [F60 §5] WARM-DISPATCH + HEALTH + FALLBACK - contract suite.
//
// Runs under `node --test` inside the F60 launch-gates step (and locally). It pins
// the runtime half of F60: the warm lane's budget (<60000 ms from dispatch to a
// real dashboard HTTP 200), the three-strike STOP, the health probe's fail-closed
// verdicts, the labeled windows-latest fallback, and the F59 invariants F60 must
// not disturb. No network, no runner, no VM required.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

const warm = read(".github/workflows/warm-dispatch.yml");
const health = read("scripts/f60-health.ps1");
const stage = read("scripts/f60-stage-and-start.ps1");
const bootstrap = read("scripts/f60-bootstrap.ps1");
const main = read(".github/workflows/main.yml");
const gates = read(".github/workflows/launch-gates.yml");

test("F60-W1 warm-dispatch.yml: dispatch-only, three inputs, contents:read, no self-hosted anywhere else", () => {
  assert.match(warm, /^on:\n  workflow_dispatch:/m);
  assert.ok(!/^  push:/m.test(warm), "the warm lane must not run on push (it costs warm-runner time)");
  assert.ok(!/^  schedule:/m.test(warm), "no scheduled warm dispatches");
  for (const input of ["force_fallback", "budget_ms", "restart_services"]) {
    assert.ok(warm.includes("      " + input + ":"), "input missing: " + input);
  }
  assert.match(warm, /default: '60000'/, "the budget default is the F60 gate value");
  assert.match(warm, /^permissions:\n  contents: read/m, "the warm lane only reads (checkout + release asset)");
  assert.ok(!/administration: write/.test(warm), "the runtime lane needs no administration scope");
  assert.ok(!/secrets\.AZURE_CREDENTIALS|secrets\.TAILSCALE_AUTHKEY|secrets\.VM_ADMIN_PASSWORD/.test(warm),
    "the runtime lane never touches the provisioning secrets");
});

test("F60-W2 the warm job runs on the sl-warm labels and the fallback is windows-latest, labeled", () => {
  assert.match(warm, /runs-on: \[self-hosted, windows, sl-warm\]/);
  assert.match(warm, /timeout-minutes: 20/, "the warm lane is a <60 s budget; 20 min is a generous ceiling");
  assert.match(warm, /if: \$\{\{ github\.event\.inputs\.force_fallback != 'true' \}\}/);
  const fb = warm.slice(warm.indexOf("  fallback:"));
  assert.match(fb, /needs: warm/);
  assert.match(fb, /if: \$\{\{ always\(\) && \(needs\.warm\.result != 'success' \|\| github\.event\.inputs\.force_fallback == 'true'\) \}\}/);
  assert.match(fb, /runs-on: windows-latest/);
  assert.match(fb, /f59-windows-latest/, "the fallback lane carries the F59 label, not a new one");
  assert.match(fb, /'-Mode', 'cold'/, "the fallback job runs the same shipped stager in cold mode");
  assert.match(fb, /advisory/, "the fallback timing is reported advisory - the <60 s budget belongs to the warm lane");
  assert.match(warm, /  report:\n    needs: \[warm, fallback\]/);
  assert.match(warm, /BOTH LANES RED/, "two red lanes is a STOP, not a retry");
});

test("F60-W3 the budget is measured to a real HTTP 200 and written to startup-timing-f60.jsonl", () => {
  assert.match(warm, /startup-timing-f60\.jsonl/, "the F60 timing file name");
  assert.match(stage, /startup-timing-f60\.jsonl/);
  assert.match(stage, /\$env:GHRDP_F59_TIMING = \$tf/, "the SHIPPED F59 timing helper is redirected, not reimplemented");
  assert.match(stage, /payloads\\f59-timing\.ps1/);
  assert.match(stage, /Stop-F59Step -Step 'dispatch-to-dashboard'/);
  assert.match(warm, /Get-F60WarmBudgetVerdict -TimingFile \$tf -BudgetMs \(\[int\]\$env:BUDGET_MS\) -Step 'dispatch-to-dashboard'/);
  assert.match(warm, /name: startup-timing-f60-warm/);
  assert.match(warm, /name: startup-timing-f60-fallback/);
  assert.match(warm, /C:\\ghrdp\\startup-timing-f60\.jsonl/);
  // the measurement ends at a real HTTP 200 from the v2 route, not at a bound socket
  assert.match(stage, /http:\/\/127\.0\.0\.1:' \+ \$DashPort \+ '\/\?ui=v2/);
  assert.match(stage, /the dashboard did not answer 200 on/);
  assert.match(warm, /dispatch-to-dashboard=' \+ \$v\.ms \+ 'ms budget=/);
  assert.match(warm, /\[F60 budget\] PASS/);
});

test("F60-W4 the three-strike STOP is implemented on the VM, not in prose", () => {
  assert.match(warm, /-StrikeFile 'C:\\ghrdp\\state\\f60-warm-strikes\.json' -MaxStrikes 3/);
  assert.match(warm, /F60 STOP::the warm lane exceeded the budget ' \+ \$v\.strikes \+ ' consecutive runs/);
  assert.match(warm, /stay on f59-windows-latest/);
  assert.match(health, /function Get-F60WarmBudgetVerdict/);
  assert.match(health, /for \(\$i = \$history\.Count - 1; \$i -ge 0; \$i--\) \{\s*if \(\$history\[\$i\]\.over\) \{ \$strikes\+\+ \} else \{ break \}/,
    "strikes count CONSECUTIVE over-budget runs walking backwards from the newest entry (a green run resets them)");
  assert.match(health, /stop       = \(\$strikes -ge \$MaxStrikes\)/);
  assert.match(health, /if \(\$history\.Count -gt 20\)/, "the strike ledger is bounded");
  assert.match(warm, /name: Upload the F60 warm timing \+ health evidence/);
  assert.match(warm, /f60-warm-strikes\.json/, "the ledger is uploaded as evidence");
});

test("F60-W5 the RUNNER_TRACKING_ID guard is advisory, loud and names its remediation", () => {
  assert.match(warm, /RUNNER_TRACKING_ID/);
  assert.match(warm, /::warning title=F60 runner hygiene::RUNNER_TRACKING_ID is unset/);
  assert.match(warm, /delete the stale _work\\<n> tree under C:\\actions-runner/);
  assert.match(warm, /stale\(/);
  const guard = warm.slice(warm.indexOf("name: Self-hosted runner hygiene guard"), warm.indexOf("name: F60 warm stage"));
  assert.match(guard, /exit 0/, "the guard never fails the job - it reports");
  assert.ok(!/throw/.test(guard), "no throw in the advisory guard");
});

test("F60-W6 the health probe is fail-closed, fail-visible and injectable (lab-provable)", () => {
  assert.match(health, /F60_HEALTH_OK/);
  assert.match(health, /F60_HEALTH_FAILED: /);
  assert.match(health, /\$global:F60HealthExit/);
  assert.match(health, /exit \$code/);
  assert.match(health, /f60-health\.json/);
  assert.match(health, /\[int\]\$DashPort = 7331/, "7331 is the real dashboard port (ghrdp-server.ps1)");
  assert.match(health, /\[int\]\$UiPort = 4173/, "4173 is scripts/serve-dist.mjs's own default");
  assert.match(health, /\[int\]\$Aria2Port = 6800/);
  assert.match(health, /5173 is the Vite DEV server/, "the plan's 5173 is superseded in the file itself, not silently");
  assert.match(health, /aria2\.getVersion/, "the aria2c probe is a real JSON-RPC round-trip, not a bound-socket check");
  // the F9n/F25 lesson: `tailscale ip` 401s post-connect when the node is owned by
  // another account, so the probe reads `tailscale status --json` instead.
  assert.match(health, /status --json/);
  // the only place `tailscale ip` may appear is the comment that explains why it
  // is NOT called; no executable line may invoke it.
  const executable = health.split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join("\n");
  assert.ok(!/tailscale(\.exe)?['"]?\s+ip\b/.test(executable), "the health probe must never call `tailscale ip`");
  assert.match(executable, /status --json/);
  assert.match(health, /Never calls `tailscale ip`/);
  for (const probe of ["$ServiceProbe", "$HttpProbe", "$TailscaleProbe", "$Aria2Probe"]) {
    assert.ok(health.includes("[scriptblock]" + probe), "the health probe must accept an injected " + probe + " so the labs can prove both branches");
  }
  assert.match(health, /function Invoke-F60RedactText/, "secret redaction before anything is persisted");
  assert.match(health, /detail = \(Invoke-F60RedactText -Text \$aria\.detail -Sensitive @\(\$ariaSecret\)\)/);
  assert.match(health, /\[switch\]\$DefineOnly/, "dot-sourceable for tests");
});

test("F60-W7 the stager reuses the shipped verifiers and never relaxes the qBittorrent floor", () => {
  assert.match(stage, /scripts\\f59-verify-sha256\.mjs|f59-verify-sha256\.mjs/);
  assert.match(stage, /the shipped fail-closed verifier rejected/);
  assert.match(stage, /refusing an unverifiable bundle/, "a missing .sha256 sidecar is refused");
  assert.match(stage, /ui-v2\.html staging failed - bundle too small/, "the F42/F59 size floor is kept");
  assert.match(stage, /Initialize-GhrdpQbt/, "the Tailnet-only bind comes from the shipped policy module");
  assert.match(stage, /never 0\.0\.0\.0, never '\*', never loopback/);
  assert.ok(!/WebUI\\Address'\s*=\s*'0\.0\.0\.0'/.test(stage), "no wildcard WebUI bind");
  assert.match(stage, /\$script:F60UiFacingServices = @\('ghrdp-server-nssm', 'ghrdp-ui-nssm'\)/);
  assert.match(stage, /the two UI-facing services are ALWAYS restarted/, "the running code must be the code under test");
  assert.match(stage, /-Mode warm|'warm', 'cold'/);
  assert.match(stage, /\[ValidateSet\('warm', 'cold'\)\]/);
  assert.match(stage, /function Start-F60ColdProcesses/);
  assert.match(stage, /server-ok\.txt/, "the cold lane waits on the shipped LISTENING marker");
  assert.match(stage, /F60_STAGE_RESULT /);
});

test("F60-W8 the warm lane refreshes the commit-matched bundle; the cold lane stages from the checkout", () => {
  assert.match(warm, /'-UiBundleSha', \$env:GITHUB_SHA/, "the warm job asks for THIS commit's bundle");
  assert.match(warm, /'-UiReleaseTag', 'ui-dist'/);
  assert.match(stage, /ui-dist-' \+ \$BundleSha \+ '\.zip/);
  assert.match(stage, /Get-F60ReleaseAssetInfo/, "the release download reuses the bootstrap transport (one implementation)");
  assert.match(stage, /Import-F60Transport/);
  assert.match(stage, /scripts\\f60-bootstrap\.ps1/);
  assert.match(stage, /the commit-matched bundle could not be staged/, "a warm-lane bundle miss degrades loudly, it does not fail the run");
  assert.match(stage, /if \(\$Mode -eq 'cold'\) \{ throw \}/, "the cold lane has no provision-time bundle to fall back to");
  assert.match(bootstrap, /function Get-F60ReleaseAssetInfo/, "the transport function the stager dot-sources");
  assert.match(bootstrap, /\[switch\]\$DefineOnly/, "the bootstrap is dot-sourceable without executing");
});

test("F60-W9 no secret can reach a warm-lane log, and no lane dispatches main.yml", () => {
  for (const s of ["TAILSCALE_AUTHKEY", "VM_ADMIN_PASSWORD", "AZURE_CREDENTIALS", "GHRDP_RELEASE_READONLY_TOKEN", "RUNNER_TOKEN"]) {
    assert.ok(!warm.includes("secrets." + s), "warm-dispatch must not read " + s);
  }
  assert.ok(!/echo .*GH_TOKEN|echo .*GITHUB_TOKEN/.test(warm), "no token echo");
  assert.ok(!/gh workflow run/.test(warm + stage + health + bootstrap), "F60 never dispatches another workflow");
  assert.ok(!/sl-warm/.test(main), "main.yml must not know the warm runner exists");
  assert.ok(!/warm-dispatch/.test(main), "main.yml must not reference the F60 lane");
  // the F59 ban stays armed in the gates
  assert.match(gates, /self-hosted runner scope creep \(F60\)/);
  const rdp = main.slice(main.indexOf("\n  rdp:\n"));
  assert.match(rdp.slice(0, 4000), /runs-on: \$\{\{ github\.event\.inputs\.runner_target \|\| 'windows-latest' \}\}/);
});

test("F60-W10 the fallback lane is honest about what it proves", () => {
  const fb = warm.slice(warm.indexOf("  fallback:"), warm.indexOf("  report:"));
  assert.match(fb, /not a'\s*\n\s*echo 'substitute for main\.yml|is not a/);
  assert.match(fb, /never dispatches main\.yml/);
  assert.match(fb, /force_fallback=true was dispatched/, "the forced-fallback run says why it ran");
  assert.match(fb, /the warm lane did not succeed/, "an unplanned fallback names the warm result");
  assert.match(fb, /if \(\$v\.ms -lt 0\)/, "a missing timing line fails the fallback too - no silent pass");
  assert.match(fb, /no dispatch-to-dashboard line was written/);
  assert.match(warm, /decisive lane/);
});
test("F60-W11 the release transport is loaded in the CALLER's scope, not inside the resolver", () => {
  // PowerShell scopes definitions to the scope that made them. A `. $cand -DefineOnly`
  // inside Import-F60Transport would vanish when that function returned, and
  // Stage-F60UiBundle would then fail with "the term 'Get-F60ReleaseAssetInfo' is not
  // recognized" - no commit-matched bundle in EITHER lane. Same bug class as the lab
  // scoping failure (F60-P19), on the shipped side this time.
  const start = stage.indexOf("function Import-F60Transport");
  const end = stage.indexOf("function Stage-F60FromCheckout");
  assert.ok(start > 0 && end > start, "Import-F60Transport must exist ahead of Stage-F60FromCheckout");
  const resolver = stage.slice(start, end);
  assert.ok(!/^\s*\.\s+\$cand/m.test(resolver), "Import-F60Transport must RESOLVE only - a dot-source in here dies with the function");
  assert.match(resolver, /return \$cand/, "it hands the caller the resolved path");
  assert.match(resolver, /if \(\$Workspace\)/, "an empty -Workspace must not reach Join-Path, which throws on an empty string");
  const invoke = stage.slice(stage.indexOf("function Invoke-F60StageAndStart"));
  const resolveAt = invoke.indexOf("$transport = Import-F60Transport");
  const loadAt = invoke.indexOf(". $transport -DefineOnly");
  const useAt = invoke.indexOf("Stage-F60UiBundle");
  assert.ok(resolveAt > -1, "the caller resolves the transport");
  assert.ok(loadAt > resolveAt, "and dot-sources it in its OWN scope, after resolving");
  assert.ok(useAt > loadAt, "before the commit-matched bundle is staged");
  assert.match(invoke, /Get-F60ReleaseAssetInfo' -ErrorAction SilentlyContinue/, "a transport that loads but defines nothing is refused, not trusted");
  assert.match(invoke, /no scripts\\f60-bootstrap\.ps1 to load the release transport/, "the cold lane fails closed when there is no transport to load");

  // A dot-source binds the LOADED script's param block in the caller's scope, so the
  // bootstrap's -Root/-UiReleaseTag/-UiBundleSha defaults would overwrite this
  // function's own parameters. An empty $UiBundleSha would silently downgrade
  // "commit-matched bundle" to "newest ui-dist-*.zip" - a quiet correctness loss.
  const paramNames = (text) => {
    const i = text.indexOf("param(");
    if (i < 0) return [];
    let depth = 0;
    let buf = "";
    for (let k = i + 6; k < text.length; k++) {   // i + 6 = just past "param("
      const c = text[k];
      if (c === "(") depth++;
      else if (c === ")") { if (depth === 0) break; depth--; }
      buf += c;
    }
    return [...buf.matchAll(/\$([A-Za-z][A-Za-z0-9_]*)/g)].map((m) => m[1]);
  };
  const bootstrapParams = paramNames(bootstrap).map((n) => n.toLowerCase());
  const stagerParams = paramNames(invoke);
  const collisions = stagerParams.filter(
    (n, i) => bootstrapParams.includes(n.toLowerCase()) &&
      stagerParams.findIndex((m) => m.toLowerCase() === n.toLowerCase()) === i
  );
  assert.ok(collisions.some((n) => n.toLowerCase() === "root"), "sanity: -Root really is declared by both scripts (the collision this guard exists for)");
  assert.match(invoke, /\$saKeep = @\{/, "the caller snapshots its parameters before dot-sourcing the transport");
  const loadAt2 = invoke.indexOf(". $transport -DefineOnly");
  for (const name of collisions) {
    const cap = name.charAt(0).toUpperCase() + name.slice(1);
    const restore = invoke.indexOf("$" + cap + " = $saKeep." + cap);
    assert.ok(restore > loadAt2, "the colliding parameter $" + cap + " must be restored from $saKeep AFTER the dot-source");
  }
  assert.match(invoke, /\$UiBundleSha = \$saKeep\.UiBundleSha/, "the commit sha survives the transport load");
});
