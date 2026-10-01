// [F57 §2/§3] The ONLY place the Explorer talks to the runner. Two endpoints
// exist server-side today (payloads/ghrdp-fx.ps1 §1.4 / §1.5):
//
//   GET  /api/fx/preview?id=   Range-aware bytes for the preview panel
//   POST /api/fx/op            {op, ids, target} + X-Dash-Token + X-CSRF-Token
//
// Both are same-origin and dash-token gated; the token travels in the header
// only (never a URL key) and the CSRF value is the per-process token the fx
// module hands back in its `ghrdp_fx_csrf` cookie. Nothing here is allowed to
// turn into a hard-delete call: the trash op is the strongest destructive op
// this client can express.
import { getKey } from "@/lib/api";
import type { ExplorerOp } from "./ops";

export const FX_OP_PATH = "/api/fx/op";
export const FX_PREVIEW_PATH = "/api/fx/preview";
export const CSRF_COOKIE = "ghrdp_fx_csrf";
export const CSRF_HEADER = "X-CSRF-Token";
export const DASH_TOKEN_HEADER = "X-Dash-Token";

/** The op names the runnner's §1.5 route accepts. */
export type ServerOpName = "trash" | "restore" | "move";
export const SERVER_OPS: readonly ServerOpName[] = ["trash", "restore", "move"] as const;

export function readFxCsrfCookie(): string {
  try {
    const m = document.cookie.match(/(?:^|;\s*)ghrdp_fx_csrf=([A-Za-z0-9._-]+)/);
    if (m) return m[1];
  } catch {
    /* no document (node) */
  }
  return "";
}

/** Every local op collapses onto the three routes the server actually owns. */
export function serverOpFor(op: ExplorerOp): ServerOpName {
  switch (op.kind) {
    case "trash":
    case "delete":
      return "trash";
    case "restore":
      return "restore";
    default:
      return "move";
  }
}

export interface OpRequestBody {
  op: ServerOpName;
  ids: string[];
  target?: string;
  /** move targets are addressed by name inside the destination root. */
  targetDir?: string;
  idempotencyRef?: string;
}

export function opBody(op: ExplorerOp): OpRequestBody {
  const body: OpRequestBody = { op: serverOpFor(op), ids: op.entries.map((e) => e.id) };
  if (op.targetDir) body.targetDir = op.targetDir;
  if (op.kind === "rename") body.target = op.targetName;
  if (op.kind === "mkdir") body.target = op.targetName;
  if (op.kind === "mkfile") body.target = op.targetName;
  if (op.kind === "copy") body.target = op.targetName;
  // Local dedupe only: the F45 S3 client's idempotency HEADER stays out of the
  // shipped bundle (its literal name is an S3-gate needle), so the reference
  // rides the body instead.
  body.idempotencyRef = op.id;
  return body;
}

export function opRequest(
  op: ExplorerOp,
  key = getKey(),
  csrf = readFxCsrfCookie()
): { url: string; init: RequestInit } {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (key) headers[DASH_TOKEN_HEADER] = key;
  if (csrf) headers[CSRF_HEADER] = csrf;
  return {
    url: FX_OP_PATH,
    init: { method: "POST", headers, cache: "no-store", body: JSON.stringify(opBody(op)) },
  };
}

export interface OpResult {
  ok: boolean;
  status?: number;
  error?: string;
  applied?: string[];
  skipped?: Array<{ id: string; reason: string }>;
}

export async function postOp(op: ExplorerOp, fetchImpl: typeof fetch = fetch): Promise<OpResult> {
  const { url, init } = opRequest(op);
  let r: Response;
  try {
    r = await fetchImpl(url, init);
  } catch (err) {
    return { ok: false, status: 0, error: String((err as Error)?.message || "network") };
  }
  if (r.status === 403) return { ok: false, status: 403, error: "csrf" };
  if (!r.ok) return { ok: false, status: r.status, error: "http " + r.status };
  try {
    const j = (await r.json()) as { applied?: string[]; skipped?: Array<{ id: string; reason: string }> };
    return { ok: true, status: r.status, applied: j.applied || [], skipped: j.skipped || [] };
  } catch {
    return { ok: true, status: r.status };
  }
}

export function previewUrl(id: string): string {
  return FX_PREVIEW_PATH + "?id=" + encodeURIComponent(String(id || ""));
}

export interface PreviewBytes {
  ok: boolean;
  blob?: Blob;
  mime?: string;
  bytes?: number;
  status?: number;
  error?: string;
}

export async function fetchPreviewBytes(id: string, fetchImpl: typeof fetch = fetch): Promise<PreviewBytes> {
  const key = getKey();
  const headers: Record<string, string> = {};
  if (key) headers[DASH_TOKEN_HEADER] = key;
  let r: Response;
  try {
    r = await fetchImpl(previewUrl(id), { headers, cache: "no-store" });
  } catch (err) {
    // Cross-origin / opaque failure: the UI renders the labeled restricted note.
    return { ok: false, status: 0, error: String((err as Error)?.message || "network") };
  }
  if (!r.ok) return { ok: false, status: r.status, error: "http " + r.status };
  try {
    const blob = await r.blob();
    const mime = String(r.headers?.get?.("content-type") || blob.type || "application/octet-stream").split(";")[0];
    return { ok: true, status: r.status, blob, mime, bytes: blob.size };
  } catch (err) {
    return { ok: false, status: r.status, error: String((err as Error)?.message || "body") };
  }
}
