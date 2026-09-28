#!/usr/bin/env node
// Deterministic S2 data fixture; mock-only URLs, no real host access or secrets.
import { writeFileSync } from 'node:fs';
const roots = ['Downloads', 'Desktop', 'Documents', 'Temp', 'RDP-Storage'];
const at = '2026-01-01T00:00:00.000Z';
const mimes = [['text/plain', 'txt'], ['image/png', 'png'], ['application/pdf', 'pdf'], ['application/json', 'json'], ['video/mp4', 'mp4']];
const files = Array.from({ length: 5000 }, (_, index) => ({
  id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
  root: roots[index % roots.length],
  path: `/reports/${Math.floor(index / 100)}/file-${String(index + 1).padStart(5, '0')}.${mimes[index % mimes.length][1]}`,
  size: (index + 1) * 1024, mtime: at, mime: mimes[index % mimes.length][0], checksum: null,
  tags: index % 10 === 0 ? ['lab'] : [], pinned: index % 20 === 0,
  trashed: index % 100 === 0, trashedAt: index % 100 === 0 ? at : null,
  recentsTs: index < 120 ? at : null,
  upload: { phase: null, status: 'idle', retries: 0, lastError: null, bytesSent: 0 },
  gofile: { code: null, fileId: null, directUrl: null, status: 'none', uploadedAt: null, expiryTs: null, downloads: 0, remoteSize: null },
}));
const fixture = {
  schemaVersion: 2, generatedAt: at, runnerId: 'fx-lab-runner',
  roots: roots.map((root) => {
    const entries = files.filter((file) => file.root === root);
    return { root, scannedAt: at, totalBytes: entries.reduce((sum, file) => sum + file.size, 0), fileCount: entries.length, quotaBytes: null };
  }), files,
  gofileHosts: [{ id: 'gofile', displayName: 'gofile.io', maxFileBytes: null, allowedMimePrefixes: null, ttlSeconds: null, notes: '' }],
};
// One row per file keeps diffs readable without 150k lines of pretty JSON.
const output = JSON.stringify(fixture).replace(/\},\{"id":/g, '},\n{"id":') + '\n';
writeFileSync('src/components/explorer/data/fixtures/5000-files.json', output);
console.log('[F45 S2] generated deterministic 5000-file fixture');
