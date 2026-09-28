/** Explorer §4: wire data only; never put host credentials in this schema. */
export const INDEX_SCHEMA_VERSION = 2 as const;
export type IndexRoot = 'Downloads' | 'Desktop' | 'Documents' | 'Temp' | 'RDP-Storage';
export type UploadPhase = 'dns' | 'tcp' | 'tls' | 'encrypt' | 'size' | 'type' | 'auth' | 'http' | 'parse';
export type UploadStatus = 'idle' | 'queued' | 'uploading' | 'success' | 'failed' | 'canceled';
export type GofileStatus = 'none' | 'uploaded' | 'processing' | 'expired' | 'failed';
export interface UploadLastError {
  phase: UploadPhase;
  httpStatus?: number;
  /** F44: preserve the complete host message, not a summary or ellipsis. */
  hostMessage?: string;
  at?: string;
}
export interface UploadState {
  phase: UploadPhase | null;
  status: UploadStatus;
  retries: number;
  lastError: UploadLastError | null;
  bytesSent: number;
}
export interface GofileState {
  code: string | null;
  fileId: string | null;
  /** Only populated for uploaded; no credential-bearing URLs. */
  directUrl: string | null;
  status: GofileStatus;
  uploadedAt: string | null;
  expiryTs: string | null;
  downloads: number;
  remoteSize: number | null;
}
export interface FileEntry {
  id: string;
  root: IndexRoot;
  /** POSIX-style path within root, always leading slash. */
  path: string;
  size: number;
  mtime: string;
  mime: string;
  checksum: string | null;
  tags: string[];
  pinned: boolean;
  trashed: boolean;
  trashedAt: string | null;
  recentsTs: string | null;
  upload: UploadState;
  gofile: GofileState;
}
export interface RootSnapshot {
  root: IndexRoot;
  scannedAt: string;
  totalBytes: number;
  fileCount: number;
  quotaBytes: number | null;
}
export interface GofileHostConfig {
  id: 'gofile';
  displayName: string;
  maxFileBytes: number | null;
  allowedMimePrefixes: string[] | null;
  ttlSeconds: number | null;
  notes: string;
}
export interface IndexJson {
  schemaVersion: 2;
  generatedAt: string;
  /** Opaque runner identity, never an IP or token. */
  runnerId: string;
  roots: RootSnapshot[];
  files: FileEntry[];
  gofileHosts: GofileHostConfig[];
}
