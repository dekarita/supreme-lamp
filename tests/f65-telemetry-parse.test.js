// [F65 §4] TELEMETRY PARSE SUITE.
//
// Parses the SHIPPED artifact shape (<scratch>\f65-telemetry.jsonl, uploaded as
// `f65-telemetry`) and asserts the mandated anchors. Fixtures model a real
// dispatch; when F65_TELEMETRY_ARTIFACT points at a live artifact the same parser
// runs over it (that is the "live-dispatch backing" hook - a fixture alone is
// NEVER reported as a production number).
//
// HONESTY NOTE (F65 §6 "NO 'guaranteed' claims"): the tailscale-join-start point
// is asserted to be a RECORDED number. The 0-2 s band would only exist if the
// second-0 background join lane were shipped - it is not (see
// docs/F65-STACK-BUNDLE.md), so the fixture uses the synchronous-junction values
// and the band is reported as a flag, never as a claim.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const main = fs.readFileSync(path.join(root, ".github/workflows/main.yml"), "utf8");
const prefetch = fs.readFileSync(path.join(root, "payloads/f65-prefetch.ps1"), "utf8");

function fixtureLines({ fallback = false } = {}) {
  const at = (i) => new Date(Date.UTC(2026, 9, 2, 12, 0, i)).toISOString();
  const rows = [
    ["f65-scratch-detect", 2.1, "source=D root=D:\\scratch", true],
    ["f65-prefetch-launch", 2.4, "pid=4242 detached=yes", true],
    ["f65-prefetch-start", 2.6, "scratch=D:\\scratch mode=background", true],
    ["f65-pointer-fetch", 1.8, "exit=0 file=ghrdp-stack-latest.json", false],
    ["f65-bundle-download", fallback ? 12.4 : 24.2, "asset=ghrdp-stack-1a2b3c4d5e6f.zip bytes=300123456", false],
    ["f65-bundle-sha256-verify", 1.2, "observed=9f8e7d6c5b4a pointerMatch=True sidecarMatch=True", false],
    ["f65-bundle-extract", 9.4, "dest=D:\\scratch\\stack", false],
    ["f65-manifest-verify", 4.6, "files=10 verified=10 bad=0 map=10", false],
    ["f65-parallel-legs", 118.0, "map=manifest-verify legs=10", true],
    ["f65-stack-extensions-staged", 121.0, "dest=C:\\ghrdp\\extensions", true],
    ["f65-stack-webrtc-staged", 122.0, "dest=C:\\ghrdp\\webrtc-prebuilt (consumer swap deferred)", true],
    ["f65-stack-ready", 124.0, "asset=ghrdp-stack-1a2b3c4d5e6f.zip bytes=300123456 files=10", true],
    ["f65-tailscale-join-start", 64.0, "synchronous join (second-0 background launcher not shipped)", true],
    ["f65-consumer-idd", 322.0, "source=pre-staged-bundle sha256=e93b88f31ce3", true],
    ["f65-consumer-vbcable", 325.5, "source=pre-staged-bundle", true],
    ["f65-consumer-extensions", 326.0, "staged=crx+xpi stack=ready", true],
    ["f65-consumer-ffmpeg", 402.0, "source=pre-staged-bundle", true],
    ["f65-dashboard-ready", 388.0, "dashboard-reachable-from-job-start (F59 marker mirrored)", true],
    ["f65-rendezvous-stack", 389.5, "stack=ready", true],
    ["f65-probe-dashboard-health", 0.4, "HTTP 200 essential=True ok=True", false],
    ["f65-probe-magicdns-resolve", 1.6, "magicdns=runner.tailnet.ts.net a=100.64.1.2 essential=True ok=True", false],
    ["f65-probe-rdp-3389", 0.3, "tcp 127.0.0.1:3389 listening=True essential=True ok=True", false],
    ["f65-probe-webrtc-8443", 0.3, "tcp 127.0.0.1:8443 listening=False essential=False ok=False", false],
    ["f65-probe-parsec-service", 0.2, "not-installed (expected on this lane) essential=False ok=False", false],
    ["f65-probe-rendezvous", 3.4, "legs=5 essential-ok=3/3", false],
  ];
  // a failed prefetch writes NO stack-ready/staging points (see payloads/f65-prefetch.ps1)
  const stackOnly = new Set(["f65-stack-extensions-staged", "f65-stack-webrtc-staged", "f65-stack-ready", "f65-consumer-idd", "f65-consumer-vbcable", "f65-consumer-extensions", "f65-consumer-ffmpeg", "f65-parallel-legs", "f65-manifest-verify"]);
  const kept = fallback ? rows.filter(([point]) => !stackOnly.has(point)) : rows;
  if (fallback) {
    kept.push(["f65-prefetch-fallback", 12.9, "bundle sha256 mismatch - consumers fall back to individual downloads", false]);
    kept.push(["f65-consumer-idd", 322.0, "source=individual-download (bundle miss)", true]);
    kept.push(["f65-consumer-vbcable", 325.5, "source=individual-download", true]);
  }
  return kept.map(([point, sec, detail, jobClock], i) => JSON.stringify({ point, sec, at: at(i), detail, jobClock }));
}

function parseJsonl(text) {
  const points = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const rec = JSON.parse(line);
    assert.equal(typeof rec.point, "string", "point name");
    assert.equal(typeof rec.sec, "number", "sec is numeric");
    assert.ok(!Number.isNaN(Date.parse(rec.at)), "at is an ISO timestamp");
    points.push(rec);
  }
  return points;
}

function byName(points) {
  const map = new Map();
  for (const p of points) map.set(p.point, p);
  return map;
}

test("F65 telemetry: a dispatch artifact yields >=15 points with the mandated anchors", () => {
  const points = parseJsonl(fixtureLines().join("\n"));
  assert.ok(points.length >= 15, `expected >=15 points, got ${points.length}`);
  const names = new Set(points.map((p) => p.point));
  for (const required of ["f65-bundle-download", "f65-parallel-legs", "f65-manifest-verify", "f65-dashboard-ready", "f65-probe-rendezvous"]) {
    assert.ok(names.has(required), `missing ${required}`);
  }
  // the parallel-install block is visible: >=4 concurrent probe legs + the map point
  const probes = points.filter((p) => p.point.startsWith("f65-probe-"));
  assert.ok(probes.length >= 5, "at least the 5 probe legs must be recorded");
  assert.ok(points.some((p) => p.point === "f65-parallel-legs" && /legs=\d+/.test(p.detail)));
});

test("F65 telemetry: tailscale-join-start is recorded (0-2s band reported, never claimed)", () => {
  const points = parseJsonl(fixtureLines().join("\n"));
  const join = byName(points).get("f65-tailscale-join-start");
  assert.ok(join, "f65-tailscale-join-start must be recorded");
  assert.equal(typeof join.sec, "number");
  assert.ok(join.sec >= 0, "a recorded join start is never negative");
  // shipped reality: synchronous join. If a future artifact lands in the 0-2s
  // band, that means the second-0 lane shipped - and then it must SAY so.
  const second0Lane = join.sec <= 2;
  if (second0Lane) assert.match(join.detail, /second-0|background/i, "a 0-2s value must be labelled as the background lane");
  else assert.match(join.detail, /synchronous/i, "a synchronous value must be labelled as such");
  // and the shipped workflow must not pretend the second-0 lane exists
  assert.match(main, /Add-F65Point -Name 'f65-tailscale-join-start'[\s\S]{0,220}synchronous join \(second-0 background launcher not shipped\)/);
});

test("F65 telemetry: ordering is coherent (bundle download -> verify -> extract -> manifest -> ready)", () => {
  const points = byName(parseJsonl(fixtureLines().join("\n")));
  assert.ok(points.get("f65-prefetch-start").sec <= points.get("f65-stack-ready").sec, "producer clock is monotonic");
  assert.ok(points.get("f65-bundle-sha256-verify").sec < points.get("f65-bundle-extract").sec, "verify before extract is impossible to skip");
  assert.ok(points.get("f65-stack-ready").sec < points.get("f65-dashboard-ready").sec, "the stack is ready before the dashboard on this run");
  assert.ok(points.get("f65-dashboard-ready").sec < points.get("f65-consumer-ffmpeg").sec, "post-dashboard consumers land after READY");
});

test("F65 telemetry: a bundle-miss artifact stays parseable and marks the fallback", () => {
  const points = parseJsonl(fixtureLines({ fallback: true }).join("\n"));
  const names = new Set(points.map((p) => p.point));
  assert.ok(names.has("f65-prefetch-fallback"), "fallback must be explicit in the telemetry");
  assert.ok(!names.has("f65-stack-ready"), "a failed prefetch never claims stack-ready");
  const consumers = points.filter((p) => p.point.startsWith("f65-consumer-"));
  for (const c of consumers) assert.match(c.detail, /individual|source=/, `fallback consumer detail: ${c.detail}`);
});

test("F65 telemetry: the shipped sources emit the anchors the parse expects", () => {
  const required = ["f65-scratch-detect", "f65-prefetch-start", "f65-bundle-download", "f65-bundle-sha256-verify", "f65-bundle-extract", "f65-manifest-verify", "f65-parallel-legs", "f65-stack-ready", "f65-dashboard-ready", "f65-probe-rendezvous", "f65-rendezvous-stack"];
  const haystack = main + prefetch + fs.readFileSync(path.join(root, "payloads/f65-stack.ps1"), "utf8");
  for (const name of required) assert.ok(haystack.includes(`'${name}'`), `shipped source must emit ${name}`);
  assert.ok(main.includes("[F65-TELEMETRY-COUNT] points="), "report step must print the parseable count line");
  assert.ok(main.includes("name: f65-telemetry"), "artifact name must match the operator contract");
  assert.ok(prefetch.includes("f65-telemetry.jsonl") === false, "the producer writes through the helper, not a hardcoded path");
});

test("F65 telemetry: live artifact parses when F65_TELEMETRY_ARTIFACT is provided", (t) => {
  const artifact = process.env.F65_TELEMETRY_ARTIFACT;
  if (!artifact) {
    t.skip("no live artifact in this environment (set F65_TELEMETRY_ARTIFACT to the downloaded f65-telemetry.jsonl)");
    return;
  }
  const points = parseJsonl(fs.readFileSync(artifact, "utf8"));
  assert.ok(points.length >= 15, `live artifact must carry >=15 points, got ${points.length}`);
  const names = new Set(points.map((p) => p.point));
  for (const required of ["f65-prefetch-start", "f65-bundle-download", "f65-parallel-legs", "f65-dashboard-ready"]) {
    assert.ok(names.has(required), `live artifact missing ${required}`);
  }
});
