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
// PRIVACY FENCE (WP-13b / MC-P24 — corrected). Shots are thumbnails (never full
// resolution), PNG-only, byte-capped by screenshotCore.validShot, and they only
// ever leave the machine inside an operator-clicked export (src/lib/dvr/export.ts).
// The old fence claim — "cloneNode + XMLSerializer reads STRUCTURE only" — was
// WRONG: XMLSerializer serializes text nodes and attribute VALUES, so any
// secret visible as text or reflected into an attribute was rasterized into the
// PNG. The fence is now three explicit layers, all testable:
//   1. CONSENT: shots are OFF by default and enabled per session by the
//      operator (setShotsEnabled) — capture/export consent is explicit, and the
//      non-image diagnostics (timeline + mutation descriptors) keep working
//      with shots off.
//   2. EXCLUSIONS: prepareShotClone removes every [data-dvr-exclude] subtree and
//      every typed input value from the cloned DOM BEFORE serialization, so
//      credential/private surfaces never enter the capture path at all.
//   3. CAPTURE-SHAPE: thumbnails only, PNG-only, byte-capped (screenshotCore).
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

/**
 * [WP-13b] The capture-consent gate. Screenshots are OFF by default and are
 * enabled explicitly, per session, by the operator (the DvrFab panel toggle).
 * Session-scoped on purpose — the same convention as the DVR's pause/resume
 * switch — so no persistent "shots on" flag outlives the consent that made it.
 * The production caller (session.ts takeShot) checks this before capturing.
 */
let shotsOn = false;

/** Explicit, per-session opt-in to click screenshots. */
export function setShotsConsented(on: boolean): void {
  shotsOn = !!on;
}

/** True only while the operator has explicitly enabled screenshots this session. */
export function shotsConsented(): boolean {
  return shotsOn;
}

/** Attribute marking a subtree that must never enter a capture (credential and
 *  private surfaces hang it on their root). */
export const DVR_EXCLUDE_ATTR = "data-dvr-exclude";

/** Input types whose `value` is the control's visible label (kept in a shot);
 *  every other input type carries typed content and is stripped. */
const VALUE_VISIBLE_TYPES = new Set(["submit", "button", "reset", "image"]);

/**
 * [WP-13b] The exclusion half of the capture fence: clone the root, then remove
 * everything that must never be rasterized — every [data-dvr-exclude] subtree
 * (credential/private surfaces) and the typed content of every non-label input
 * (React 18 reflects a controlled input's value into the `value` attribute, so
 * cloneNode would otherwise carry a typed password into the serialized XML).
 * Exported so the gate can drive the SHIPPED exclusion pass on a synthetic DOM.
 * Never throws.
 */
export function prepareShotClone(root: Element): Element {
  const clone = root.cloneNode(true) as Element;
  try {
    for (const el of Array.from(clone.querySelectorAll("[" + DVR_EXCLUDE_ATTR + "]"))) {
      el.remove();
    }
  } catch {
    /* exclusion is best-effort per subtree */
  }
  try {
    for (const el of Array.from(clone.querySelectorAll("input,textarea"))) {
      const tag = el.tagName;
      if (tag === "TEXTAREA") {
        el.textContent = "";
        continue;
      }
      const type = String((el as HTMLInputElement).getAttribute("type") || "text").toLowerCase();
      if (!VALUE_VISIBLE_TYPES.has(type)) el.removeAttribute("value");
    }
  } catch {
    /* typed-content stripping is best-effort per element */
  }
  return clone;
}

/** A rasterizer turns the live root + geometry into a PNG data URL, or null. */
type Rasterizer = (root: Element, geo: ThumbGeometry) => Promise<string | null> | string | null;

/** The DEFAULT rasterizer: SVG foreignObject -> Image -> canvas -> PNG data URL.
 *  Async because a real browser loads the SVG into an Image before drawing. */
const defaultRasterizer: Rasterizer = async (root, geo) => {
  try {
    if (typeof document === "undefined" || typeof XMLSerializer === "undefined") return null;
    // Serialize the live subtree. cloneNode keeps the serializer away from a
    // tree that React may be committing while it runs. XMLSerializer emits text
    // nodes and attribute VALUES, so the content fence is prepareShotClone's
    // exclusion pass (credential subtrees + typed input values removed BEFORE
    // serialization) — never the choice of a serialization API (MC-P24).
    const doc = document.implementation.createHTMLDocument("");
    const holder = doc.createElement("div");
    holder.appendChild(prepareShotClone(root));
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
