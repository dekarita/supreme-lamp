import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import v1 from '@/components/explorer/data/fixtures/index-v1.json';
import stress from '@/components/explorer/data/fixtures/5000-files.json';
import mimeMap from '@/components/explorer/data/fixtures/preview-mime-map.json';
import { migrateV1toV2 } from '@/components/explorer/data/migrations/v1_to_v2';
import { computeId } from '@/components/explorer/data/migrations/stableId';
import { INDEX_SCHEMA_VERSION } from '@/components/explorer/data/schema';

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe('F45 S2 schema migration', () => {
  it('adds every v2 field while preserving v1 basic data', () => {
    const result = migrateV1toV2(v1);
    expect(result.schemaVersion).toBe(INDEX_SCHEMA_VERSION);
    expect(result.files[0]).toMatchObject(v1.files[0]);
    expect(result.files[0]).toMatchObject({
      checksum: null, tags: [], pinned: false, trashed: false, trashedAt: null, recentsTs: null,
      upload: { phase: null, status: 'idle', retries: 0, lastError: null, bytesSent: 0 },
      gofile: { code: null, fileId: null, directUrl: null, status: 'none', uploadedAt: null, expiryTs: null, downloads: 0, remoteSize: null },
    });
    expect(result.gofileHosts).toHaveLength(1);
    expect(result.gofileHosts[0].id).toBe('gofile');
  });
  it.each([null, undefined, 0, '', [], {}, { files: null }, { files: [null, 0, {}, { upload: {}, gofile: {} }] }, { files: false, roots: false }])('salvages partial plain JSON %# without throwing and idempotently', (partial) => {
    const result = migrateV1toV2(partial);
    expect(migrateV1toV2(result)).toEqual(result);
    expect(migrateV1toV2(partial)).toEqual(result);
  });
  it('fills partial nested objects without losing progress or the full host error', () => {
    const message = 'Untruncated host error. '.repeat(500);
    const result = migrateV1toV2({ files: [{ root: 'Downloads', path: '/a.txt',
      upload: { status: 'failed', retries: 3, bytesSent: 1024, lastError: { phase: 'http', httpStatus: 502, hostMessage: message } },
      gofile: { status: 'processing', fileId: 'remote-1' },
    }] });
    expect(result.files[0].upload).toEqual({ phase: null, status: 'failed', retries: 3, bytesSent: 1024, lastError: { phase: 'http', httpStatus: 502, hostMessage: message } });
    expect(result.files[0].gofile).toMatchObject({ status: 'processing', fileId: 'remote-1', directUrl: null, downloads: 0 });
    expect(migrateV1toV2(result)).toEqual(result);
  });
  it('does not mutate input or share mutable arrays/nested objects', () => {
    const input = clone(stress);
    const before = clone(input);
    const result = migrateV1toV2(input);
    result.files[0].tags.push('edited');
    result.files[0].upload.status = 'failed';
    result.roots[0].fileCount = 99;
    expect(input).toEqual(before);
  });
  it.each(['', '/a.txt', '/සිංහල.txt', '/emoji-🗂️.txt', '/' + 'long'.repeat(1000)])('stable UTF-8 IDs agree with Node SHA1: %s', (path) => {
    expect(computeId('Downloads', path)).toBe(createHash('sha1').update('Downloads' + path, 'utf8').digest('hex'));
    expect(computeId('Documents', path)).not.toBe(computeId('Downloads', path));
  });
  it('normalizes Windows separators before computing ID', () => {
    const a = migrateV1toV2({ files: [{ root: 'Downloads', path: 'reports\\a.txt' }] });
    const b = migrateV1toV2({ files: [{ root: 'Downloads', path: '/reports/a.txt' }] });
    expect(a.files[0].id).toBe(b.files[0].id);
    expect(a.files[0].path).toBe('/reports/a.txt');
  });
  it.each(['http://gofile.test/file', 'https://name:password@gofile.test/file', 'https://gofile.test/file?token=fixture', 'https://gofile.test/file#key', 'not-a-url'])('never promotes unsafe URLs into v2 directUrl: %s', (url) => {
    const result = migrateV1toV2({ files: [{ gofile: { status: 'uploaded', directUrl: url } }] });
    expect(result.files[0].gofile.directUrl).toBeNull();
  });
  it('only keeps credential-free links in uploaded state; ignores unknown properties/hosts', () => {
    const result = migrateV1toV2({ token: 'fixture-only', gofileHosts: [{ id: 'alternate' }], files: [
      { gofile: { status: 'uploaded', directUrl: 'https://gofile.test/file' } },
      { gofile: { status: 'processing', directUrl: 'https://gofile.test/file' } },
    ] });
    expect(result.files[0].gofile.directUrl).toBe('https://gofile.test/file');
    expect(result.files[1].gofile.directUrl).toBeNull();
    expect(result).not.toHaveProperty('token');
    expect(result.gofileHosts.map((host) => host.id)).toEqual(['gofile']);
  });
  it('stress fixture has 5000 unique valid entries, consistent root totals, and round-trips', () => {
    expect(stress.files).toHaveLength(5000);
    expect(new Set(stress.files.map((file) => file.id)).size).toBe(5000);
    for (const root of stress.roots) {
      const entries = stress.files.filter((file) => file.root === root.root);
      expect(entries.length).toBe(root.fileCount);
      expect(entries.reduce((sum, file) => sum + file.size, 0)).toBe(root.totalBytes);
    }
    expect(migrateV1toV2(stress)).toEqual(stress);
  });
  it('MIME fixture contains at least 40 unique cases covering all nine renderer families', () => {
    expect(mimeMap.length).toBeGreaterThanOrEqual(40);
    expect(new Set(mimeMap.map((entry) => entry.mime)).size).toBe(mimeMap.length);
    expect([...new Set(mimeMap.map((entry) => entry.renderer))].sort()).toEqual(['audio', 'code', 'crypto', 'hex', 'image', 'md', 'pdf', 'text', 'video']);
  });
});
