// [F64] GitHub Actions API timing extraction + critical path.
// Offline: the collector is executed against a committed jobs-API fixture and
// against f64-timing-baseline.jsonl (the last 3 main.yml runs, pulled 2026-10-02).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const lib = require(path.join(root, "scripts", "f64-timing-collector.js"));
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

test("F64-1 collector extracts per-step sec and dashboard-reachable from jobs JSON", () => {
  const payload = JSON.parse(read("tests/fixtures/f64-jobs-sample.json"));
  const { rows, summary } = lib.extractRun(payload, { run_id: 36990591537, event: "workflow_dispatch" });
  assert.equal(summary.reached_dashboard, true);
  assert.equal(summary.dashboard_reachable_s, 337);
  assert.equal(summary.dashboard_reachable_min, 5.62);
  assert.equal(summary.ui_prebuilt_conclusion, "success");
  assert.equal(summary.rdp_labels[0], "windows-latest");
  const qbt = rows.find((r) => r.name.startsWith("Install qBittorrent 4.6.5"));
  assert.equal(qbt.sec, 74);
  assert.equal(qbt.on_critical_path, true);
  const rust = rows.find((r) => r.name.startsWith("Start Rust WebSocket dashboard"));
  assert.equal(rust.on_critical_path, false, "Rust dash is AFTER READY - not on the dashboard critical path");
  const post = rows.find((r) => r.name.startsWith("Post "));
  assert.equal(post, undefined, "post-steps (number>=100) must not enter the path");
  const cp = lib.criticalPath(rows);
  assert.ok(cp.every((r) => r.job === "rdp" && r.on_critical_path));
  assert.ok(cp.some((r) => r.name.indexOf("dashboard EARLY") !== -1));
});

test("F64-2 a failed ui-prebuilt run is labeled and does not invent a dashboard time", () => {
  const payload = {
    jobs: [
      {
        name: "build-ui",
        status: "completed",
        conclusion: "failure",
        run_id: 36969981915,
        steps: [
          {
            name: "Download prebuilt UI bundle (F59 release asset, SHA-256 verified)",
            status: "completed",
            conclusion: "failure",
            number: 5,
            started_at: "2026-10-02T05:40:35Z",
            completed_at: "2026-10-02T05:40:40Z",
          },
        ],
      },
      {
        name: "rdp",
        status: "completed",
        conclusion: "skipped",
        run_id: 36969981915,
        started_at: "2026-10-02T05:40:43Z",
        completed_at: "2026-10-02T05:40:42Z",
        labels: ["windows-latest"],
        steps: [],
      },
    ],
  };
  const { summary } = lib.extractRun(payload);
  assert.equal(summary.reached_dashboard, false);
  assert.equal(summary.dashboard_reachable_s, null);
  assert.equal(summary.ui_prebuilt_conclusion, "failure");
  assert.match(String(summary.note), /FAILED|skipped/i);
});

test("F64-3 jsonl round-trip + evaluateBaseline respects the 8m30s honest gate", () => {
  const payload = JSON.parse(read("tests/fixtures/f64-jobs-sample.json"));
  const ex = lib.extractRun(payload, { run_id: 1 });
  const text = lib.toJsonl([ex]);
  const recs = lib.parseJsonl(text);
  assert.equal(recs[0].kind, "summary");
  assert.ok(recs.some((r) => r.kind === "step" && r.on_critical_path === true));
  const ev = lib.evaluateBaseline(lib.summariesFromJsonl(recs));
  assert.equal(ev.n_reached_dashboard, 1);
  assert.equal(ev.within_8m30s, true);
  assert.equal(ev.honest_gate_s, 510);
  assert.equal(ev.never_promise_sub7, true);
  // a 9-minute run fails the 8m30s gate
  const bad = lib.evaluateBaseline([{ kind: "summary", reached_dashboard: true, dashboard_reachable_s: 540 }]);
  assert.equal(bad.within_8m30s, false);
});

test("F64-4 committed f64-timing-baseline.jsonl is present, 3 runs, honest numbers", () => {
  const p = path.join(root, "f64-timing-baseline.jsonl");
  assert.equal(fs.existsSync(p), true, "f64-timing-baseline.jsonl must be committed (the §1.A artifact)");
  const recs = lib.parseJsonl(read("f64-timing-baseline.jsonl"));
  const sums = lib.summariesFromJsonl(recs);
  const ids = new Set(sums.map((s) => s.run_id));
  assert.equal(ids.size, 3, "last 3 main.yml runs");
  assert.ok(ids.has(36999197717) && ids.has(36990591537) && ids.has(36969981915));
  const reached = sums.filter((s) => s.reached_dashboard);
  assert.ok(reached.length >= 2, "at least two runs reached the dashboard");
  for (const s of reached) {
    assert.ok(s.dashboard_reachable_s <= lib.HONEST_GATE_S, "dashboard-reachable " + s.dashboard_reachable_s + "s exceeds 8m30s");
    assert.ok(s.dashboard_reachable_s >= 180, "implausibly fast dashboard time (would be a lab-as-prod claim)");
  }
  const fail = sums.find((s) => s.run_id === 36969981915);
  assert.equal(fail.reached_dashboard, false);
  assert.equal(fail.ui_prebuilt_conclusion, "failure");
  const ev = lib.evaluateBaseline(sums);
  assert.equal(ev.within_8m30s, true);
  assert.ok(ev.median_min >= 5 && ev.median_min <= 8.5);
});

test("F64-5 shipped surfaces: instrument helper, TOS note, no guaranteed-6, qbt AFTER dashboard", () => {
  const main = read(".github/workflows/main.yml");
  const gates = read(".github/workflows/launch-gates.yml");
  const baseline = read("docs/F64-BASELINE.md");
  const tos = read("docs/F64-TOS-NOTE.md");
  const inst = read("payloads/f64-instrument.ps1");
  assert.match(inst, /function Write-F64Stamp/);
  assert.match(inst, /function Get-F64HostFacts/);
  assert.match(inst, /function Start-F64BgJob/);
  assert.match(inst, /Start-ThreadJob/);
  assert.match(inst, /Get-MpComputerStatus/);
  assert.match(inst, /Test-Path -LiteralPath 'D:\\'/);
  assert.equal(/DisableRealtimeMonitoring|Set-MpPreference/.test(inst), false, "F64 must not disable Defender");
  assert.match(main, /f64-instrument\.ps1/);
  assert.match(main, /Start-F64BgJob/);
  assert.match(main, /Write-F64Stamp/);
  assert.match(main, /Get-F64HostFacts/);
  const dash = main.indexOf("Start Mission Control dashboard EARLY");
  const qbt = main.indexOf("Install qBittorrent 4.6.5 (F59 prebuilt, SHA-256 verified)");
  assert.ok(dash > 0 && qbt > dash, "qBittorrent transport install must sit AFTER dashboard-reachable");
  assert.match(main, /for \(\$i = 0; \$i -lt 90; \$i\+\+\)/);
  assert.match(tos, /Terms of Service/);
  assert.match(tos, /Oracle/);
  assert.match(baseline, /7-8/);
  assert.match(baseline, /398s/);
  assert.equal(/guaranteed 6/.test(baseline + tos + inst), false);
  assert.equal(/lab-verified 6m22s/.test(baseline), false);
  assert.match(gates, /- name: F64 honest timing \+ 1s-poll \+ post-dashboard qbt gates\n\s+shell: bash/);
  assert.match(gates, /tests\/f64-timing-collector\.test\.js/);
  assert.match(gates, /F64 instrument \+ ThreadJob lab/);
  // F60 PARKED: rdp job still defaults to windows-latest
  assert.match(main, /runner_target \|\| 'windows-latest'/);
  assert.equal(/guaranteed 6 min/.test(main), false);
});

test("F64-6 F59 pre-warm pin superseded in place: Start-F64BgJob still Wait-Job joined", () => {
  const main = read(".github/workflows/main.yml");
  const prewarm = main.slice(main.indexOf("F59 parallel pre-warm"), main.indexOf("name: Install Tailscale"));
  assert.ok((prewarm.match(/Start-F64BgJob/g) || []).length >= 4, "four background legs via Start-F64BgJob");
  assert.match(prewarm, /Wait-Job -Job \$all -Timeout 900/);
  assert.match(read("tests/f59-prewarm-parallel.ps1"), /Start-F64BgJob/);
});
