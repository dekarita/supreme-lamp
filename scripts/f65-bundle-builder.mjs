#!/usr/bin/env node
// [F65 §1] PRE-STAGED STACK BUNDLE BUILDER.
//
// Downloads every pinned component from its OFFICIAL vendor source (falling back
// to the in-repo release mirror), verifies the SHA-256 byte-for-byte, stages the
// bundle layout, writes manifest.json (sha256 of every file) + the versioned
// personalization payloads, zips the lot and emits the sidecar + pointer asset.
//
// FAIL-CLOSED: a missing file, an empty pin or a pin disagreement exits 1 - the
// caller (.github/workflows/build-stack-bundle.yml) publishes NOTHING unless the
// whole set verifies. main.yml treats a bundle miss/mismatch as "fall back to
// the individual download path", never as a hard halt.
//
// Usage:
//   node scripts/f65-bundle-builder.mjs --out dist/bundle --commit <sha> [--repo-root .]
//   node scripts/f65-bundle-builder.mjs --out <dir> --manifest <pins.json> --fixtures <dir>   # offline lab
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, writeFile, copyFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

function parseArgs(argv) {
  const out = { repoRoot: '.', out: 'dist/bundle', manifest: 'payloads/f65-bundle-manifest.json', commit: '', fixtures: '', prefer: 'source', skipDownload: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => argv[++i];
    if (a === '--out') out.out = val();
    else if (a === '--repo-root') out.repoRoot = val();
    else if (a === '--manifest') out.manifest = val();
    else if (a === '--commit') out.commit = val();
    else if (a === '--fixtures') out.fixtures = val();
    else if (a === '--prefer') out.prefer = val();
    else if (a === '--skip-download') out.skipDownload = true;
    else if (a === '--help') { console.log('see header of scripts/f65-bundle-builder.mjs'); process.exit(0); }
    else throw new Error('unknown argument: ' + a);
  }
  if (!/^[0-9a-f]{7,40}$/.test(out.commit)) out.commit = out.commit || 'lab';
  return out;
}

export function sha256(buf) { return createHash('sha256').update(buf).digest('hex'); }
export function assertPin(name, value, label) {
  if (!/^[0-9a-f]{64}$/.test(value || '')) throw new Error(`[F65 bundle] ${name}: ${label} is not a 64-hex sha256 pin (fail-closed)`);
  return value;
}

async function sha256File(file) {
  const buf = await readFile(file);
  return sha256(buf);
}

async function download(url, dest, token) {
  const headers = { 'user-agent': 'ghrdp-f65-bundle-builder' };
  if (token && /github\.com/.test(url)) headers.authorization = `Bearer ${token}`;
  const res = await fetch(url, { headers, redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
  return (await stat(dest)).size;
}

function componentSources(def, prefer) {
  const list = [];
  const push = (kind, url) => { if (url) list.push({ kind, url }); };
  if (prefer === 'mirror') { push('mirror-release-asset', def.mirror_url); push('vendor', def.source_url); }
  else { push('vendor', def.source_url); push('mirror-release-asset', def.mirror_url); }
  return list;
}

async function fetchComponent(ctx, key, def) {
  const { args, tmpDir, token, log } = ctx;
  const name = def.name;
  if (!name) throw new Error(`[F65 bundle] ${key}: no name in manifest`);
  assertPin(key, def.sha256, 'sha256');
  const fixture = args.fixtures ? path.join(args.fixtures, name) : '';
  if (fixture) {
    const info = await stat(fixture).catch(() => null);
    if (info && info.isFile()) {
      const got = await sha256File(fixture);
      if (got !== def.sha256) throw new Error(`[F65 bundle] ${key}: fixture sha256 ${got} != pin ${def.sha256}`);
      log(`${key}: fixture ${name} verified (${info.size} bytes)`);
      return { path: fixture, source: 'fixture', bytes: info.size, sha256: got };
    }
  }
  if (args.skipDownload) throw new Error(`[F65 bundle] ${key}: download disabled and no fixture present`);
  let lastErr = null;
  for (const src of componentSources(def, args.prefer)) {
    const dest = path.join(tmpDir, `${key}-${path.basename(name)}`);
    try {
      const bytes = await download(src.url, dest, token);
      const got = await sha256File(dest);
      if (got !== def.sha256) throw new Error(`sha256 mismatch (observed=${got} expected=${def.sha256})`);
      if (def.size && bytes !== def.size) throw new Error(`size mismatch (observed=${bytes} expected=${def.size})`);
      log(`${key}: ${name} <- ${src.kind} (${bytes} bytes, sha256 ok)`);
      return { path: dest, source: src.kind, bytes, sha256: got };
    } catch (err) {
      lastErr = err;
      log(`${key}: ${src.kind} failed - ${err.message}`);
    }
  }
  throw new Error(`[F65 bundle] ${key}: all sources failed - ${lastErr ? lastErr.message : 'no source'} (fail-closed)`);
}

export async function buildBundle(args, opts = {}) {
  const log = opts.log || ((m) => console.log('[F65 bundle] ' + m));
  const repoRoot = path.resolve(args.repoRoot);
  const manifestPath = path.isAbsolute(args.manifest) ? args.manifest : path.join(repoRoot, args.manifest);
  const pins = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (pins.schema !== 'ghrdp-f65-bundle-manifest/1') throw new Error('[F65 bundle] unexpected manifest schema: ' + pins.schema);
  const outDir = path.resolve(args.out);
  const tmpDir = path.join(outDir, '.download');
  const stageDir = path.join(outDir, 'stage');
  await rm(outDir, { recursive: true, force: true });
  await mkdir(tmpDir, { recursive: true });
  await mkdir(path.join(stageDir, pins.stage_dir), { recursive: true });
  await mkdir(path.join(stageDir, pins.personalization_dir), { recursive: true });

  const token = opts.token ?? process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? '';
  const ctx = { args, tmpDir, token, log };
  const components = {};
  const bundleMembers = [];
  for (const [key, def] of Object.entries(pins.components)) {
    const got = await fetchComponent(ctx, key, def);
    const member = `${pins.stage_dir}/${def.name}`;
    await copyFile(got.path, path.join(stageDir, member));
    components[key] = { name: def.name, member, sha256: got.sha256, size: got.bytes, vendor: def.vendor, source: got.source, version: def.version || '' };
    bundleMembers.push(member);
    if (def.sha256_sidecar && def.sha256_sidecar_name) {
      const sidecarMember = `${pins.stage_dir}/${def.sha256_sidecar_name}`;
      const sidecarText = `${def.sha256}  ${def.name}\n`;
      await writeFile(path.join(stageDir, sidecarMember), sidecarText, 'utf8');
      const gotSidecar = sha256(await readFile(path.join(stageDir, sidecarMember)));
      if (gotSidecar !== def.sha256_sidecar) throw new Error(`[F65 bundle] ${key}: sidecar sha256 ${gotSidecar} != pin ${def.sha256_sidecar}`);
      components[key].sidecar_member = sidecarMember;
      bundleMembers.push(sidecarMember);
    }
  }

  const personalization = [];
  for (const rel of Object.keys(pins.personalization || {})) {
    const src = path.join(repoRoot, rel);
    const info = await stat(src).catch(() => null);
    if (!info || !info.isFile()) throw new Error(`[F65 bundle] personalization payload missing: ${rel}`);
    const member = `${pins.personalization_dir}/${path.basename(rel)}`;
    await copyFile(src, path.join(stageDir, member));
    const digest = await sha256File(path.join(stageDir, member));
    personalization.push({ name: path.basename(rel), member, sha256: digest, size: (await stat(path.join(stageDir, member))).size });
    bundleMembers.push(member);
  }

  const manifest = {
    schema: 'ghrdp-f65-stack-bundle/1',
    commit: args.commit,
    built_at: opts.now || new Date().toISOString(),
    components,
    personalization,
    files: {},
    total_bytes: 0,
  };
  const all = [...bundleMembers].sort();
  for (const member of all) {
    const full = path.join(stageDir, member);
    const info = await stat(full);
    manifest.files[member] = { sha256: await sha256File(full), size: info.size };
    manifest.total_bytes += info.size;
  }
  await writeFile(path.join(stageDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  manifest.files['manifest.json'] = { sha256: await sha256File(path.join(stageDir, 'manifest.json')), size: (await stat(path.join(stageDir, 'manifest.json'))).size };

  const bundleName = `ghrdp-stack-${args.commit}.zip`;
  const zipPath = path.join(outDir, bundleName);
  const zip = spawnSync('zip', ['-q', '-r', '-X', zipPath, '.'], { cwd: stageDir });
  if (zip.status !== 0) throw new Error('[F65 bundle] zip failed: ' + (zip.stderr || '').toString());
  const zipSha = await sha256File(zipPath);
  const zipSize = (await stat(zipPath)).size;
  await writeFile(zipPath + '.sha256', `${zipSha}  ${bundleName}\n`, 'utf8');
  const pointer = {
    schema: 'ghrdp-f65-stack-pointer/1',
    asset: bundleName,
    sha256: zipSha,
    size: zipSize,
    commit: args.commit,
    built_at: manifest.built_at,
    manifest_sha256: manifest.files['manifest.json'].sha256,
  };
  await writeFile(path.join(outDir, pins.pointer_asset), JSON.stringify(pointer, null, 2) + '\n', 'utf8');
  await writeFile(path.join(outDir, 'build-report.json'), JSON.stringify({ ...pointer, components: manifest.components, total_uncompressed_bytes: manifest.total_bytes }, null, 2) + '\n', 'utf8');
  log(`bundle ${bundleName} (${zipSize} bytes, sha256 ${zipSha}) + ${pins.pointer_asset}`);
  return { bundlePath: zipPath, bundleName, sha256: zipSha, size: zipSize, pointerPath: path.join(outDir, pins.pointer_asset), manifest, outDir };
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]).endsWith('f65-bundle-builder.mjs');
if (invokedDirectly) {
  const args = parseArgs(process.argv.slice(2));
  buildBundle(args).catch((err) => { console.error(String(err && err.message ? err.message : err)); process.exit(1); });
}
