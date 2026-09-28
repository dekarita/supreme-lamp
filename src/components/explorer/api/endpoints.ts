/**
 * F45 S3 — Explorer §5 typed endpoint clients.
 *
 * Exactly the five endpoints the brief scopes for this stage:
 *   GET  /api/fx/list            -> IndexJson (schemaVersion must be 2)
 *   GET  /api/fx/meta            -> FileEntry
 *   GET  /api/fx/gofile/status   -> GofileState
 *   POST /api/fx/op              -> { applied, skipped }
 *   POST /api/fx/upload          -> 202 { jobs }
 * plus same-origin URL builders for the two stream endpoints (`/preview`,
 * `/upload/events`) whose clients land with S4/S8.
 *
 * Every response is validated before it is returned; anything unexpected is a
 * `parse`-phase FxError, never a partially-typed object handed to the UI. A v1
 * index is rejected here, which is what drives the §12.5 "runner needs restart"
 * notice rather than a half-migrated screen.
 */
import type { FileEntry, GofileState, IndexJson, IndexRoot, UploadPhase, UploadState } from '../data/schema';
import { INDEX_SCHEMA_VERSION } from '../data/schema';
import { FxError } from './errors';
import type { FxClient, FxRequestOptions } from './fxClient';

export const FX_PATHS = {
  list: '/api/fx/list',
  meta: '/api/fx/meta',
  gofileStatus: '/api/fx/gofile/status',
  preview: '/api/fx/preview',
  op: '/api/fx/op',
  upload: '/api/fx/upload',
  uploadEvents: '/api/fx/upload/events',
} as const;

export const FX_OPS = ['trash', 'restore', 'move', 'tag', 'pin'] as const;
export type FxOpName = (typeof FX_OPS)[number];

export interface FxOpRequest {
  op: FxOpName;
  ids: string[];
  /** Destination for `move`, relative to a root. */
  target?: string;
  tags?: string[];
  pin?: boolean;
  /** §5.1(6) idempotency; sent as X-Idempotency-Key. */
  idempotencyKey?: string;
  signal?: AbortSignal;
  retry?: boolean;
}

export interface FxOpSkipped {
  id: string;
  reason: string;
}

export interface FxOpResult {
  applied: string[];
  skipped: FxOpSkipped[];
}

export type GofileHostId = 'gofile';

export interface FxUploadJob {
  id: string;
  uploadJobId: string;
}

export interface FxUploadAccepted {
  jobs: FxUploadJob[];
}

export interface FxApi {
  listIndex(options?: { root?: IndexRoot } & FxRequestOptions): Promise<IndexJson>;
  getMeta(id: string, options?: FxRequestOptions): Promise<FileEntry>;
  getGofileStatus(id: string, options?: FxRequestOptions): Promise<GofileState>;
  runOp(request: FxOpRequest): Promise<FxOpResult>;
  startUpload(request: { ids: string[]; host: GofileHostId } & FxRequestOptions): Promise<FxUploadAccepted>;
  /** Byte-stream endpoint (Range-aware). URL only: no fetch in S3. */
  previewUrl(id: string): string;
  /** SSE endpoint. URL only: EventSource wiring lands with S8. */
  uploadEventsUrl(): string;
}

const UPLOAD_STATUSES = ['idle', 'queued', 'uploading', 'success', 'failed', 'canceled'] as const;
const GOFILE_STATUSES = ['none', 'uploaded', 'processing', 'expired', 'failed'] as const;
const UPLOAD_PHASES = ['dns', 'tcp', 'tls', 'encrypt', 'size', 'type', 'auth', 'http', 'parse'] as const;
const ROOTS = ['Downloads', 'Desktop', 'Documents', 'Temp', 'RDP-Storage'] as const;

export function createFxApi(client: FxClient, now: () => number = () => Date.now()): FxApi {
  const parseError = (detail: string): FxError =>
    new FxError({
      phase: 'parse',
      httpStatus: null,
      hostMessage: detail,
      messageKey: 'fx.err.parse',
      retryable: false,
      retryAfterMs: null,
      at: new Date(now()).toISOString(),
    });

  return {
    async listIndex(options = {}) {
      const { root, ...rest } = options;
      const body = await client.request<unknown>(FX_PATHS.list, { ...rest, query: { root } });
      return assertIndexJson(body, parseError);
    },

    async getMeta(id, options = {}) {
      requireId(id, parseError);
      const body = await client.request<unknown>(FX_PATHS.meta, { ...options, query: { id } });
      return assertFileEntry(body, parseError, 'meta');
    },

    async getGofileStatus(id, options = {}) {
      requireId(id, parseError);
      const body = await client.request<unknown>(FX_PATHS.gofileStatus, { ...options, query: { id } });
      return assertGofileState(body, parseError, 'gofile/status');
    },

    async runOp(request) {
      const { op, ids, target, tags, pin, idempotencyKey, signal, retry } = request;
      if (!FX_OPS.includes(op)) throw parseError(`unknown op: ${String(op)}`);
      // §5.1(3): no hard delete anywhere. The type cannot express it; this guard
      // also rejects a caller that smuggles one in from untyped JSON.
      if ('hard' in (request as unknown as Record<string, unknown>)) {
        throw parseError('refused: hard delete is not an Explorer operation');
      }
      if (!Array.isArray(ids) || ids.length === 0) throw parseError('op requires at least one id');
      const body = await client.request<unknown>(
        FX_PATHS.op,
        {
          method: 'POST',
          body: { op, ids, ...(target !== undefined ? { target } : {}), ...(tags !== undefined ? { tags } : {}), ...(pin !== undefined ? { pin } : {}) },
          idempotencyKey,
          signal,
          retry,
        },
      );
      return assertOpResult(body, parseError);
    },

    async startUpload(request) {
      const { ids, host, ...rest } = request;
      if (host !== 'gofile') throw parseError(`unknown upload host: ${String(host)}`);
      if (!Array.isArray(ids) || ids.length === 0) throw parseError('upload requires at least one id');
      const body = await client.request<unknown>(FX_PATHS.upload, {
        ...rest,
        method: 'POST',
        body: { ids, host },
      });
      return assertUploadAccepted(body, parseError);
    },

    previewUrl(id) {
      requireId(id, parseError);
      return client.href(FX_PATHS.preview, { id });
    },

    uploadEventsUrl() {
      return client.href(FX_PATHS.uploadEvents);
    },
  };
}

function requireId(id: string, fail: (detail: string) => FxError): void {
  if (typeof id !== 'string' || id.length === 0) throw fail('a non-empty file id is required');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown, field: string, where: string, fail: (d: string) => FxError): string {
  if (typeof value !== 'string') throw fail(`${where}: ${field} must be a string`);
  return value;
}

function num(value: unknown, field: string, where: string, fail: (d: string) => FxError): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw fail(`${where}: ${field} must be a finite number`);
  return value;
}

function nullableStr(value: unknown, field: string, where: string, fail: (d: string) => FxError): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw fail(`${where}: ${field} must be a string or null`);
  return value;
}

export function assertIndexJson(value: unknown, fail: (detail: string) => FxError): IndexJson {
  if (!isRecord(value)) throw fail('index: expected an object');
  // §12.5: a non-v2 index is a fail-visible condition, not a silent downgrade.
  if (value.schemaVersion !== INDEX_SCHEMA_VERSION) {
    throw fail(`index: schemaVersion ${String(value.schemaVersion)} is not ${INDEX_SCHEMA_VERSION}; runner needs restart`);
  }
  str(value.generatedAt, 'generatedAt', 'index', fail);
  str(value.runnerId, 'runnerId', 'index', fail);
  if (!Array.isArray(value.roots)) throw fail('index: roots must be an array');
  if (!Array.isArray(value.files)) throw fail('index: files must be an array');
  if (!Array.isArray(value.gofileHosts)) throw fail('index: gofileHosts must be an array');

  const roots = value.roots.map((entry, i) => {
    if (!isRecord(entry)) throw fail(`index.roots[${i}]: expected an object`);
    const where = `index.roots[${i}]`;
    if (!ROOTS.includes(entry.root as (typeof ROOTS)[number])) throw fail(`${where}: unknown root ${String(entry.root)}`);
    return {
      root: entry.root as IndexRoot,
      scannedAt: str(entry.scannedAt, 'scannedAt', where, fail),
      totalBytes: num(entry.totalBytes, 'totalBytes', where, fail),
      fileCount: num(entry.fileCount, 'fileCount', where, fail),
      quotaBytes: entry.quotaBytes === null ? null : num(entry.quotaBytes, 'quotaBytes', where, fail),
    };
  });

  const gofileHosts = value.gofileHosts.map((entry, i) => {
    if (!isRecord(entry)) throw fail(`index.gofileHosts[${i}]: expected an object`);
    const where = `index.gofileHosts[${i}]`;
    if (entry.id !== 'gofile') throw fail(`${where}: only the configured gofile host is modelled`);
    return {
      id: 'gofile' as const,
      displayName: str(entry.displayName, 'displayName', where, fail),
      maxFileBytes: entry.maxFileBytes === null ? null : num(entry.maxFileBytes, 'maxFileBytes', where, fail),
      allowedMimePrefixes:
        entry.allowedMimePrefixes === null
          ? null
          : Array.isArray(entry.allowedMimePrefixes)
            ? entry.allowedMimePrefixes.map((prefix) => str(prefix, 'allowedMimePrefixes[]', where, fail))
            : (() => {
                throw fail(`${where}: allowedMimePrefixes must be an array or null`);
              })(),
      ttlSeconds: entry.ttlSeconds === null ? null : num(entry.ttlSeconds, 'ttlSeconds', where, fail),
      notes: str(entry.notes, 'notes', where, fail),
      // [F48 §1.3] token-less guest mode; a recorded 401/403 probe/attempt
      // result round-trips, anything else defaults to the guest contract.
      ...(entry.authMode === 'requires-account'
        ? { authMode: 'requires-account' as const }
        : entry.authMode === 'guest'
          ? { authMode: 'guest' as const }
          : {}),
    };
  });

  const files = value.files.map((entry, i) => assertFileEntry(entry, fail, `index.files[${i}]`));

  return {
    schemaVersion: INDEX_SCHEMA_VERSION,
    generatedAt: str(value.generatedAt, 'generatedAt', 'index', fail),
    runnerId: str(value.runnerId, 'runnerId', 'index', fail),
    roots,
    files,
    gofileHosts,
  };
}

export function assertUploadState(value: unknown, fail: (detail: string) => FxError, where: string): UploadState {
  if (!isRecord(value)) throw fail(`${where}: expected an object`);
  const phase = value.phase;
  if (phase !== null && !UPLOAD_PHASES.includes(phase as (typeof UPLOAD_PHASES)[number])) {
    throw fail(`${where}: unknown phase ${String(phase)}`);
  }
  if (!UPLOAD_STATUSES.includes(value.status as (typeof UPLOAD_STATUSES)[number])) {
    throw fail(`${where}: unknown status ${String(value.status)}`);
  }
  const lastError = value.lastError;
  if (lastError !== null && !isRecord(lastError)) throw fail(`${where}: lastError must be an object or null`);
  if (isRecord(lastError) && !UPLOAD_PHASES.includes(lastError.phase as (typeof UPLOAD_PHASES)[number])) {
    throw fail(`${where}: lastError.phase unknown ${String(lastError.phase)}`);
  }
  return {
    phase: (phase ?? null) as UploadState['phase'],
    status: value.status as UploadState['status'],
    retries: num(value.retries, 'retries', where, fail),
    lastError:
      lastError === null
        ? null
        : {
            phase: (lastError as Record<string, unknown>).phase as UploadPhase,
            httpStatus:
              (lastError as Record<string, unknown>).httpStatus === undefined
                ? undefined
                : num((lastError as Record<string, unknown>).httpStatus, 'lastError.httpStatus', where, fail),
            hostMessage: nullableStr((lastError as Record<string, unknown>).hostMessage, 'lastError.hostMessage', where, fail) ?? undefined,
            at: nullableStr((lastError as Record<string, unknown>).at, 'lastError.at', where, fail) ?? undefined,
          },
    bytesSent: num(value.bytesSent, 'bytesSent', where, fail),
  };
}

export function assertGofileState(value: unknown, fail: (detail: string) => FxError, where: string): GofileState {
  if (!isRecord(value)) throw fail(`${where}: expected an object`);
  if (!GOFILE_STATUSES.includes(value.status as (typeof GOFILE_STATUSES)[number])) {
    throw fail(`${where}: unknown gofile status ${String(value.status)}`);
  }
  const status = value.status as GofileState['status'];
  const directUrl = nullableStr(value.directUrl, 'directUrl', where, fail);
  // §4 invariant: a direct link only exists for an uploaded file. A link on any
  // other status would be a fabricated, possibly credential-bearing URL.
  if (directUrl !== null && status !== 'uploaded') {
    throw fail(`${where}: directUrl must be null while status is ${status}`);
  }
  return {
    code: nullableStr(value.code, 'code', where, fail),
    fileId: nullableStr(value.fileId, 'fileId', where, fail),
    directUrl,
    status,
    uploadedAt: nullableStr(value.uploadedAt, 'uploadedAt', where, fail),
    expiryTs: nullableStr(value.expiryTs, 'expiryTs', where, fail),
    downloads: num(value.downloads, 'downloads', where, fail),
    remoteSize: value.remoteSize === null ? null : num(value.remoteSize, 'remoteSize', where, fail),
  };
}

export function assertFileEntry(value: unknown, fail: (detail: string) => FxError, where: string): FileEntry {
  if (!isRecord(value)) throw fail(`${where}: expected an object`);
  if (!ROOTS.includes(value.root as (typeof ROOTS)[number])) throw fail(`${where}: unknown root ${String(value.root)}`);
  const path = str(value.path, 'path', where, fail);
  if (!path.startsWith('/')) throw fail(`${where}: path must be POSIX-style with a leading slash`);
  return {
    id: str(value.id, 'id', where, fail),
    root: value.root as IndexRoot,
    path,
    size: num(value.size, 'size', where, fail),
    mtime: str(value.mtime, 'mtime', where, fail),
    mime: str(value.mime, 'mime', where, fail),
    checksum: nullableStr(value.checksum, 'checksum', where, fail),
    tags: Array.isArray(value.tags) ? value.tags.map((tag) => str(tag, 'tags[]', where, fail)) : (() => { throw fail(`${where}: tags must be an array`); })(),
    pinned: typeof value.pinned === 'boolean' ? value.pinned : (() => { throw fail(`${where}: pinned must be a boolean`); })(),
    trashed: typeof value.trashed === 'boolean' ? value.trashed : (() => { throw fail(`${where}: trashed must be a boolean`); })(),
    trashedAt: nullableStr(value.trashedAt, 'trashedAt', where, fail),
    recentsTs: nullableStr(value.recentsTs, 'recentsTs', where, fail),
    upload: assertUploadState(value.upload, fail, `${where}.upload`),
    gofile: assertGofileState(value.gofile, fail, `${where}.gofile`),
  };
}

export function assertOpResult(value: unknown, fail: (detail: string) => FxError): FxOpResult {
  if (!isRecord(value)) throw fail('op: expected an object');
  if (!Array.isArray(value.applied)) throw fail('op: applied must be an array');
  if (!Array.isArray(value.skipped)) throw fail('op: skipped must be an array');
  return {
    applied: value.applied.map((id, i) => str(id, `applied[${i}]`, 'op', fail)),
    skipped: value.skipped.map((entry, i) => {
      if (!isRecord(entry)) throw fail(`op.skipped[${i}]: expected an object`);
      return { id: str(entry.id, 'id', `op.skipped[${i}]`, fail), reason: str(entry.reason, 'reason', `op.skipped[${i}]`, fail) };
    }),
  };
}

export function assertUploadAccepted(value: unknown, fail: (detail: string) => FxError): FxUploadAccepted {
  if (!isRecord(value)) throw fail('upload: expected an object');
  if (!Array.isArray(value.jobs)) throw fail('upload: jobs must be an array');
  return {
    jobs: value.jobs.map((entry, i) => {
      if (!isRecord(entry)) throw fail(`upload.jobs[${i}]: expected an object`);
      const where = `upload.jobs[${i}]`;
      return { id: str(entry.id, 'id', where, fail), uploadJobId: str(entry.uploadJobId, 'uploadJobId', where, fail) };
    }),
  };
}
