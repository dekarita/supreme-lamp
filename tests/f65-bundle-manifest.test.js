// [F65 §5] PRE-STAGED STACK BUNDLE - pins + builder lab + fail-closed cells.
//
// Everything here runs offline: the pins are static, and the builder is exercised
// through its --fixtures lab mode (tiny local files, a lab manifest) in a temp dir.
// The production digests are ALSO asserted against the released mirror digests by
// docs/F65-STACK-BUNDLE.md provenance notes; CI re-verifies them for real when the
// bundle is built (any drift fails the build, never a silent publish).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const manifest = JSON.parse(read("payloads/f65-bundle-manifest.json"));
const main = read(".github/workflows/main.yml");
const bundleWf = read(".github/workflows/build-stack-bundle.yml");
const builderSrc = read("scripts/f65-bundle-builder.mjs");
const scratchSrc = read("scripts/f65-detect-scratch.ps1");
const prefetchSrc = read("payloads/f65-prefetch.ps1");
const stackSrc = read("payloads/f65-stack.ps1");

const HEX64 = /^[0-9a-f]{64}$/;
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "f65-lab-"));

function runBuilder(args) {
  return spawnSync(process.execPath, [path.join(root, "scripts/f65-bundle-builder.mjs"), ...args], {
    encoding: "utf8",
    cwd: root,
    env: { ...process.env, GH_TOKEN: "" },
  });
}

function labFixture(entries) {
  const dir = fs.mkdtempSync(path.join(tmpRoot, "case-"));
  const fixtures = path.join(dir, "fixtures");
  fs.mkdirSync(fixtures, { recursive: true });
  const components = {};
  for (const [key, body] of Object.entries(entries)) {
    const file = path.join(fixtures, `${key}.bin`);
    fs.writeFileSync(file, body);
    components[key] = {
      name: `${key}.bin`,
      version: "lab",
      sha256: require("node:crypto").createHash("sha256").update(body).digest("hex"),
      size: Buffer.byteLength(body),
      vendor: "lab-fixture",
      source_url: "",
      mirror_url: "",
    };
  }
  const labManifest = path.join(dir, "lab-manifest.json");
  fs.writeFileSync(
    labManifest,
    JSON.stringify(
      {
        schema: "ghrdp-f65-bundle-manifest/1",
        release_tag: "stack-bundle",
        pointer_asset: "ghrdp-stack-latest.json",
        stage_dir: "stack",
        personalization_dir: "personalization",
        components,
        personalization: {
          "payloads/f65-personalization.json": "lab",
          "payloads/f65-bookmarks.json": "lab",
        },
      },
      null,
      2
    )
  );
  return { dir, fixtures, labManifest };
}

test("F65 manifest: schema + one component per pre-staged artefact", () => {
  assert.equal(manifest.schema, "ghrdp-f65-bundle-manifest/1");
  assert.equal(manifest.release_tag, "stack-bundle");
  assert.match(manifest.pointer_asset, /^ghrdp-stack-latest\.json$/);
  assert.match(manifest.asset_pattern, /ghrdp-stack-<commit>\.zip/);
  for (const key of ["tailscale", "ffmpeg", "vbcable", "idd_sample_driver", "ublock_crx", "ublock_xpi", "webrtc"]) {
    assert.ok(manifest.components[key], `component ${key} must exist`);
  }
  // Parsec + qBittorrent are deliberately NOT bundled (no consumer / single source of truth).
  assert.ok(!manifest.components.parsec, "parsec must not be bundled (main.yml does not install it)");
  assert.ok(!manifest.components.qbittorrent, "qBittorrent stays on the F59 prebuilt lane");
});

test("F65 manifest: every pin is a real 64-hex sha256 + official vendor + documented fallback", () => {
  for (const [key, c] of Object.entries(manifest.components)) {
    assert.match(c.sha256, HEX64, `${key} sha256 pin`);
    assert.ok(Number.isInteger(c.size) && c.size > 0, `${key} size`);
    assert.ok(c.vendor && c.vendor.length > 3, `${key} vendor provenance`);
    assert.match(c.source_url || c.release_page_url, /^https:\/\//, `${key} https source`);
    assert.ok(c.pins_verified_via, `${key} must document how the pin was corroborated`);
    assert.ok(c.consumed_by, `${key} must name its consumer (or the deferral)`);
  }
  // The vendor digests that GitHub publishes today must equal the pins (F65 verified
  // them through the API when the manifest was authored - here they are recorded
  // so a silent edit of the pin is caught by review + this test).
  assert.equal(
    manifest.components.ffmpeg.sha256,
    "759d0a9831c436a0eb331ad36f236c06cb04aaa0005da46571f0e9d3d9206f6b"
  );
  assert.equal(
    manifest.components.ublock_crx.sha256,
    "d688ed3f0262ec4f8bdcd4c8f65987c5444c560aeb387a9e02aca1facdfa7046"
  );
  assert.equal(
    manifest.components.ublock_xpi.sha256,
    "5b74415860456370644bd80f16125e865b0e6c356bb5dfcfb84069967eaa5287"
  );
  assert.equal(manifest.components.ffmpeg.size, 257736868);
  assert.equal(manifest.components.webrtc.size, 9009341);
  // the webrtc sidecar pin must be the digest of the published 65-byte convention
  // ("<sha256>\n") - this is what broke the first CI build and it must stay caught.
  const w = manifest.components.webrtc;
  const sidecarBytes = `${w.sha256}\n`;
  assert.equal(require("node:crypto").createHash("sha256").update(sidecarBytes).digest("hex"), w.sha256_sidecar);
  assert.equal(Buffer.byteLength(sidecarBytes), 65);
});

test("F65 builder: lab build produces zip + sidecar + pointer + manifest with every file hashed", () => {
  const { fixtures, labManifest, dir } = labFixture({ alpha: "AAAA", beta: "BBBBBBBB" });
  const out = path.join(dir, "out");
  const res = runBuilder(["--out", out, "--manifest", labManifest, "--fixtures", fixtures, "--commit", "deadbeefcafe"]);
  assert.equal(res.status, 0, res.stderr);
  const zip = path.join(out, "ghrdp-stack-deadbeefcafe.zip");
  assert.ok(fs.existsSync(zip), "versioned zip");
  const zipSha = require("node:crypto").createHash("sha256").update(fs.readFileSync(zip)).digest("hex");
  const sidecar = fs.readFileSync(zip + ".sha256", "utf8").trim();
  assert.match(sidecar, new RegExp("^" + zipSha + "\\s+ghrdp-stack-deadbeefcafe\\.zip$"));
  const pointer = JSON.parse(fs.readFileSync(path.join(out, "ghrdp-stack-latest.json"), "utf8"));
  assert.equal(pointer.asset, "ghrdp-stack-deadbeefcafe.zip");
  assert.equal(pointer.sha256, zipSha, "pointer sha256 == zip sha256");
  assert.equal(pointer.size, fs.statSync(zip).size);
  // unpack and verify the internal manifest against the real files
  const unzipDir = path.join(dir, "unzip");
  const unzip = spawnSync("unzip", ["-qq", zip, "-d", unzipDir], { encoding: "utf8" });
  assert.equal(unzip.status, 0, unzip.stderr);
  const inner = JSON.parse(fs.readFileSync(path.join(unzipDir, "manifest.json"), "utf8"));
  for (const [member, rec] of Object.entries(inner.files)) {
    const full = path.join(unzipDir, member);
    assert.ok(fs.existsSync(full), `bundle member ${member}`);
    const got = require("node:crypto").createHash("sha256").update(fs.readFileSync(full)).digest("hex");
    assert.equal(got, rec.sha256, `${member} sha256`);
    assert.equal(fs.statSync(full).size, rec.size, `${member} size`);
  }
  assert.ok(inner.files["stack/alpha.bin"], "stack member staged under stage_dir");
  assert.ok(inner.files["personalization/f65-bookmarks.json"], "personalization payload staged");
  assert.equal(inner.components.alpha.size, 4);
  assert.equal(inner.total_bytes, Object.values(inner.files).reduce((a, f) => a + f.size, 0));
});

test("F65 builder: a pinned sha256 sidecar is reproduced byte-for-byte (65-byte convention)", () => {
  const body = "WEBSRV";
  const sum = require("node:crypto").createHash("sha256").update(body).digest("hex");
  const sidecarDigest = require("node:crypto").createHash("sha256").update(`${sum}\n`).digest("hex");
  const dir = fs.mkdtempSync(path.join(tmpRoot, "sidecar-"));
  const fixtures = path.join(dir, "fixtures");
  fs.mkdirSync(fixtures, { recursive: true });
  fs.writeFileSync(path.join(fixtures, "websrv.zip"), body);
  const labManifest = path.join(dir, "lab-manifest.json");
  fs.writeFileSync(
    labManifest,
    JSON.stringify({
      schema: "ghrdp-f65-bundle-manifest/1",
      release_tag: "stack-bundle",
      pointer_asset: "ghrdp-stack-latest.json",
      stage_dir: "stack",
      personalization_dir: "personalization",
      components: {
        webrtc: { name: "websrv.zip", version: "lab", sha256: sum, size: Buffer.byteLength(body), vendor: "lab", source_url: "", mirror_url: "", sha256_sidecar_name: "websrv.zip.sha256", sha256_sidecar: sidecarDigest },
      },
      personalization: { "payloads/f65-personalization.json": "lab" },
    })
  );
  const out = path.join(dir, "out");
  const res = runBuilder(["--out", out, "--manifest", labManifest, "--fixtures", fixtures, "--commit", "deadbeefcafe"]);
  assert.equal(res.status, 0, res.stderr);
  const unzipDir = path.join(dir, "unzip");
  assert.equal(spawnSync("unzip", ["-qq", path.join(out, "ghrdp-stack-deadbeefcafe.zip"), "-d", unzipDir]).status, 0);
  const sidecar = fs.readFileSync(path.join(unzipDir, "stack/websrv.zip.sha256"), "utf8");
  assert.equal(sidecar, `${sum}\n`, "sidecar content must be the 65-byte convention");
  assert.equal(require("node:crypto").createHash("sha256").update(sidecar).digest("hex"), sidecarDigest);
});

test("F65 builder: fail-closed - tampered fixture, empty pin and missing source all refuse", () => {
  const { fixtures, labManifest, dir } = labFixture({ alpha: "AAAA" });
  fs.writeFileSync(path.join(fixtures, "alpha.bin"), "TAMPERED");
  const res = runBuilder(["--out", path.join(dir, "out"), "--manifest", labManifest, "--fixtures", fixtures, "--commit", "deadbeefcafe"]);
  assert.notEqual(res.status, 0, "tampered fixture must fail the build");
  assert.match(res.stderr, /sha256/);
  assert.ok(!fs.existsSync(path.join(dir, "out", "ghrdp-stack-deadbeefcafe.zip")), "no bundle is published on failure");

  const { fixtures: f2, labManifest: m2, dir: d2 } = labFixture({ beta: "BB" });
  const bad = JSON.parse(fs.readFileSync(m2, "utf8"));
  bad.components.beta.sha256 = "";
  fs.writeFileSync(m2, JSON.stringify(bad));
  const res2 = runBuilder(["--out", path.join(d2, "out"), "--manifest", m2, "--fixtures", f2, "--commit", "deadbeefcafe"]);
  assert.notEqual(res2.status, 0, "empty pin must be refused");
  assert.match(res2.stderr, /64-hex sha256 pin/);

  const { labManifest: m3, dir: d3 } = labFixture({ gamma: "GG" });
  fs.rmSync(m3.replace("lab-manifest.json", "fixtures"), { recursive: true, force: true });
  const res3 = runBuilder(["--out", path.join(d3, "out"), "--manifest", m3, "--commit", "deadbeefcafe", "--skip-download"]);
  assert.notEqual(res3.status, 0, "missing source with downloads disabled must be refused");
});

test("F65 builder: repo-owned assets fall back to the documented API download route", () => {
  const { parseReleaseAssetUrl } = require(path.join(root, "scripts/f65-bundle-builder.mjs"));
  const asset = manifest.components.webrtc.source_url;
  const parsed = parseReleaseAssetUrl(asset);
  assert.deepEqual(
    { owner: parsed.owner, repo: parsed.repo, tag: parsed.tag, name: parsed.name },
    { owner: "dekarita", repo: "supreme-lamp", tag: "webrtc-dist", name: manifest.components.webrtc.name }
  );
  assert.equal(parseReleaseAssetUrl("https://pkgs.tailscale.com/stable/tailscale-setup-1.102.4-amd64.msi"), null);
  assert.match(builderSrc, /Accept: application\/octet-stream|accept: 'application\/octet-stream'/);
  assert.match(builderSrc, /api fallback: asset/);
});

test("F65 builder: prefers the vendor source, falls back to the release mirror", () => {
  assert.match(builderSrc, /mirror-release-asset/);
  assert.match(builderSrc, /for \(const src of componentSources\(def, args\.prefer\)\)/);
  assert.match(builderSrc, /all sources failed/);
  assert.match(builderSrc, /if \(prefer === 'mirror'\)/);
});

test("F65 workflow: push trigger is primary, cron is backup-only, no self-hosted, publishes atomically", () => {
  assert.match(bundleWf, /on:\n  push:\n    paths:/);
  for (const p of ["payloads/f65-bundle-manifest.json", "scripts/f65-bundle-builder.mjs"]) {
    assert.ok(bundleWf.includes(p), `push paths must include ${p}`);
  }
  assert.match(bundleWf, /schedule:\n    - cron: '0 2 \* \* 0'/);
  assert.ok(!/self-hosted/.test(bundleWf), "the bundle builds on ubuntu-latest only");
  assert.match(bundleWf, /runs-on: ubuntu-latest/);
  assert.match(bundleWf, /gh release upload "\$tag" dist\/bundle\/\*\.zip dist\/bundle\/\*\.sha256 dist\/bundle\/ghrdp-stack-latest\.json --clobber/);
  assert.match(bundleWf, /node --test tests\/f65-bundle-manifest\.test\.js/);
});

test("F65 main.yml: the bundle is additive and NEVER a hard dependency", () => {
  // scratch + prefetch launcher step
  assert.match(main, /name: F65 scratch root \+ background stack-bundle prefetch \(off critical path\)/);
  assert.ok(main.includes("payloads\\f65-prefetch.ps1"), "the launcher must point at the producer script");
  // launched DETACHED: Start-Process -PassThru, and no -Wait inside that command
  assert.match(main, /Start-Process -FilePath \$pwshPath -PassThru -WindowStyle Hidden/);
  const launchBlock = main.slice(main.indexOf("$preScript = Join-Path"), main.indexOf("$preScript = Join-Path") + 900);
  assert.ok(!/-Wait/.test(launchBlock), "the prefetch launch must not block the step");
  // consumers rendezvous through the shipped helpers and keep their individual fallback
  assert.match(main, /Get-F65StackState -Scratch \$env:GHRDP_F65_SCRATCH -Wait -TimeoutSec/);
  assert.match(main, /Get-F65Component/);
  assert.match(main, /name: F65 rendezvous \+ parallel health probes \(60s cap, non-fatal\)/);
  assert.match(main, /name: F65 telemetry report \(f65-telemetry\.jsonl\)/);
  assert.match(main, /name: f65-telemetry\b/);
  assert.ok(main.includes("[F65-TELEMETRY-COUNT] points="), "the report step must emit a machine-readable count");
  assert.match(prefetchSrc, /f65-prefetch-fallback/);
  assert.match(prefetchSrc, /Exit-F65Prefetch -Status 'failed' -Reason \('bundle sha256/);
  assert.match(stackSrc, /Start-ThreadJob/);
  assert.match(stackSrc, /ForEach-Object -Parallel/);
  assert.match(stackSrc, /start-job-wave/);
  assert.match(scratchSrc, /D:\\scratch/);
  assert.match(scratchSrc, /C:\\scratch/);
});

test("F65 telemetry: at least 15 emission points ship, with the mandated anchors", () => {
  const sources = main + prefetchSrc + read("payloads/f65-stack.ps1");
  const names = new Set();
  for (const m of sources.matchAll(/(?:Add|Stop)-F65Point -Name '([^']+)'/g)) names.add(m[1]);
  for (const m of sources.matchAll(/(?:Add|Stop)-F65Point -Name \('([^']+)/g)) names.add(m[1] + "<dynamic>");
  assert.ok(names.size >= 15, `expected >=15 F65 telemetry points, found ${names.size}: ${[...names].join(",")}`);
  for (const required of [
    "f65-scratch-detect",
    "f65-prefetch-start",
    "f65-bundle-download",
    "f65-bundle-sha256-verify",
    "f65-parallel-legs",
    "f65-manifest-verify",
    "f65-stack-ready",
    "f65-tailscale-join-start",
    "f65-dashboard-ready",
    "f65-probe-rendezvous",
  ]) {
    assert.ok(names.has(required), `telemetry point ${required} must be emitted`);
  }
});

test("F65 personalization payloads: versioned and free of third-party indexes", () => {
  const bm = JSON.parse(read("payloads/f65-bookmarks.json"));
  const urls = bm.bookmarks.map((b) => b.url || b.url_template);
  assert.ok(urls.length === 3, "exactly the three canonical bookmarks");
  assert.ok(urls.some((u) => u.includes("AUTOLOGIN.md")));
  assert.ok(urls.some((u) => u.includes("login.tailscale.com/admin/dns")));
  assert.ok(urls.some((u) => u.startsWith("http://{rdpIp}")));
  for (const u of urls) {
    assert.ok(!/1337x|thepiratebay|torrent|rarbg|yts\./i.test(u), `no index bookmark: ${u}`);
  }
  const pers = JSON.parse(read("payloads/f65-personalization.json"));
  assert.equal(pers.version, 1);
  assert.match(String(pers.theme.accent_color), /^0x[0-9a-f]{8}$/);
  // main.yml still writes the authoritative values - the payload must agree with it
  assert.ok(main.includes("0xff4cc2ff"), "accent colour must match main.yml");
  assert.ok(main.includes("0xff2a6f8f"), "inactive accent must match main.yml");
});
