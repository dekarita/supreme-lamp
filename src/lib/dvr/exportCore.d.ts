// [F107 §5] Types for the .mcrec v2 bundle core (src/lib/dvr/exportCore.js).

import type { DvrCoreEntry } from "../dvr-core";
import type { MutationDescriptor } from "./mutationCore";
import type { ShotRecord } from "./screenshotCore";
import type { DvrSessionMeta } from "./storageCore";

export declare const DVR_BUNDLE_V2_VERSION: number;
export declare const DVR_V2_ENVELOPE: string;

export interface BundleV2Target {
  route: string;
  buildSha: string;
  lang: string;
  ui: string;
}

export interface BundleV2Inputs {
  timeline?: Array<Partial<DvrCoreEntry>>;
  mutations?: MutationDescriptor[];
  shots?: ShotRecord[];
  sessions?: DvrSessionMeta[];
  features?: Array<{ id: string; route: string }>;
  target?: Partial<BundleV2Target>;
}

export interface DvrBundleV2 {
  format: string;
  version: number;
  createdAt: string;
  target: BundleV2Target;
  timeline: Array<Record<string, unknown>>;
  mutations: MutationDescriptor[];
  shots: ShotRecord[];
  storage: { sessions: DvrSessionMeta[]; bytes: number };
  features: Array<{ id: string; route: string }>;
}

export declare function buildBundleV2(inputs: BundleV2Inputs, opts?: { now?: number }): DvrBundleV2;
export declare function bundleV2Text(bundle: DvrBundleV2): string;
export declare function validateBundleV2(x: unknown): { ok: boolean; reason: string };
export declare function encodeEnvelopeV2(codec: string, base64: string): string;
export declare function decodeEnvelopeV2(text: string): { codec: string; base64: string; bytes: Uint8Array } | null;
export { toBase64, fromBase64 } from "../dvr-core";
