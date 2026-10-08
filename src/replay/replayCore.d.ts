// [F108 §2] Types for the public replay viewer core (src/replay/replayCore.js).
//
// Hand-written, like the other `*Core.d.ts` files in this repo, because the
// implementation is plain JS so the Node gate in `node --test tests/*.test.js`
// can execute the SHIPPED reader (docs/replay/vendor/replay/replayCore.js is a
// byte-identical copy of this file, pinned by tests/f108-replay-core.test.js).

import type { DvrBundle, DvrCounts, DvrCoreEntry } from "../lib/dvr-core";
import type { DvrBundleV2 } from "../lib/dvr/exportCore";
import type { ShotRecord } from "../lib/dvr/screenshotCore";

export declare const REPLAY_MAX_CHARS: number;
export declare const MAX_RENDERED_ROWS: number;
export declare const SHOT_ATTACH_MS: number;
export declare const SAFE_TEXT_MAX: number;
export declare const SUMMARY_MAX_CHARS: number;
export declare const REPLAY_INPUT_KINDS: string[];

export type ReplayInputKind = "empty" | "too-large" | "v1-envelope" | "v2-envelope" | "json-text" | "unrecognised";

export interface ClassifyResult {
  ok: boolean;
  kind: ReplayInputKind;
  reason: string;
  codec?: "gzip" | "plain";
  bytes?: Uint8Array;
  jsonText: string | null;
}

export interface ParseResult {
  ok: boolean;
  version: number;
  reason: string;
  bundle: DvrBundle | DvrBundleV2 | null;
}

export interface Verdict {
  ok: boolean;
  version: number;
  kind?: "lite" | "full";
  reason: string;
  warnings: string[];
  counts: {
    timeline: number;
    mutations: number;
    shots: number;
    sessions: number;
    features: number;
    refusedShots: number;
    bytes: number;
  };
  stats: DvrCounts | null;
}

export interface TimelineRow {
  index: number;
  seq: number;
  at: number;
  kind: string;
  route: string;
  detail: string;
}

export interface MutationGroup {
  type: string;
  target: string;
  attr: string;
  added: number;
  removed: number;
  folded: number;
  at: number;
  count: number;
}

export interface SessionRow {
  id: string;
  startedAt: number;
  endedAt: number;
  clicks: number;
  mutations: number;
  shots: number;
  bytes: number;
}

export declare function safeText(value: unknown, max?: number): string;
export declare function safeImageSrc(shot: unknown): string;
export declare function routeOf(value: unknown): string;
export declare function decodeUtf8(bytes: Uint8Array): string;
export declare function classifyInput(text: string): ClassifyResult;
export declare function parseBundle(jsonText: string): ParseResult;
export declare function verdict(bundle: unknown): Verdict;
export declare function timelineRows(
  bundle: unknown,
  opts?: { maxRows?: number }
): { rows: TimelineRow[]; truncated: number };
export declare function attachShot(bundle: unknown, at: number): ShotRecord | null;
export declare function mutationLines(
  bundle: unknown,
  opts?: { maxRows?: number }
): { rows: MutationGroup[]; truncated: number; total: number };
export declare function sessionRows(bundle: unknown): SessionRow[];
export declare function featureRows(bundle: unknown): Array<{ id: string; route: string }>;
export declare function formatDuration(ms: number): string;
export declare function formatStamp(ms: number): string;
export declare function formatBytes(n: number): string;
export declare function summarize(bundle: unknown): string;
export declare function v2EnvelopeTag(): string;

export type { DvrBundle, DvrBundleV2, DvrCoreEntry, DvrCounts, ShotRecord };
