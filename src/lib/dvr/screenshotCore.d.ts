// [F107 §3] Types for the screenshot geometry core (src/lib/dvr/screenshotCore.js).

export declare const THUMB_W: number;
export declare const THUMB_H: number;
export declare const SHOT_MAX_BYTES: number;
export declare const SHOT_SESSION_CAP: number;
export declare const SHOT_MIME_PREFIX: string;

export interface ThumbGeometry {
  sourceW: number;
  sourceH: number;
  w: number;
  h: number;
  scale: number;
  dpr: number;
}

export interface ShotRecord {
  key: string;
  at: number;
  w: number;
  h: number;
  bytes: number;
  dataUrl?: string;
  [field: string]: unknown;
}

export interface ShotValidation {
  ok: boolean;
  reason: string;
  bytes?: number;
}

export declare function fitThumb(viewW: number, viewH: number, dpr: number): ThumbGeometry;
export declare function dataUrlBytes(dataUrl: string): number;
export declare function validShot(shot: unknown): ShotValidation;
export declare function appendShots(buffer: ShotRecord[], shots: ShotRecord[], opts?: { sessionCap?: number }): ShotRecord[];
