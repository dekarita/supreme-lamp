export declare const FULL_VERSION: number;
export declare const MAX_SESSION_BYTES: number;
export declare const RETENTION_MS: number;
export interface Diff { path: number[]; type: string; added?: string[]; removed?: string[]; attribute?: string }
export interface FullEntry { kind: string; at: number; [key: string]: unknown }
export interface FullSession {
  id: string; createdAt: number; updatedAt: number;
  target: { route: string; lang: string; ui: string };
  features: string[];
  timeline: FullEntry[];
}
export declare function sizeOf(value: unknown): number;
export declare function safeRoute(value: unknown): string;
export declare function mutationDiff(record: MutationRecord, root: Node): Diff | null;
export declare function validDiff(diff: Diff): boolean;
export declare function buildFullBundle(session: FullSession): {
  format: string; version: number; createdAt: string; target: FullSession['target'];
  timeline: FullEntry[]; storage: { policy: string; maxBytes: number; retentionMs: number }; features: string[];
};
export declare function appendBounded(session: FullSession, entry: FullEntry): { session: FullSession; accepted: boolean };
export declare function isExpired(session: FullSession, now: number): boolean;
