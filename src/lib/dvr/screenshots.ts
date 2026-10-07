// [F107 §3] screenshots.ts - the browser half of Full DVR's click screenshots.
//
// PIPELINE. One shot per recorded click: serialize the React root into an SVG
// foreignObject, rasterize it on an offscreen canvas at the devicePixelRatio-aware
// source size, then draw it DOWN into the 320x240 thumbnail box and keep the PNG
// data URL. Native canvas rasterization - no dependency, and the single-file build
// (vite-plugin-singlefile) stays dependency-free.
//
// HONEST-FAILURE CONTRACT. A shot is best-effort by construction: any failure
// (no canvas, image never loads, tainted surface) answers {ok:false, reason} - a
// click is never blocked by its own screenshot, and the reason is recorded, not
// hidden. jsdom lands on the honest-failure branch (no 2d context), which is why
// the DOM gate injects its rasterizer through the documented seam below - the
// seam is the ONLY injection point, and tests/f107-dvr-full.test.js pins that the
// default pipeline is the one shipped.
//
// PRIVACY FENCE. Shots are thumbnails (never full resolution), PNG-only, byte-
// capped by screenshotCore.validShot, and they only ever leave the machine inside
// an operator-clicked export (src/lib/dvr/export.ts).
import { SHOT_MIME_PREFIX, THUMB_H, THUMB_W, dataUrlBytes, fitThumb, validShot, type ThumbGeometry } from "./screenshotCore";
import { DVR_MUTATION_ROOT_ID } from "./mutations";

export interface ShotResult {
  ok: boolean;
  reason: string;
  dataUrl: string;
  w: number;
  h: number;
  bytes: number;
  dpr: number;
}

/** A rasterizer turns the live root + geometry into a PNG data URL, or null. */
type Rasterizer = (root: Element, geo: ThumbGeometry) => Promise<string | null> | string | null;

/** The DEFAULT rasterizer: SVG foreignObject -> Image -> canvas -> PNG data URL.
 *  Async because a real browser loads the SVG into an Image before drawing. */
const defaultRasterizer: Rasterizer = async (root, geo) => {
  try {
    if (typeof document === "undefined" || typeof XMLSerializer === "undefined") return null;
    // Serialize the live subtree. cloneNode keeps the serializer away from a
    // tree that React may be committing while it runs; it reads STRUCTURE only -
    // the content fence is that no F107 file names a content API.
    const doc = document.implementation.createHTMLDocument("");
    const holder = doc.createElement("div");
    holder.appendChild(root.cloneNode(true));
    const xml = new XMLSerializer().serializeToString(holder);
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="' +
      geo.sourceW +
      '" height="' +
      geo.sourceH +
      '"><foreignObject width="100%" height="100%">' +
      xml +
      "</foreignObject></svg>";
    const url = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) return null; // jsdom's honest branch: no 2d context
    canvas.width = geo.w;
    canvas.height = geo.h;
    const img = new Image();
    const loaded = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 2500);
      img.onload = () => {
        clearTimeout(timer);
        resolve(true);
      };
      img.onerror = () => {
        clearTimeout(timer);
        resolve(false);
      };
      img.src = url;
    });
    if (!loaded) return null;
    ctx.drawImage(img, 0, 0, geo.w, geo.h);
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  }
};

let rasterizer: Rasterizer = defaultRasterizer;

/** The DOCUMENTED test seam. Returns the previous rasterizer (restore it after).
 *  The gate pins that the default pipeline is the one shipped, so an injected
 *  fake can never masquerade as production behaviour. */
export function setShotRasterizer(fn: Rasterizer | null): Rasterizer {
  const prev = rasterizer;
  rasterizer = fn || defaultRasterizer;
  return prev;
}

/** True when the shipped (non-injected) pipeline is active. */
export function isDefaultRasterizerActive(): boolean {
  return rasterizer === defaultRasterizer;
}

function fail(reason: string, geo?: ThumbGeometry): ShotResult {
  return {
    ok: false,
    reason: reason,
    dataUrl: "",
    w: geo ? geo.w : 0,
    h: geo ? geo.h : 0,
    bytes: 0,
    dpr: geo ? geo.dpr : 1,
  };
}

/**
 * Capture one thumbnail for the current root. `viewW/viewH/dpr` are injected so
 * the gate can drive devicePixelRatio arithmetic deterministically (the browser
 * passes innerWidth/innerHeight/devicePixelRatio). Never throws.
 */
export async function captureShot(opts?: { viewW?: number; viewH?: number; dpr?: number; now?: number }): Promise<ShotResult> {
  const at = opts?.now ?? Date.now();
  try {
    const root =
      typeof document !== "undefined" ? document.getElementById(DVR_MUTATION_ROOT_ID) || document.body : null;
    if (!root) return fail("no-root");
    const dpr = opts?.dpr ?? (typeof window !== "undefined" && window.devicePixelRatio ? window.devicePixelRatio : 1);
    const geo = fitThumb(opts?.viewW ?? 1280, opts?.viewH ?? 800, dpr);
    const url = await Promise.resolve(rasterizer(root, geo));
    if (!url) return fail("rasterizer-returned-null", geo);
    if (!String(url).startsWith(SHOT_MIME_PREFIX)) return fail("not-a-png-data-url", geo);
    const v = validShot({ key: "", at: at, w: geo.w, h: geo.h, bytes: dataUrlBytes(url), dataUrl: url });
    if (!v.ok) return fail(v.reason, geo);
    return { ok: true, reason: "", dataUrl: url, w: geo.w, h: geo.h, bytes: v.bytes ?? 0, dpr: geo.dpr };
  } catch (err) {
    return fail("capture-error:" + String((err && (err as Error).name) || "unknown"));
  }
}

/** The thumbnail box, re-exported for panels. */
export const DVR_THUMB = { w: THUMB_W, h: THUMB_H };
// html2canvas is an actual DOM rasterizer (canvas.drawImage cannot draw arbitrary
// HTML). Only called after explicit full-DVR consent. No remote image loading.
export async function captureThumbnail(root: HTMLElement): Promise<string | null> {
  if (!root.isConnected) return null;
  const { default: html2canvas } = await import("html2canvas");
  const canvas = await html2canvas(root, {
    scale: Math.min(window.devicePixelRatio || 1, 2),
    useCORS: false, allowTaint: false, imageTimeout: 0, logging: false,
    ignoreElements: (el) => el.matches('input, textarea, select, [contenteditable], [data-dvr-private], [data-testid^="dvr-"], script, style') ||
      !!el.closest('[data-dvr-private]'),
    onclone: (doc) => {
      // html2canvas clones the document: mask sensitive descendants in the clone
      // even when a CSS background/label might otherwise draw them.
      doc.querySelectorAll('input, textarea, select, [contenteditable], [data-dvr-private]').forEach((el) => el.remove());
    },
  });
  const thumb = document.createElement("canvas");
  thumb.width = 320;
  thumb.height = 240;
  const ctx = thumb.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#111827";
  ctx.fillRect(0, 0, 320, 240);
  // Fit whole root in the thumbnail; never capture outside it.
  const ratio = Math.min(320 / canvas.width, 240 / canvas.height);
  ctx.drawImage(canvas, 0, 0, canvas.width * ratio, canvas.height * ratio);
  return thumb.toDataURL("image/png");
}
