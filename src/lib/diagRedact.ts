// [WP-13 / #193 + WP-13b / MC-P24] diagRedact.ts — the SHARED redaction core for
// every diagnostic record Mission Control persists or exports.
//
// WHY THIS FILE EXISTS. WP-13 verified four independent leak paths into persisted
// collector rows (MC-P8: a controlled input's `value` attribute read as the click
// label; MC-P11: the raw `location.hash` incl. `?key=` stored as `params.route`;
// MC-P12: raw request URLs incl. `?key=` plus 2000-char bodies incl. the
// /api/config creds block; MC-P13: a secret-derived `sha=` fingerprint in masked
// headers and the raw-rows `button-actions.json` export). WP-04 (event contract)
// and WP-10 (sanitized evidence export) must reuse THIS module, never grow a
// second scrubber — one implementation, one contract, one place to falsify.
//
// CONTRACT.
//   - PURE: no DOM, no I/O, no imports. vitest executes the shipped functions
//     directly; the static gates pin the call sites.
//   - IDEMPOTENT: redacting an already-redacted value is a byte-identical no-op,
//     so the hydration pass can run on every load and every cross-tab rehydrate
//     without drift. src/tests/smoke/wp13-privacy-redaction.test.tsx pins this.
//   - NEVER THROWS: malformed input degrades to a safe output, never an
//     exception — a redaction pass must not break hydration, capture or export.
//   - LOSSY BY DESIGN: redaction is not reversible. A reverted build keeps the
//     redacted rows; an unsafe value is never preserved to keep a row
//     byte-identical, and no unredacted backup is ever written.
//
// WHAT SURVIVES (the allow-list philosophy): routes become route templates,
// request URLs become path-only, secret-named headers keep only their length,
// JSON bodies keep every non-secret field, and free text keeps everything
// except credential-shaped assignments, bearer tokens and secret fingerprints.

/** The replacement marker for a removed secret. Deliberately carries no digit
 *  and is shorter than the assignment redactor's value floor, which is what
 *  makes every transform below idempotent. */
export const REDACTED = "[redacted]";

/** Route templates are cut, never longer than this (a hash is never this long
 *  honestly — the cap is a fence, not a budget). */
export const ROUTE_MAX_CHARS = 256;
/** Path-only request URLs are capped at this. */
export const URL_MAX_CHARS = 512;
/** Free-text row strings are scrubbed and capped at this. */
export const TEXT_MAX_CHARS = 400;

/**
 * Route template. `#/collector?key=SECRET` -> `#/collector`. The cut happens at
 * the first `?` AND at the first `#` that is not at index 0, because this app is
 * a HashRouter: the route itself starts with `#` (`#/files`), so a naive split on
 * `#` would erase the one thing worth recording. Same contract as
 * sanitizeBoundaryRoute (F105) — the two are pinned to agree on canonical inputs.
 */
export function sanitizeRoute(raw: unknown): string {
  try {
    const s = String(raw ?? "");
    const cuts = [s.indexOf("?"), s.indexOf("#", 1)].filter((i) => i >= 0);
    const cut = cuts.length ? Math.min(...cuts) : -1;
    const out = (cut >= 0 ? s.slice(0, cut) : s).slice(0, ROUTE_MAX_CHARS);
    return out || "/";
  } catch {
    return "/";
  }
}

/**
 * Path-only request URL: origin, query and fragment never reach a diagnostic
 * record (the `?key=` class is exactly why — F94's leak). A value that will not
 * parse as a URL is cut at the first `?`/`#` and capped, never kept whole.
 */
export function sanitizeRequestUrl(raw: unknown): string {
  try {
    const s = String(raw ?? "");
    if (!s) return "";
    const base = typeof location !== "undefined" ? location.href : "http://localhost/";
    const u = new URL(s, base);
    return (u.pathname || "/").slice(0, URL_MAX_CHARS);
  } catch {
    const cut = String(raw ?? "").split(/[?#]/, 1)[0] || "";
    return cut.slice(0, URL_MAX_CHARS);
  }
}

/**
 * Exchange URL (the F104 observer's fetch/open records): origin + path are kept
 * (which server answered is diagnostic), the query and fragment are cut at the
 * first `?`/`#` and the result is capped — the same contract as F104's stripUrl,
 * restated here so the hydration pass can re-apply it to old rows.
 */
export function sanitizeExchangeUrl(raw: unknown): string {
  const cut = String(raw ?? "").split(/[?#]/, 1)[0] || "";
  return cut.length > 200 ? cut.slice(0, 200) + "…" : cut;
}

/** Header names whose values are credentials (the F101 set, kept verbatim). */
export const SECRET_HEADER = /token|authorization|cookie|key|secret|password/i;

/** Already-masked shapes the redactor must recognise and keep stable:
 *  the current `present(len=N)` and the legacy `present(len=N,sha=<hex>)` (the
 *  fingerprint is dropped, the length is kept) plus the F101 `masked` literal. */
const MASKED_NOW = /^present\(len=\d+\)$/;
const MASKED_LEGACY = /^present\(len=(\d+)(?:,sha=[0-9a-f]+)?\)$/;

/**
 * Mask secret-named header values. The value is reduced to its LENGTH — never
 * the value itself, and never a fingerprint of it: the old `sha=<FNV-1a>`
 * fingerprint was secret-derived (an offline guess-check oracle against a weak
 * hash) and is removed (MC-P13). Idempotent: an already-masked value is kept.
 */
export function maskSecretHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(h || {})) {
    const v = String(h[k] ?? "");
    if (!SECRET_HEADER.test(k) || !v) {
      out[k] = v;
      continue;
    }
    if (MASKED_NOW.test(v) || v === "masked") {
      out[k] = v;
      continue;
    }
    const legacy = v.match(MASKED_LEGACY);
    out[k] = legacy ? "present(len=" + legacy[1] + ")" : "present(len=" + v.length + ")";
  }
  return out;
}

/** JSON field names whose values are credentials. Suffix match on the KEY, with
 *  a `public` exemption (envelopePublicKey is published by design). Covers the
 *  server's own Remove-CredKeys denylist (rdpPass, vncPass, mirrorKey,
 *  legacyDecryptKey, rentryEditCode, rentryEditCookie, dashToken) plus the
 *  client-side shapes (windowsPass, X-Dash-Token payloads, apiKey, ...). */
const SECRET_FIELD = /(pass(word|wd|phrase)?|token|secret|cookie|key|authorization|credential|edit[-_]?code)s?$/i;

function isSecretField(key: string): boolean {
  if (/public/i.test(key)) return false;
  return SECRET_FIELD.test(key);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Recursively redact secret-named fields of a parsed JSON value. A secret-named
 * field with a scalar or array value becomes `[redacted]`; a secret-named field
 * with a plain-object value is recursed into (the server's `creds` object keeps
 * its non-secret fqdn/user/ip while windowsPass/vncPass are redacted). Never
 * throws; depth-capped so a pathological payload cannot recurse forever.
 */
export function redactJsonSecrets<T>(value: T, depth = 0): T {
  if (depth > 16) return REDACTED as unknown as T;
  if (Array.isArray(value)) {
    return value.map((v) => redactJsonSecrets(v, depth + 1)) as unknown as T;
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (isSecretField(k) && v !== null && !isPlainObject(v)) {
        out[k] = REDACTED;
      } else {
        out[k] = redactJsonSecrets(v, depth + 1);
      }
    }
    return out as unknown as T;
  }
  return value;
}

/** `Authorization: Bearer <token>` (and `bearer`) in free text. */
const BEARER_TOKEN = /\b(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi;
/** The retired secret-derived fingerprint: `present(len=64,sha=1a2b3c4d)`. */
const SECRET_FINGERPRINT = /,?\s*sha=[0-9a-f]{6,16}\b/gi;
/**
 * Credential-shaped assignment in free text: `key=…`, `"password":"…"`,
 * `X-Dash-Token: …`. The value must look secret-ish (carries a digit, or is at
 * least 16 chars) so legitimate prose like "no dash token in this tab (?key=
 * missing)" or "?key=<dash token>" is NOT mangled. `<…>` placeholders never
 * match (the value class excludes angle brackets).
 */
const SECRET_ASSIGNMENT =
  /((?:^|[\s"'{,&;?&#])(?:key|token|password|passwd|pass|secret|authorization|cookie|api[-_]?key|mirror[-_]?key|dash[-_]?token|windows[-_]?pass|vnc[-_]?pass|rdp[-_]?pass)\s*[:=]\s*["']?)([^\s"'&,;<>]{4,})/gi;

/**
 * Scrub one free-text string: credential assignments, bearer tokens and secret
 * fingerprints are redacted; everything else is kept verbatim and length-capped.
 * Idempotent (`[redacted]` carries no digit and is below the value floor).
 */
export function scrubSecretText(raw: unknown, maxChars: number = TEXT_MAX_CHARS): string {
  let s = String(raw ?? "");
  s = s.replace(SECRET_FINGERPRINT, "");
  s = s.replace(BEARER_TOKEN, "$1" + REDACTED);
  s = s.replace(SECRET_ASSIGNMENT, (whole, prefix: string, value: string) =>
    /[0-9]/.test(value) || value.length >= 16 ? prefix + REDACTED : whole
  );
  return s.length > maxChars ? s.slice(0, maxChars) + "…" : s;
}

/**
 * Scrub a captured request/response BODY. JSON bodies are redacted field-wise
 * (the allow-list: every non-secret field survives, secret fields are replaced);
 * non-JSON bodies get the free-text pattern pass. Capped at maxChars either way.
 * Idempotent.
 */
export function scrubBodyText(raw: unknown, maxChars = 2000): string {
  const s = String(raw ?? "");
  if (!s) return "";
  const trimmed = s.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const redacted = redactJsonSecrets(JSON.parse(trimmed));
      const out = JSON.stringify(redacted);
      if (out) return scrubSecretText(out, maxChars);
    } catch {
      /* not JSON after all: fall through to the pattern scrub */
    }
  }
  return scrubSecretText(s, maxChars);
}

/** Headers object: secret-named values masked (no fingerprint), the rest scrubbed. */
function scrubHeaders(h: Record<string, unknown>): Record<string, unknown> {
  const masked = maskSecretHeaders(h as Record<string, string>);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(masked)) {
    out[k] = typeof v === "string" ? scrubSecretText(v, 300) : v;
  }
  return out;
}

/**
 * One credential-input testid set. Rows captured from these controls before the
 * WP-13 fix carry the typed value as their label; the hydration pass blanks those
 * labels (the value itself is unrecoverable — that is the point).
 */
export const CREDENTIAL_INPUT_TESTIDS = ["dash-token-input", "cred-password"];

function scrubValueByKey(key: string, parentKey: string | null, value: unknown): unknown {
  if (typeof value !== "string") return value;
  switch (key) {
    case "route":
    case "hostRoute":
    case "to":
      return sanitizeRoute(value);
    case "url":
      // the deep RequestRecord stores path-only; observer/exchange urls keep
      // origin+path (F104 compatibility). Both drop query and fragment.
      return parentKey === "request" ? sanitizeRequestUrl(value) : sanitizeExchangeUrl(value);
    case "body":
      return scrubBodyText(value);
    case "label":
      return scrubSecretText(value, 120);
    default:
      return scrubSecretText(value);
  }
}

/** Recursive key-aware scrub of one row subtree. Never throws; depth-capped.
 *  Non-plain objects (class instances — a Response, a Blob, a custom class) are
 *  replaced wholesale: JSON persistence would serialize their enumerable
 *  fields anyway, so an instance is not a safe container for a row. */
function scrubDeep(value: unknown, key: string | null, parentKey: string | null, depth: number): unknown {
  if (depth > 16) return REDACTED;
  if (typeof value === "string") return scrubValueByKey(key ?? "", parentKey, value);
  if (Array.isArray(value)) {
    return value.map((v) => scrubDeep(v, null, key, depth + 1));
  }
  if (isPlainObject(value)) {
    if (key === "headers") return scrubHeaders(value);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = scrubDeep(v, k, key, depth + 1);
    }
    return out;
  }
  if (value === null || value === undefined) return value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  return REDACTED;
}

/**
 * [WP-13] Redact one persisted ButtonAction row in place-shape (a new row is
 * returned; the input is never mutated). Covers: params.route/hostRoute/label/
 * text, the deep request (path-only url, masked headers, scrubbed body), the
 * response (masked headers, scrubbed body), result (routes, exchange urls,
 * nested verdict strings), verdict/error strings, and every other string in the
 * row through the generic pattern pass. Rows captured from credential inputs
 * (CREDENTIAL_INPUT_TESTIDS) get their label blanked — a pre-fix row's label may
 * BE the typed password. Idempotent; never throws (a malformed row comes back
 * unchanged rather than breaking hydration).
 */
export function redactButtonAction<T>(row: T): T {
  try {
    const out: Record<string, unknown> = { ...(row as Record<string, unknown>) };
    const params = out.params;
    if (isPlainObject(params)) {
      const p = { ...params };
      if (typeof p.label === "string" && CREDENTIAL_INPUT_TESTIDS.includes(String(p.testId))) {
        p.label = REDACTED;
      }
      out.params = p;
    }
    return scrubDeep(out, null, null, 0) as T;
  } catch {
    return row;
  }
}
