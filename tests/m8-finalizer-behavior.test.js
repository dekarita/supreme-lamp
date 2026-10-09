// [M8 §2/§4] BEHAVIORAL gate for the cancellation-safe status.json finalizer.
//
// WHY THIS SUITE EXISTS (PROB-004 follow-up, v18 §1)
// The structural gate (tests/m8-cancellation-finalizer.test.js) pins the
// finalizer's wiring but CANNOT see behavior: an independent review inserted
// an unconditional `exit 0` right after $ErrorActionPreference (MUT-A) and
// wrapped the HTTP PUT in `if ($false)` while leaving `$published = $true`
// reachable (MUT-B) - the structural gate passed 10/10 on both (reproduced
// again on 2026-10-09, node v22.22.3: control 10/10, MUT-A 10/10, MUT-B
// 10/10). Both variants are BROKEN at runtime and must fail HERE.
//
// HOW IT WORKS (no JavaScript reimplementation, no string-matching proof):
//   1. The REAL PowerShell body is extracted verbatim from main.yml (the only
//      substitution is the ${{ job.status }} ACTIONS CONTEXT, injected per
//      scenario - the same seam GitHub itself uses).
//   2. It executes inside pwsh as an ISOLATED CHILD PROCESS (exit paths
//      observable) with tests/m8-finalizer-harness.ps1 wrapping it.
//   3. The harness shadows Invoke-RestMethod with a function (PowerShell
//      command precedence: functions beat cmdlets) implementing contents-API
//      semantics; NO real network is reachable - any unmocked method/URI
//      throws a refusal. Synthetic repo/run identities and FAKE credentials
//      only; request logs contain redacted auth (boolean hasAuth, never the
//      token).
//   4. Node asserts on the side effects: request count/method/path/payload,
//      final virtual state, the run-scoped terminal sentinel, stdout markers
//      and a hard wall-clock kill (a hung script fails, it never "passes").
//   5. POWER IS NOT TRUSTED TO ITS OWN WORDS: a scenario that claims success
//      (stdout marker) but committed no PUT is a FAILURE - this is what
//      reddens MUT-B.
//
// RUNTIME: pwsh + node. When pwsh is unavailable the extraction/structural
// checks still run and every runtime scenario reports "RUNTIME NOT RUN" as a
// labeled skip; setting M8_BEHAVIORAL=1 (the windows-native lane does) makes
// a missing runtime FAIL instead of silently degrading. M8_PWSH overrides the
// pwsh binary.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

const WORKFLOW_PATH = process.env.M8_MAIN_YML || ".github/workflows/main.yml";
const M8_STEP = "- name: Finalize status.json (M8 cancellation-safe terminal state)";
const REQUIRE_RUNTIME = process.env.M8_BEHAVIORAL === "1";

/** Extract the M8 step's run:| body verbatim (10-space YAML literal indent). */
function extractM8Body(yamlText) {
  const i = yamlText.indexOf(M8_STEP);
  assert.ok(i > 0, "the M8 step must exist in " + WORKFLOW_PATH);
  const runIdx = yamlText.indexOf("        run: |", i);
  assert.ok(runIdx > i, "the M8 step must carry a literal run: | block");
  const lines = yamlText.slice(runIdx + "        run: |".length).split("\n");
  const body = [];
  for (const ln of lines.slice(1)) {
    if (ln.trim() === "") { body.push(""); continue; }
    if (!ln.startsWith("          ")) break;
    body.push(ln.slice(10));
  }
  const text = body.join("\n").trimEnd();
  assert.ok(text.includes("$ErrorActionPreference = 'Continue'"), "extraction sanity: header missing");
  assert.ok(text.includes("Invoke-RestMethod"), "extraction sanity: no HTTP call found");
  assert.ok(text.trimEnd().endsWith("exit 0"), "extraction sanity: body must end in exit 0");
  return text;
}

/** Extract the generated Publish-StatusToGhPages helper from its StringBuilder
 *  generator lines (AppendLine literals, '' -> ' unescaped). */
function extractHelper(yamlText) {
  const marker = "[void]$sb.AppendLine('function Publish-StatusToGhPages {')";
  const start = yamlText.indexOf(marker);
  assert.ok(start > 0, "the publish-status helper generator must exist");
  const lines = yamlText.slice(start).split("\n");
  const out = [];
  const re = /^\s*\[void\]\$sb\.AppendLine\('(.*)'\)\s*$/;
  for (const ln of lines) {
    const m = ln.match(re);
    if (!m) break;
    out.push(m[1].replace(/''/g, "'"));
  }
  const fn = out.join("\n");
  assert.ok(fn.startsWith("function Publish-StatusToGhPages"), "helper extraction sanity");
  assert.ok(fn.includes("terminal sentinel present"), "the helper must carry the M8 late-heartbeat suppression");
  return fn;
}

const YAML = readFileSync(WORKFLOW_PATH, "utf8");
const BODY = extractM8Body(YAML);
const HELPER = extractHelper(YAML);
const FAKE_TOKEN = "FAKE_TOKEN_TESTONLY";
const RUN_ID = "9001";

// ---------------- runtime plumbing ----------------
const ROOT = join(tmpdir(), "m8-behavior-" + process.pid);
mkdirSync(ROOT, { recursive: true });

const pwshProbe = spawnSync(process.env.M8_PWSH || "pwsh", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"], { encoding: "utf8" });
const PWSH_OK = pwshProbe.status === 0;
const PWSH_VERSION = PWSH_OK ? String(pwshProbe.stdout).trim() : "unavailable";

/** Run one scenario in an isolated pwsh process; returns a verdict object
 *  (never throws) so both acceptance and self-falsify tests can inspect it. */
function runScenario(sc, bodyText) {
  const dir = join(ROOT, sc.name);
  mkdirSync(dir, { recursive: true });
  const body = (bodyText || BODY).replace("'${{ job.status }}'", "'" + (sc.jobStatus || "success") + "'");
  assert.ok(!body.includes("${{"), "all actions-context seams must be substituted");
  writeFileSync(join(dir, "m8-body.ps1"), body);
  const scenario = {
    token: sc.token === undefined ? FAKE_TOKEN : sc.token,
    state: {
      statusJson: sc.statusJson === undefined ? null : sc.statusJson,
      rawContent: sc.rawContent || null,
      shaCounter: 1,
      behaviors: sc.behaviors || {},
    },
  };
  writeFileSync(join(dir, "scenario.json"), JSON.stringify(scenario));
  const env = {
    ...process.env,
    GITHUB_RUN_ID: sc.runId || RUN_ID,
    GITHUB_RUN_ATTEMPT: String(sc.attempt === undefined ? 1 : sc.attempt),
    GITHUB_REPOSITORY: "ghrdp-test/example",
    GITHUB_TOKEN: sc.envToken === undefined ? FAKE_TOKEN : sc.envToken,
    RUNNER_TEMP: dir,
    M8_REQUEST_TIMEOUT_SEC: String(sc.requestTimeoutSec || 5),
    M8_FINALIZE_DEADLINE_SEC: String(sc.deadlineSec || 40),
  };
  const start = Date.now();
  const child = spawn(process.env.M8_PWSH || "pwsh", ["-NoProfile", "-NonInteractive", "-File", "tests/m8-finalizer-harness.ps1", "-ScenarioPath", join(dir, "scenario.json")], { env });
  let out = "", err = "", killed = false;
  return new Promise((resolve) => {
    const killAfter = setTimeout(() => { killed = true; child.kill("SIGKILL"); }, sc.maxMs || 35000);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => { clearTimeout(killAfter); resolve({ spawnError: String(e) }); });
    child.on("close", (code) => {
      clearTimeout(killAfter);
      const elapsedMs = Date.now() - start;
      const transcript = out + "\n--- STDERR ---\n" + err;
      writeFileSync(join(dir, "transcript.txt"), transcript);
      let reqs = [];
      try {
        reqs = readFileSync(join(dir, "requests.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
      } catch { }
      let state = null;
      try { state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8")); } catch { }
      const sentinel = readdirSync(dir).filter((f) => f.startsWith("ghrdp-m8-terminal-"));
      resolve({ name: sc.name, exitCode: killed ? "KILLED(wall-clock)" : code, elapsedMs, transcript, reqs, state, sentinel: sentinel.map((f) => JSON.parse(readFileSync(join(dir, f), "utf8"))), dir });
    });
  });
}

/** Shared invariants every scenario must satisfy. */
function baseFailures(sc, v) {
  const f = [];
  if (v.spawnError) { f.push("pwsh spawn failed: " + v.spawnError); return f; }
  if (v.exitCode !== 0) f.push("expected exit 0, got " + v.exitCode);
  if (v.elapsedMs > (sc.maxMs || 35000)) f.push("exceeded wall-clock budget");
  if (v.transcript.includes("M8-HARNESS REFUSAL")) f.push("the body reached outside the mocked API (unexpected network shape)");
  if (v.transcript.includes(FAKE_TOKEN)) f.push("REDACTION FAILURE: the token value leaked into the transcript");
  return f;
}

const puts = (v) => v.reqs.filter((r) => r.method === "put");
const gets = (v) => v.reqs.filter((r) => r.method === "get");
const committed = (v) => puts(v).filter((r) => r.note === "committed");

/** The verdict a BROKEN script cannot fake: success claims require a
 *  committed PUT; this is what reddens MUT-B ($published=$true, no PUT). */
function successIsHonest(v, failures) {
  const claims = v.transcript.includes("[m8] status.json finalized:");
  if (claims && committed(v).length === 0) failures.push("the script CLAIMED finalization but committed no PUT (MUT-B detector)");
  if (!claims && committed(v).length > 0) failures.push("a PUT committed but the script did not report finalization");
}

// ---------------- fixtures ----------------
const MINE_LIVE = { runId: RUN_ID, runAttempt: 1, runStatus: "in_progress", overallPct: 40, filesDone: 4, filesTotal: 10, ts: "2026-10-09T00:00:00Z" };
const MINE_LIVE_55 = { ...MINE_LIVE, overallPct: 55, filesDone: 5 };
const MINE_LIVE_NEWER_ATTEMPT = { ...MINE_LIVE, runAttempt: 2 };
const MINE_DONE = { ...MINE_LIVE, runStatus: "cancelled", finalizeReason: "job.status=cancelled" };
const MINE_DONE_ATT1 = { ...MINE_LIVE, runStatus: "completed", runAttempt: 1, finalizeReason: "job.status=success" };
const FOREIGN_LIVE = { runId: "8001", runAttempt: 1, runStatus: "in_progress", overallPct: 61, filesDone: 6, filesTotal: 9 };
const FOREIGN_DONE = { runId: "8001", runAttempt: 1, runStatus: "completed", overallPct: 100, filesDone: 9, filesTotal: 9 };

// ---------------- acceptance scenarios (§4) ----------------
// Each entry: [name, scenario, check(ctx, failures)]
const CASES = [
  ["01-owned-success-completed", { statusJson: MINE_LIVE, jobStatus: "success" }, (v, f) => {
    successIsHonest(v, f);
    if (puts(v).length !== 1) f.push("expected exactly 1 PUT, got " + puts(v).length);
    const c = committed(v)[0];
    if (!c) return f.push("no committed PUT");
    if (c.payload.runStatus !== "completed") f.push("runStatus must be completed, got " + c.payload.runStatus);
    if (c.payload.overallPct !== 40) f.push("must CARRY the remote progress (40), got " + c.payload.overallPct);
    if (c.payload.overallPct === 100) f.push("must never fabricate 100%");
    if (c.payload.runId !== RUN_ID) f.push("payload runId must be this run");
    if (c.payload.runAttempt !== 1) f.push("payload must carry runAttempt=1");
    if (c.payload.finalizeReason !== "job.status=success") f.push("finalizeReason must name the real job.status");
    if (c.payload.watcherAlive !== false) f.push("watcherAlive must clear");
    if (!c.bodySha) f.push("the PUT must carry the sha fence for an existing file");
    if (v.sentinel.length !== 1 || v.sentinel[0].runStatus !== "completed") f.push("the terminal sentinel must be written for this run");
  }],
  ["02-owned-cancelled", { statusJson: MINE_LIVE, jobStatus: "cancelled" }, (v, f) => {
    successIsHonest(v, f);
    const c = committed(v)[0];
    if (!c || c.payload.runStatus !== "cancelled") f.push("cancellation must publish runStatus=cancelled (the PROB-004 lie), got " + (c && c.payload.runStatus));
    if (c && c.payload.finalizeReason !== "job.status=cancelled") f.push("finalizeReason mismatch");
  }],
  ["03-owned-failure", { statusJson: MINE_LIVE, jobStatus: "failure" }, (v, f) => {
    successIsHonest(v, f);
    const c = committed(v)[0];
    if (!c || c.payload.runStatus !== "failed") f.push("failure must publish runStatus=failed, got " + (c && c.payload.runStatus));
  }],
  ["04-unknown-outcome-truthful", { statusJson: MINE_LIVE, jobStatus: "skipped" }, (v, f) => {
    successIsHonest(v, f);
    const c = committed(v)[0];
    if (!c || c.payload.runStatus !== "unknown") f.push("unmapped outcomes must publish the explicit 'unknown' fallback, got " + (c && c.payload.runStatus));
    if (c && c.payload.finalizeReason !== "job.status=skipped") f.push("finalizeReason must still name the real status");
  }],
  ["05-missing-token-no-unauthorized-write", { statusJson: MINE_LIVE, envToken: "" }, (v, f) => {
    if (v.reqs.length !== 0) f.push("no request may be attempted without a credential, got " + v.reqs.length);
    if (!v.transcript.includes("::warning::[m8] GITHUB_TOKEN is not available")) f.push("the missing-token path must be visibly warned");
    if (v.state.statusJson.runStatus !== "in_progress") f.push("snapshot must be left unchanged");
  }],
  ["06-foreign-active-owner-no-overwrite", { statusJson: FOREIGN_LIVE }, (v, f) => {
    if (puts(v).length !== 0) f.push("a foreign ACTIVE run must never be overwritten (PUTs=" + puts(v).length + ")");
    if (!v.transcript.includes("is owned by run 8001")) f.push("the skip must be observable in the log");
    if (v.state.statusJson.runId !== "8001") f.push("the foreign snapshot must be untouched");
  }],
  ["07-foreign-terminal-superseded-without-its-counters", { statusJson: FOREIGN_DONE }, (v, f) => {
    successIsHonest(v, f);
    const c = committed(v)[0];
    if (!c) return f.push("a terminal (dead) foreign snapshot is supersede-able");
    if (c.payload.runId !== RUN_ID) f.push("the new owner must be this run");
    if (c.payload.overallPct !== 0 || c.payload.filesDone !== 0) f.push("foreign counters must NOT be carried (pct=" + c.payload.overallPct + ")");
    if (c.payload.progressSource !== "none-observed") f.push("progressSource must admit nothing was observed");
  }],
  ["08-takeover-between-read-and-put-aborts", { statusJson: MINE_LIVE, behaviors: { put: [{ call: 1, respond: "409", after: { statusJson: FOREIGN_LIVE, bumpSha: true } }] } }, (v, f) => {
    if (puts(v).length !== 1) f.push("exactly one PUT may be attempted before the abort, got " + puts(v).length);
    if (!v.transcript.includes("now owns docs/status.json")) f.push("the takeover abort must be observable");
    if (v.state.statusJson.runId !== "8001" || v.state.statusJson.runStatus !== "in_progress") f.push("the concurrent run's snapshot must survive");
    if (v.sentinel.length !== 0) f.push("no terminal sentinel may be written when nothing was published");
  }],
  ["09-put-conflict-then-recover-bounded", { statusJson: MINE_LIVE, behaviors: { put: [{ call: 1, respond: "500" }] } }, (v, f) => {
    successIsHonest(v, f);
    if (puts(v).length !== 2) f.push("expected 1 retry then success, got " + puts(v).length + " PUTs");
    if (puts(v).length > 3) f.push("retries must stay bounded");
  }],
  ["10a-invalid-state-no-blind-overwrite", { statusJson: MINE_LIVE, behaviors: { get: [{ call: 1, respond: "invalid-base64" }, { call: 2, respond: "invalid-base64" }] } }, (v, f) => {
    if (puts(v).length !== 0) f.push("unreadable remote state must never be treated as permission to overwrite");
    if (!v.transcript.includes("action=skip-unknown")) f.push("invalid state must surface as skip-unknown, got no such marker");
    if (v.state.statusJson.runStatus !== "in_progress") f.push("snapshot must be left unchanged");
  }],
  ["10b-invalid-identity-distinguished", { statusJson: MINE_LIVE, behaviors: { get: [{ call: 1, respond: "missing-runid" }, { call: 2, respond: "missing-runid" }] } }, (v, f) => {
    if (puts(v).length !== 0) f.push("identity-less JSON must not be overwritten");
    if (!v.transcript.includes("action=skip-unknown")) f.push("missing identity must be conservative");
  }],
  ["10c-auth-failure-no-credential-retry-storm", { statusJson: MINE_LIVE, envToken: "WRONG_TOKEN_TESTONLY" }, (v, f) => {
    if (puts(v).length !== 0) f.push("a 401 read must abort without any write");
    if (gets(v).length !== 1) f.push("auth failures must NOT be retried blindly, got " + gets(v).length + " GETs");
    if (!v.transcript.includes("action=abort-read")) f.push("auth failure must be distinguished, not conflated");
  }],
  ["10d-transient-read-bounded-then-safe-exit", { statusJson: MINE_LIVE, behaviors: { get: [{ call: 1, respond: "500" }, { call: 2, respond: "500" }] } }, (v, f) => {
    if (puts(v).length !== 0) f.push("a failed read must never become a blind write");
    if (gets(v).length !== 2) f.push("transient reads get exactly one bounded retry, got " + gets(v).length);
    if (!v.transcript.includes("action=retry-read")) f.push("transient failure must be distinguishable from invalid/missing state");
    if (!v.transcript.includes("::warning::[m8] could not read/validate")) f.push("the safe exit must warn, not pass silently");
  }],
  ["11-duplicate-finalization-idempotent", { statusJson: MINE_DONE, jobStatus: "cancelled" }, (v, f) => {
    if (puts(v).length !== 0) f.push("an already-finalized run+attempt must not be rewritten");
    if (v.state.statusJson.runStatus !== "cancelled") f.push("the existing terminal state must stand");
    if (!v.transcript.includes("action=skip-owned")) f.push("the idempotent skip must be observable");
  }],
  // 12 (late heartbeat through the generated helper) lives in its own test below.
  ["13a-same-run-newer-attempt-steps-aside", { statusJson: MINE_LIVE_NEWER_ATTEMPT, attempt: 1, jobStatus: "cancelled" }, (v, f) => {
    if (puts(v).length !== 0) f.push("a STALE attempt must never clobber a newer attempt's live snapshot");
    if (!v.transcript.includes("action=skip-superseded")) f.push("the superseded attempt must be distinguished");
  }],
  ["13b-same-run-newer-attempt-supersedes-terminal", { statusJson: MINE_DONE_ATT1, attempt: 2, jobStatus: "failure" }, (v, f) => {
    successIsHonest(v, f);
    const c = committed(v)[0];
    if (!c || c.payload.runStatus !== "failed") f.push("the newer attempt must re-finalize truthfully (failed), got " + (c && c.payload.runStatus));
    if (c && c.payload.runAttempt !== 2) f.push("the payload must carry attempt 2");
  }],
  ["14-progress-moves-between-attempts", { statusJson: MINE_LIVE, behaviors: { put: [{ call: 1, respond: "500", after: { statusJson: MINE_LIVE_55, bumpSha: true } }] } }, (v, f) => {
    successIsHonest(v, f);
    const last = puts(v)[puts(v).length - 1];
    if (!last || last.note !== "committed") return f.push("the retry must commit");
    if (last.payload.overallPct !== 55) f.push("the payload must be rebuilt from the FRESHEST read (55), got " + last.payload.overallPct);
    if (last.bodySha !== "sha2") f.push("the retry must fence on the refreshed sha2, got " + last.bodySha);
    if (last.payload.progressSource !== "remote-read attempt=2") f.push("the carry provenance must be named, got " + last.payload.progressSource);
  }],
  ["15a-hung-put-bounded-by-request-timeout", { statusJson: MINE_LIVE, requestTimeoutSec: 5, behaviors: { put: [{ call: 1, respond: "hang", ms: 60000 }] } }, (v, f) => {
    successIsHonest(v, f);
    const hung = puts(v)[0];
    if (!hung || !String(hung.note).includes("timeout-enforced")) f.push("the hung request must die on the script's own -TimeoutSec, note=" + (hung && hung.note));
    if (hung && hung.timeoutSec !== 5) f.push("the script must pass its per-request bound (5), got " + (hung && hung.timeoutSec));
    if (v.elapsedMs > 30000) f.push("a 60s hang must not stall the finalizer (~" + v.elapsedMs + "ms)");
    if (committed(v).length !== 1) f.push("the retry after the timeout must commit");
  }],
  ["15b-permanently-failing-endpoint-bounded", { statusJson: MINE_LIVE, requestTimeoutSec: 5, behaviors: { put: [{ call: 1, respond: "500" }, { call: 2, respond: "500" }, { call: 3, respond: "500" }] } }, (v, f) => {
    if (puts(v).length !== 3) f.push("retries must be exactly bounded at 3, got " + puts(v).length);
    if (!v.transcript.includes("::warning::[m8] could not publish terminal status.json")) f.push("failure to publish must warn, not claim success");
    if (v.transcript.includes("[m8] status.json finalized:")) f.push("success must not be reported when no PUT succeeded");
    if (v.sentinel.length !== 0) f.push("no sentinel without a real publish");
    if (v.state.statusJson.runStatus !== "in_progress") f.push("snapshot must stay honestly stale");
  }],
  ["15c-put-403-not-retried", { statusJson: MINE_LIVE, behaviors: { put: [{ call: 1, respond: "403" }] } }, (v, f) => {
    if (puts(v).length !== 1) f.push("a 403 write-rejection must not be retried, got " + puts(v).length);
    if (!v.transcript.includes("http 403")) f.push("the auth rejection must be named");
    if (v.transcript.includes("[m8] status.json finalized:")) f.push("no success claim on a 403");
  }],
  ["15d-deadline-truncates-backoff", { statusJson: MINE_LIVE, requestTimeoutSec: 8, deadlineSec: 12, maxMs: 25000, behaviors: { put: [{ call: 1, respond: "hang", ms: 4000 }, { call: 2, respond: "hang", ms: 4000 }, { call: 3, respond: "hang", ms: 4000 }] } }, (v, f) => {
    // 3 real 4s sleeps + backoff would exceed 12s; the deadline must truncate
    // the post-failure sleeps so the whole finalizer stays inside ~deadline+1 request.
    if (v.elapsedMs > 24000) f.push("the overall deadline is not enforced (~" + v.elapsedMs + "ms for a 12s budget)");
    if (puts(v).length > 3) f.push("attempts stay structurally bounded");
    if (!v.transcript.includes("::warning::[m8] could not publish terminal status.json")) f.push("deadline exhaustion must warn");
  }],
  ["16-no-fabricated-completed-100", { statusJson: { ...MINE_LIVE, overallPct: 88 }, jobStatus: "success" }, (v, f) => {
    // RC-02: the retired Cleanup writer hardcoded completed/100; the finalizer must carry truth.
    successIsHonest(v, f);
    const c = committed(v)[0];
    if (!c || c.payload.runStatus !== "completed" || c.payload.overallPct !== 88) f.push("success at 88% must finalize completed/88, got " + (c && c.payload.overallPct));
    if (c && (c.payload.files.length !== 0 || c.payload.logTail.length !== 0)) f.push("termination must keep the intentionally-cleared fields cleared");
  }],
  ["19-request-log-redaction", { statusJson: MINE_LIVE, jobStatus: "success" }, (v, f) => {
    successIsHonest(v, f);
    for (const r of v.reqs) {
      if (JSON.stringify(r).includes(FAKE_TOKEN)) f.push("token value leaked into request log");
      if (typeof r.hasAuth !== "boolean") f.push("hasAuth must be a redacted boolean");
      if (!(r.timeoutSec > 0)) f.push("every request must carry the script's timeout (" + r.method + " " + r.call + ")");
    }
  }],
];

// ---------------- mutant builders (self-falsify) ----------------
function makeMutants() {
  const eap = "$ErrorActionPreference = 'Continue'\n";
  assert.ok(BODY.includes(eap), "MUT-A anchor");
  const mutA = BODY.replace(eap, eap + "exit 0\n");
  const putLine = "                      Invoke-RestMethod -Uri $api -Headers $H -Method Put ";
  const lineStart = BODY.indexOf("Invoke-RestMethod -Uri $api -Headers $H -Method Put");
  assert.ok(lineStart > 0, "MUT-B anchor");
  const sol = BODY.lastIndexOf("\n", lineStart) + 1;
  const eol = BODY.indexOf("\n", lineStart);
  const origLine = BODY.slice(sol, eol);
  const indent = origLine.match(/^\s*/)[0];
  const mutB = BODY.slice(0, sol) + indent + "if ($false) { " + origLine.trim() + " }" + BODY.slice(eol);
  assert.ok(mutA !== BODY && mutB !== BODY, "both mutations must actually apply");
  return { mutA, mutB };
}

// ---------------- tests ----------------
test("M8-B-00 extraction + runtime discovery (recorded, not assumed)", () => {
  assert.ok(BODY.length > 3000, "the extracted body must be the full script, got " + BODY.length);
  assert.ok(BODY.includes("GITHUB_RUN_ATTEMPT"), "the body must carry the generation coordination");
  console.log("[m8-behavior] runtime: node " + process.version + "; pwsh " + PWSH_VERSION + (PWSH_OK ? "" : " (RUNTIME NOT RUN)"));
  if (REQUIRE_RUNTIME && !PWSH_OK) assert.fail("M8_BEHAVIORAL=1 but pwsh is unavailable - runtime proof cannot be silently skipped");
});

for (const [name, sc, check] of CASES) {
  test("M8-B-" + name, { skip: !PWSH_OK && "pwsh unavailable - RUNTIME NOT RUN" }, async (t) => {
    const v = await runScenario({ name, ...sc });
    const f = baseFailures({ name, ...sc }, v);
    if (f.length === 0) check(v, f);
    assert.deepEqual(f, [], "scenario failures:\n- " + f.join("\n- ") + "\ntranscript tail:\n" + v.transcript.split("\n").slice(-12).join("\n"));
  });
}

test("M8-B-12-late-heartbeat-suppressed-by-sentinel (generated helper, real pwsh)", { skip: !PWSH_OK && "pwsh unavailable - RUNTIME NOT RUN" }, async () => {
  const dir = join(ROOT, "12-late-heartbeat");
  mkdirSync(dir, { recursive: true });
  const heartbeat = Buffer.from(JSON.stringify({ runId: RUN_ID, runStatus: "in_progress", overallPct: 42, runAttempt: 1 })).toString("base64");
  const helperBody = HELPER + "\n$json = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + heartbeat + "'))\nPublish-StatusToGhPages -JsonText $json\n";
  writeFileSync(join(dir, "m8-body.ps1"), helperBody);
  const scenario = { token: FAKE_TOKEN, state: { statusJson: { ...MINE_DONE }, rawContent: null, shaCounter: 1, behaviors: {} } };
  writeFileSync(join(dir, "scenario.json"), JSON.stringify(scenario));
  const env = { ...process.env, GITHUB_RUN_ID: RUN_ID, GITHUB_REPOSITORY: "ghrdp-test/example", GITHUB_TOKEN: FAKE_TOKEN, RUNNER_TEMP: dir };

  // WITH the terminal sentinel (M8 already finalized this run): suppression.
  writeFileSync(join(dir, "ghrdp-m8-terminal-" + RUN_ID + ".json"), JSON.stringify({ runId: RUN_ID, runStatus: "cancelled" }));
  let r = spawnSync(process.env.M8_PWSH || "pwsh", ["-NoProfile", "-File", "tests/m8-finalizer-harness.ps1", "-ScenarioPath", join(dir, "scenario.json")], { env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  let reqs = existsSync(join(dir, "requests.jsonl")) ? readFileSync(join(dir, "requests.jsonl"), "utf8").split("\n").filter(Boolean) : [];
  assert.equal(reqs.length, 0, "NO request may leave once the terminal sentinel exists (late heartbeat would regress cancelled -> in_progress)");
  assert.ok((r.stdout + r.stderr).includes("late publish suppressed"), "the suppression must be observable");

  // WITHOUT the sentinel (mid-run heartbeat): the helper must still publish.
  const { unlinkSync } = await import("node:fs");
  unlinkSync(join(dir, "ghrdp-m8-terminal-" + RUN_ID + ".json"));
  if (existsSync(join(dir, "requests.jsonl"))) unlinkSync(join(dir, "requests.jsonl"));
  r = spawnSync(process.env.M8_PWSH || "pwsh", ["-NoProfile", "-File", "tests/m8-finalizer-harness.ps1", "-ScenarioPath", join(dir, "scenario.json")], { env, encoding: "utf8" });
  reqs = existsSync(join(dir, "requests.jsonl")) ? readFileSync(join(dir, "requests.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  assert.equal(puts({ reqs }).length, 1, "a live heartbeat must still publish when no terminal sentinel exists");
  assert.equal(gets({ reqs }).length, 1, "the helper reads the remote sha before writing");
});

test("M8-B-self-falsify: MUT-A (early exit 0) and MUT-B (disabled PUT) redden this harness", { skip: !PWSH_OK && "pwsh unavailable - NOT RUN (structural-only proof available)" }, async () => {
  const { mutA, mutB } = makeMutants();
  const owned = CASES[0][1];        // owned snapshot + success
  const ownedCheck = CASES[0][2];   // its acceptance assertions

  // Each mutant runs the SAME acceptance scenario; the suite must come back
  // with at least one failure - that failure IS the falsification.
  const vA = await runScenario({ ...owned, name: "self-falsify-mutA" }, mutA);
  const fA = baseFailures({ name: "mutA" }, vA);
  if (!vA.spawnError) ownedCheck(vA, fA);
  assert.ok(fA.length > 0, "MUT-A (early exit 0) must redden the acceptance scenario - it did not:\n" + vA.transcript);
  assert.equal(vA.reqs.length, 0, "MUT-A exited before doing any work (the reviewer's exact finding)");
  assert.ok(!vA.transcript.includes("[m8] status.json finalized:"), "MUT-A prints no success marker");
  console.log("[m8-behavior] MUT-A reddened by: " + fA[0]);

  const vB = await runScenario({ ...owned, name: "self-falsify-mutB" }, mutB);
  const fB = baseFailures({ name: "mutB" }, vB);
  if (!vB.spawnError) ownedCheck(vB, fB);
  assert.ok(fB.length > 0, "MUT-B (PUT inside if($false)) must redden the acceptance scenario");
  assert.equal(committed(vB).length, 0, "MUT-B commits nothing regardless of what it claims");
  const honest = [];
  successIsHonest(vB, honest);
  assert.ok(fB.some((x) => x.includes("committed no PUT")) || fB.some((x) => x.includes("runStatus must be completed")) || honest.length > 0,
    "the red must be behavioral (request/payload/honesty), got: " + JSON.stringify(fB));
  console.log("[m8-behavior] MUT-B reddened by: " + fB[0]);
});

test("M8-B-20-positive-control: the UNMODIFIED source passes the primary scenario", { skip: !PWSH_OK && "pwsh unavailable - RUNTIME NOT RUN" }, async (t) => {
  // Already covered by case 01 on the same BODY; this control re-runs it via a
  // FRESH temp copy of the workflow to prove extraction is not mutated.
  const fresh = extractM8Body(readFileSync(WORKFLOW_PATH, "utf8"));
  const v = await runScenario({ name: "positive-control", statusJson: MINE_LIVE, jobStatus: "success" }, fresh);
  const f = baseFailures({ name: "positive-control" }, v);
  if (f.length === 0) CASES[0][2](v, f);
  assert.deepEqual(f, [], "positive control failed:\n- " + f.join("\n- "));
});
