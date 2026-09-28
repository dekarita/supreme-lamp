import type { FileEntry, GofileHostConfig, GofileStatus, IndexJson, IndexRoot, UploadLastError, UploadPhase, UploadStatus } from '../schema';
import defaultHost from '../default-gofile-host.json';
import { computeId } from './stableId';

const EPOCH = '1970-01-01T00:00:00.000Z';
const ROOTS: IndexRoot[] = ['Downloads', 'Desktop', 'Documents', 'Temp', 'RDP-Storage'];
const PHASES: UploadPhase[] = ['dns', 'tcp', 'tls', 'encrypt', 'size', 'type', 'auth', 'http', 'parse'];
const UPLOAD_STATUSES: UploadStatus[] = ['idle', 'queued', 'uploading', 'success', 'failed', 'canceled'];
const GOFILE_STATUSES: GofileStatus[] = ['none', 'uploaded', 'processing', 'expired', 'failed'];
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const text = (value: unknown, fallback: string) => typeof value === 'string' ? value : fallback;
const nullableText = (value: unknown) => typeof value === 'string' ? value : null;
const number = (value: unknown, fallback = 0) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
const nullableNumber = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const strings = (value: unknown) => array(value).filter((item): item is string => typeof item === 'string');
const member = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T => allowed.includes(value as T) ? value as T : fallback;
const root = (value: unknown) => member(value, ROOTS, 'Temp');
const iso = (value: unknown, fallback = EPOCH) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : fallback;

function lastError(value: unknown): UploadLastError | null {
  if (value == null) return null;
  const src = object(value);
  const result: UploadLastError = { phase: member(src.phase, PHASES, 'parse') };
  if (typeof src.httpStatus === 'number') result.httpStatus = src.httpStatus;
  if (typeof src.hostMessage === 'string') result.hostMessage = src.hostMessage;
  if (typeof src.at === 'string') result.at = src.at;
  return result;
}

function safeDirectUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
    return value;
  } catch { return null; }
}

function file(value: unknown): FileEntry {
  const f = object(value);
  const r = root(f.root);
  const path = '/' + text(f.path, '').replace(/\\/g, '/').replace(/^\/+/, '');
  const upload = object(f.upload);
  const gofile = object(f.gofile);
  const status = member(gofile.status, GOFILE_STATUSES, 'none');
  return {
    id: typeof f.id === 'string' && f.id ? f.id : computeId(r, path),
    root: r, path, size: number(f.size), mtime: iso(f.mtime),
    mime: text(f.mime, 'application/octet-stream'), checksum: nullableText(f.checksum),
    tags: strings(f.tags), pinned: f.pinned === true, trashed: f.trashed === true,
    trashedAt: nullableText(f.trashedAt), recentsTs: nullableText(f.recentsTs),
    upload: {
      phase: upload.phase == null ? null : member(upload.phase, PHASES, 'parse'),
      status: member(upload.status, UPLOAD_STATUSES, 'idle'), retries: number(upload.retries),
      lastError: lastError(upload.lastError), bytesSent: number(upload.bytesSent),
    },
    gofile: {
      code: nullableText(gofile.code), fileId: nullableText(gofile.fileId),
      directUrl: status === 'uploaded' ? safeDirectUrl(gofile.directUrl) : null,
      status, uploadedAt: nullableText(gofile.uploadedAt), expiryTs: nullableText(gofile.expiryTs),
      downloads: number(gofile.downloads), remoteSize: nullableNumber(gofile.remoteSize),
    },
  };
}

/** Additive for modeled v1 fields: defaults missing fields, never mutates input.
 * Only plain JSON data is supported (not hostile proxies/getters). Unknown
 * properties are not copied into the browser's modeled index. Not an auth or
 * path-security validator: the server must enforce its root/realpath allowlist.
 */
export function migrateV1toV2(value: unknown): IndexJson {
  const src = object(value);
  // One configured host, never a fallback/rotation channel.
  const configured = array(src.gofileHosts).map(object).find((host) => host.id === 'gofile');
  const h = configured ?? defaultHost;
  const host: GofileHostConfig = {
    id: 'gofile', displayName: text(h.displayName, defaultHost.displayName),
    maxFileBytes: nullableNumber(h.maxFileBytes), allowedMimePrefixes: h.allowedMimePrefixes == null ? null : strings(h.allowedMimePrefixes),
    ttlSeconds: nullableNumber(h.ttlSeconds), notes: text(h.notes, ''),
  };
  return {
    schemaVersion: 2, generatedAt: iso(src.generatedAt), runnerId: text(src.runnerId, 'unknown'),
    roots: array(src.roots).map((value) => {
      const r = object(value);
      return { root: root(r.root), scannedAt: iso(r.scannedAt), totalBytes: number(r.totalBytes), fileCount: number(r.fileCount), quotaBytes: nullableNumber(r.quotaBytes) };
    }),
    files: array(src.files).map(file), gofileHosts: [host],
  };
}
