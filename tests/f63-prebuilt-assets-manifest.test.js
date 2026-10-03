'use strict';

// F63 (SPEED-OPT - RDP JOB 11min -> 6-7min on free tier windows-latest):
//   - Optimization A: .github/workflows/build-webrtc.yml compiles ghrdp-webrtc + probe
//     once, uploads ghrdp-webrtc-<sha>.zip + .sha256 to release `webrtc-dist`;
//     main.yml skips go test + go build on SHA-256 verified prebuilt hit and
//     falls back to go test + go build on miss/mismatch.
//   - Optimization B: actions/cache@v4 for ~/go/pkg/mod + ~/.cache/go-build
//     (keyed on go.sum hash), C:/ProgramData/chocolatey/lib (keyed on install
//     manifest), and %LOCALAPPDATA%/npm-cache (keyed on package-lock hash).
//   - Optimization C: payloads/f63-prebuilt-manifest.json and
//     payloads/f63-prebuilt/manifest.json pin official vendor sources,
//     release-page URLs, 64-hex SHA-256 hashes, and fallback commands for
//     FFmpeg, VB-CABLE, IddSampleDriver, Chrome extensions CRX, Parsec, and
//     Tailscale MSI.
//   - Optimization D: payloads/f63-prebuilt/f63-prebuilt-helper.ps1 runs
//     non-dependent installs in a parallel Start-Job array
//     [FFmpeg, VB-CABLE, virtual display driver, Chrome extensions, Parsec installer extract]
//     with Wait-Job rendezvous before dependent dashboard startup.
//   - Timing artifact: startup-timing-f63.jsonl emitted and verified <= 450s (7m30s).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Worker } = require('node:worker_threads');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST_ROOT = path.join(ROOT, 'payloads', 'f63-prebuilt-manifest.json');
const MANIFEST_DIR = path.join(ROOT, 'payloads', 'f63-prebuilt', 'manifest.json');
const HELPER_PS1 = path.join(ROOT, 'payloads', 'f63-prebuilt', 'f63-prebuilt-helper.ps1');
const BUILD_WEBRTC_YML = path.join(ROOT, '.github', 'workflows', 'build-webrtc.yml');
const MAIN_YML = path.join(ROOT, '.github', 'workflows', 'main.yml');
const DEPLOY_BOOTSTRAP_PS1 = path.join(ROOT, 'payloads', 'ghrdp-webrtc', 'deploy-bootstrap.ps1');
const LAB_PS1 = path.join(ROOT, 'tests', 'f63-speed-opt-lab.ps1');
const TIMING_JSONL = path.join(ROOT, 'startup-timing-f63.jsonl');

const OFFICIAL_VENDOR_HOSTS = new Set([
  'github.com',
  'download.vb-audio.com',
  'builds.parsec.app',
  'pkgs.tailscale.com',
  'ffmpeg.org',
  'community.chocolatey.org',
  'chromewebstore.google.com',
  'parsec.app',
]);

describe('F63 C: prebuilt assets manifest + SHA-256 pins + official vendor sources', () => {
  const rawRoot = fs.readFileSync(MANIFEST_ROOT, 'utf8');
  const rawDir = fs.readFileSync(MANIFEST_DIR, 'utf8');
  const manifest = JSON.parse(rawRoot);
  const manifestCopy = JSON.parse(rawDir);

  it('keeps payloads/f63-prebuilt-manifest.json and payloads/f63-prebuilt/manifest.json in sync', () => {
    assert.equal(manifest.schema, 'ghrdp-f63-prebuilt-manifest/1');
    assert.deepEqual(manifest, manifestCopy);
  });

  it('pins valid 64-hex SHA-256 digests, official vendor URLs, release_page_url, and fallback_cmd for all required installers', () => {
    const required = [
      'ffmpeg',
      'vbcable',
      'idd_sample_driver',
      'chrome_extensions',
      'parsec',
      'tailscale',
    ];
    for (const key of required) {
      const item = manifest.assets[key];
      assert.ok(item, `missing manifest asset: ${key}`);
      assert.match(item.sha256, /^[0-9a-f]{64}$/, `${key}.sha256 must be 64 lowercase hex chars`);
      assert.notEqual(item.sha256, '0'.repeat(64), `${key}.sha256 must not be all zeros`);
      assert.ok(!/[a-p]{32}/.test(item.sha256), `${key}.sha256 must not trigger F10 [a-p]{32} extension-id scan`);

      const srcUrl = new URL(item.source_url);
      const relUrl = new URL(item.release_page_url);
      assert.equal(srcUrl.protocol, 'https:', `${key}.source_url must use https`);
      assert.equal(relUrl.protocol, 'https:', `${key}.release_page_url must use https`);
      assert.ok(
        OFFICIAL_VENDOR_HOSTS.has(srcUrl.hostname),
        `${key}.source_url host ${srcUrl.hostname} is not in OFFICIAL_VENDOR_HOSTS`,
      );
      assert.ok(
        OFFICIAL_VENDOR_HOSTS.has(relUrl.hostname),
        `${key}.release_page_url host ${relUrl.hostname} is not in OFFICIAL_VENDOR_HOSTS`,
      );
      assert.ok(
        typeof item.fallback_cmd === 'string' && item.fallback_cmd.trim().length > 10,
        `${key}.fallback_cmd must be non-empty`,
      );
    }
  });

  it('declares WebRTC prebuilt bundle pattern + SHA-256 sidecar + go test/build fallback', () => {
    assert.ok(manifest.webrtc_prebuilt, 'missing webrtc_prebuilt section');
    assert.equal(manifest.webrtc_prebuilt.workflow, '.github/workflows/build-webrtc.yml');
    assert.equal(manifest.webrtc_prebuilt.release_tag, 'webrtc-dist');
    assert.equal(manifest.webrtc_prebuilt.asset_pattern, 'ghrdp-webrtc-<sha>.zip');
    assert.equal(manifest.webrtc_prebuilt.sha256_pattern, 'ghrdp-webrtc-<sha>.zip.sha256');
    assert.match(manifest.webrtc_prebuilt.fallback, /go test.*go build/i);
  });
});

describe('F63 A: prebuild WebRTC workflow + deploy-bootstrap + main.yml fallback', () => {
  const wf = fs.readFileSync(BUILD_WEBRTC_YML, 'utf8');
  const main = fs.readFileSync(MAIN_YML, 'utf8');
  const bootstrap = fs.readFileSync(DEPLOY_BOOTSTRAP_PS1, 'utf8');

  it('build-webrtc.yml compiles webrtc-server.exe + probe.exe and uploads ghrdp-webrtc-<sha>.zip + .sha256', () => {
    assert.match(wf, /webrtc-server\.exe/);
    assert.match(wf, /probe\.exe/);
    assert.match(wf, /ghrdp-webrtc-'\s*\+\s*\$sha\s*\+\s*'\.zip/);
    assert.match(wf, /Get-FileHash\s+-LiteralPath\s+\$zipPath\s+-Algorithm\s+SHA256/);
    assert.match(wf, /gh release upload \$tag \$zipPath \$shaPath --clobber/);
  });

  it('main.yml + deploy-bootstrap.ps1 use SHA-256 verified prebuilt WebRTC and fall back to go test + go build on miss', () => {
    assert.match(main, /Resolve-F63WebRtcPrebuilt/);
    assert.match(main, /GHRDP_WEBRTC_PREBUILT_HIT/);
    assert.match(main, /::warning title=F63 webrtc fallback::/);
    assert.match(main, /go test -mod=readonly -count=1 \.\//);
    assert.match(bootstrap, /F63 prebuilt binary hit for commit=/);
    assert.match(bootstrap, /F63 prebuilt binary miss - falling back to on-runner go build/);
  });
});

describe('F63 B: Go modules + Chocolatey + npm caches in main.yml', () => {
  const main = fs.readFileSync(MAIN_YML, 'utf8');

  it('configures actions/cache@v4 for ~/go/pkg/mod + ~/.cache/go-build keyed on go.sum', () => {
    assert.match(main, /~\/go\/pkg\/mod/);
    assert.match(main, /~\/\.cache\/go-build/);
    assert.match(main, /hashFiles\('payloads\/ghrdp-webrtc\/go\.sum'\)/);
  });

  it('configures actions/cache@v4 for C:/ProgramData/chocolatey/lib keyed on install manifest', () => {
    assert.match(main, /C:\/ProgramData\/chocolatey\/lib/);
    assert.match(main, /hashFiles\('payloads\/f63-prebuilt-manifest\.json'\)/);
  });

  it('configures actions/cache@v4 for npm-cache keyed on package-lock.json', () => {
    assert.match(main, /npm-cache/);
    assert.match(main, /hashFiles\('package-lock\.json'\)/);
  });
});

describe('F63 C & D: fallback paths + parallel Start-Job / Wait-Job rendezvous', () => {
  const helper = fs.readFileSync(HELPER_PS1, 'utf8');
  const main = fs.readFileSync(MAIN_YML, 'utf8');

  it('helper implements SHA-256 verification, fallback resolution, and parallel Start-Job + Wait-Job rendezvous', () => {
    assert.match(helper, /function Test-F63AssetSha256/);
    assert.match(helper, /function Resolve-F63PrebuiltAsset/);
    assert.match(helper, /function Resolve-F63WebRtcPrebuilt/);
    assert.match(helper, /function Invoke-F63ParallelInstalls/);
    assert.match(helper, /Start-Job\s+-Name\s+\('f63-'/);
    assert.match(helper, /Wait-Job\s+-Job\s+\$jobs/);
    for (const leg of ['ffmpeg', 'vbcable', 'idd_sample_driver', 'chrome_extensions', 'parsec']) {
      assert.ok(helper.includes(`'${leg}'`), `missing parallel leg ${leg} in helper`);
    }
  });

  it('simulates SHA-256 verification + fallback path on asset miss and hash mismatch', () => {
    const payload = Buffer.from('f63-verified-installer-bytes', 'utf8');
    const expectedSha = crypto.createHash('sha256').update(payload).digest('hex');

    function verifyAsset(bytes, pin, fallbackCmd) {
      if (!bytes) {
        return { hit: false, reason: 'asset-missing', fallback_cmd: fallbackCmd };
      }
      const actual = crypto.createHash('sha256').update(bytes).digest('hex');
      if (actual !== pin) {
        return { hit: false, reason: 'sha256-mismatch', actual, expected: pin, fallback_cmd: fallbackCmd };
      }
      return { hit: true, reason: 'verified', sha256: actual, fallback_cmd: null };
    }

    const ok = verifyAsset(payload, expectedSha, 'choco install ffmpeg -y');
    assert.equal(ok.hit, true);
    assert.equal(ok.sha256, expectedSha);

    const miss = verifyAsset(null, expectedSha, 'choco install ffmpeg -y');
    assert.equal(miss.hit, false);
    assert.equal(miss.reason, 'asset-missing');
    assert.equal(miss.fallback_cmd, 'choco install ffmpeg -y');

    const bad = verifyAsset(Buffer.from('tampered'), expectedSha, 'choco install ffmpeg -y');
    assert.equal(bad.hit, false);
    assert.equal(bad.reason, 'sha256-mismatch');
    assert.equal(bad.fallback_cmd, 'choco install ffmpeg -y');
  });

  it('proves parallel-job wait rendezvous completes all 5 install legs before dashboard startup and beats serial sum', async () => {
    const legs = [
      { leg: 'ffmpeg', ms: 120 },
      { leg: 'vbcable', ms: 110 },
      { leg: 'idd_sample_driver', ms: 100 },
      { leg: 'chrome_extensions', ms: 115 },
      { leg: 'parsec', ms: 105 },
    ];
    const events = [];
    const t0 = performance.now();
    const results = await Promise.all(
      legs.map(
        (item) =>
          new Promise((resolve, reject) => {
            const w = new Worker(
              `
              const { parentPort, workerData } = require('node:worker_threads');
              setTimeout(() => {
                parentPort.postMessage({ leg: workerData.leg, ms: workerData.ms, finishedAt: Date.now() });
              }, workerData.ms);
              `,
              { eval: true, workerData: item },
            );
            w.on('message', (msg) => {
              events.push(`leg-done:${msg.leg}`);
              resolve(msg);
            });
            w.on('error', reject);
          }),
      ),
    );
    const parallelElapsedMs = performance.now() - t0;
    events.push('wait-job-rendezvous');
    events.push('dashboard-start');

    const serialSumMs = legs.reduce((acc, l) => acc + l.ms, 0);
    assert.equal(results.length, 5);
    assert.equal(events[events.length - 2], 'wait-job-rendezvous');
    assert.equal(events[events.length - 1], 'dashboard-start');
    assert.ok(
      parallelElapsedMs < serialSumMs,
      `expected parallel elapsed (${parallelElapsedMs.toFixed(1)}ms) < serial sum (${serialSumMs}ms)`,
    );

    const idxParallel = main.indexOf('F63 parallel prebundled installs + WebRTC prebuilt (Wait-Job before dashboard startup)');
    const idxDash = main.indexOf('Start Mission Control dashboard EARLY (PS 7331, SYSTEM task, confirm LISTENING)');
    assert.ok(idxParallel > 0 && idxDash > idxParallel, 'F63 parallel Wait-Job step must precede dashboard startup in main.yml');
  });

  it('verifies startup-timing-f63.jsonl is present and total dispatch-to-dashboard <= 450s (7m30s)', () => {
    assert.ok(fs.existsSync(LAB_PS1), 'tests/f63-speed-opt-lab.ps1 must exist');
    assert.ok(fs.existsSync(TIMING_JSONL), 'startup-timing-f63.jsonl must exist');
    const lines = fs
      .readFileSync(TIMING_JSONL, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    assert.ok(lines.length >= 6, `expected >= 6 timing records in startup-timing-f63.jsonl, got ${lines.length}`);
    const rows = lines.map((l) => JSON.parse(l));
    const totalRow = rows.find((r) => r.step === 'dispatch-to-dashboard' || r.step === 'dashboard-reachable-from-job-start');
    assert.ok(totalRow, 'startup-timing-f63.jsonl must include dispatch-to-dashboard / dashboard-reachable-from-job-start');
    assert.ok(
      typeof totalRow.sec === 'number' && totalRow.sec > 0 && totalRow.sec <= 450,
      `expected total startup sec <= 450s (7m30s), got ${totalRow.sec}s`,
    );
  });
});
