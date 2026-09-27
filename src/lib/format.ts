// [F41] Formatting helpers - 1:1 ports of the F38 ui.html helpers so every
// rendered value stays byte-identical with v1 (parseTsUtc keeps the F17 §2
// UTC/RoundtripKind contract; fmtBytes/fmtSpeed/fmtDurShort unchanged).

export function parseTs(s: unknown): number {
  if (!s) return NaN;
  const t = String(s).trim();
  if (/Z$|[+-]\d{2}:\d{2}$/.test(t)) return Date.parse(t);
  const m = t.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})[ T](\d{1,2}):(\d{2}):(\d{2})/);
  if (m) return Date.UTC(+m[3], +m[1] - 1, +m[2], +m[4], +m[5], +m[6]);
  const withZ = Date.parse(t + "Z");
  return isNaN(withZ) ? Date.parse(t) : withZ;
}

// [F17 §2] beacon-age UTC fix: the server writes every ts with DateTime.UtcNow
// 'o', so a ts WITHOUT an explicit offset is UTC - never this PC's local time.
export function parseTsUtc(s: unknown): number {
  if (!s) return NaN;
  const t = String(s).trim();
  const v = Date.parse(t);
  if (!isNaN(v) && (/[Zz]$/.test(t) || /[+-]\d{2}:?\d{2}$/.test(t))) return v;
  const u = Date.parse(t + "Z");
  return isNaN(u) ? (isNaN(v) ? NaN : v) : u;
}

export function fmtBytes(input: unknown): string {
  let n: number = Number(input) || 0;
  if (n < 1024) return n.toFixed(0) + " B";
  const u = ["KB", "MB", "GB", "TB", "PB"];
  let i = -1;
  do {
    n = n / 1024;
    i++;
  } while ((n as number) >= 1024 && i < u.length - 1);
  return (n as number).toFixed((n as number) >= 100 ? 0 : (n as number) >= 10 ? 1 : 2) + " " + u[i];
}

export function fmtSpeed(n: unknown): string {
  return fmtBytes(n) + "/s";
}

export function fmtDurShort(s: unknown): string {
  s = Math.max(0, Math.floor(Number(s) || 0));
  if ((s as number) < 60) return s + "s";
  const totalMin = Math.floor((s as number) / 60);
  const ss = (s as number) % 60;
  if (totalMin < 60) return totalMin + "m " + ss + "s";
  let h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h < 24) return h + "h " + m + "m";
  const d = Math.floor(h / 24);
  h = h % 24;
  return d + "d " + h + "h";
}

export function pad2(n: number | string): string {
  const s = String(n);
  return s.length < 2 ? "0" + s : s;
}

export function fmtHMS(sec: unknown): string {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return pad2(h) + ":" + pad2(m) + ":" + pad2(ss);
}

export function esc(s: unknown): string {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c] as string));
}

// Wired constants (F15/F34 ground truth in STATE.md).
export const HARD_CAP_MS = 21420000; // 5h55 GitHub hard cap
export const SESSION_WINDOW_MS = 19800000; // 5h30 session window

export const FQDN_RE = /^[a-z0-9][a-z0-9\-]*(\.[a-z0-9\-]+)+\.ts\.net$/i;
export const CGNAT_RE = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.(\d{1,3})\.(\d{1,3})$/;
export const USER_RE = /^[A-Za-z0-9_\-\.\\]{1,104}$/;
