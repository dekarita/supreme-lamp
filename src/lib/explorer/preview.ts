// [F57 §3] Preview panel full wire. One renderer registry maps MIME/extension
// to the renderer the plan §7 names: image / video / audio / pdf / markdown /
// code, plus the stylized "unsupported" card with size + Download.
//
// The markdown and code renderers are dependency-free in-repo equivalents of
// the marked.js / CodeMirror chunk in the plan: this phase adds NO runtime
// dependency (the single-file bundle and the frozen pnpm lockfile stay
// untouched), and both renderers escape first, so preview content can never
// inject markup into the dashboard origin.
import { fetchPreviewBytes, type PreviewBytes } from "./transport";

export type PreviewRenderer = "image" | "video" | "audio" | "pdf" | "markdown" | "code" | "unsupported";

export const PREVIEW_RENDERERS: readonly PreviewRenderer[] = [
  "image",
  "video",
  "audio",
  "pdf",
  "markdown",
  "code",
  "unsupported",
];

/** Plan §7 renderer table, exact mime first, then prefix, then extension. */
export const MIME_TO_RENDERER: Record<string, PreviewRenderer> = {
  "image/png": "image",
  "image/jpeg": "image",
  "image/jpg": "image",
  "image/gif": "image",
  "image/webp": "image",
  "image/avif": "image",
  "video/mp4": "video",
  "video/webm": "video",
  "video/quicktime": "video",
  "audio/mpeg": "audio",
  "audio/mp3": "audio",
  "audio/wav": "audio",
  "audio/ogg": "audio",
  "audio/flac": "audio",
  "application/pdf": "pdf",
  "text/markdown": "markdown",
  "text/x-markdown": "markdown",
};

export const EXT_TO_RENDERER: Record<string, PreviewRenderer> = {
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  svg: "image",
  mp4: "video",
  webm: "video",
  mov: "video",
  mp3: "audio",
  wav: "audio",
  ogg: "audio",
  flac: "audio",
  pdf: "pdf",
  md: "markdown",
  markdown: "markdown",
  txt: "code",
  json: "code",
  js: "code",
  mjs: "code",
  cjs: "code",
  ts: "code",
  tsx: "code",
  jsx: "code",
  py: "code",
  ps1: "code",
  css: "code",
  html: "code",
  xml: "code",
  yml: "code",
  yaml: "code",
  sh: "code",
  cs: "code",
};

export function extensionOf(name: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(name || ""));
  return m ? m[1].toLowerCase() : "";
}

export function rendererFor(input: { name?: string; mime?: string }): PreviewRenderer {
  const mime = String(input.mime || "").toLowerCase();
  if (mime && MIME_TO_RENDERER[mime]) return MIME_TO_RENDERER[mime];
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("text/")) return mime.includes("markdown") ? "markdown" : "code";
  const ext = extensionOf(input.name || "");
  if (ext && EXT_TO_RENDERER[ext]) return EXT_TO_RENDERER[ext];
  return "unsupported";
}

export function isPreviewable(input: { name?: string; mime?: string }): boolean {
  return rendererFor(input) !== "unsupported";
}

export function codeLanguageFor(name: string): string {
  const ext = extensionOf(name);
  const map: Record<string, string> = {
    js: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    ts: "typescript",
    tsx: "typescript",
    jsx: "javascript",
    py: "python",
    ps1: "powershell",
    sh: "shell",
    cs: "csharp",
    yml: "yaml",
    yaml: "yaml",
    json: "json",
    html: "html",
    xml: "xml",
    css: "css",
    md: "markdown",
    txt: "text",
  };
  return map[ext] || "text";
}

export function escapeHtml(src: string): string {
  return String(src ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeHref(url: string): string {
  const u = String(url || "").trim();
  return /^(https?:|mailto:|\/|#)/i.test(u) ? u : "#";
}

/** marked.js-compatible subset: headings, fences, lists, quotes, hr, inline. */
export function renderMarkdown(src: string): string {
  const lines = String(src ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let inFence = false;
  let fenceLang = "";
  let fence: string[] = [];
  let listOpen = false;
  const closeList = () => {
    if (listOpen) {
      out.push("</ul>");
      listOpen = false;
    }
  };
  const inline = (s: string): string =>
    escapeHtml(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, text: string, href: string) => '<a href="' + escapeHtml(safeHref(href)) + '">' + text + "</a>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>")
      .replace(/__(.+?)__/g, "<strong>$1</strong>");

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    const fenceMatch = /^```\s*([A-Za-z0-9+-]*)\s*$/.exec(line);
    if (fenceMatch) {
      if (inFence) {
        out.push('<pre class="md-code" data-lang="' + escapeHtml(fenceLang || "text") + '"><code>' + escapeHtml(fence.join("\n")) + "</code></pre>");
        fence = [];
        fenceLang = "";
        inFence = false;
      } else {
        closeList();
        inFence = true;
        fenceLang = fenceMatch[1] || "";
      }
      continue;
    }
    if (inFence) {
      fence.push(line);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      closeList();
      const level = heading[1].length;
      out.push("<h" + level + ">" + inline(heading[2]) + "</h" + level + ">");
      continue;
    }
    if (/^\s*(---|\*\*\*)\s*$/.test(line)) {
      closeList();
      out.push("<hr/>");
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      closeList();
      out.push("<blockquote>" + inline(quote[1]) + "</blockquote>");
      continue;
    }
    const item = /^\s*[-*]\s+(.*)$/.exec(line);
    if (item) {
      if (!listOpen) {
        out.push("<ul>");
        listOpen = true;
      }
      out.push("<li>" + inline(item[1]) + "</li>");
      continue;
    }
    if (!line.trim()) {
      closeList();
      continue;
    }
    closeList();
    out.push("<p>" + inline(line) + "</p>");
  }
  if (inFence) out.push('<pre class="md-code"><code>' + escapeHtml(fence.join("\n")) + "</code></pre>");
  closeList();
  return out.join("");
}

const KEYWORDS: Record<string, string[]> = {
  javascript: ["const", "let", "var", "function", "return", "if", "else", "for", "while", "import", "export", "from", "class", "new", "await", "async", "try", "catch", "throw", "typeof", "null", "true", "false"],
  typescript: ["const", "let", "var", "function", "return", "if", "else", "for", "while", "import", "export", "from", "class", "new", "await", "async", "try", "catch", "throw", "interface", "type", "enum", "implements", "null", "true", "false"],
  python: ["def", "class", "return", "if", "elif", "else", "for", "while", "import", "from", "as", "try", "except", "finally", "raise", "with", "lambda", "None", "True", "False", "yield", "async", "await"],
  powershell: ["function", "param", "if", "else", "elseif", "foreach", "while", "return", "try", "catch", "finally", "throw", "switch", "true", "false", "null"],
  shell: ["if", "then", "else", "fi", "for", "do", "done", "while", "case", "esac", "function", "return", "export"],
  csharp: ["using", "namespace", "class", "public", "private", "static", "void", "return", "if", "else", "for", "foreach", "while", "new", "var", "string", "int", "true", "false", "null", "try", "catch", "throw"],
  yaml: [],
  json: [],
  html: [],
  xml: [],
  css: [],
  markdown: [],
  text: [],
};

/** CodeMirror-equivalent minimal tokenizer: comment / string / number / keyword. */
export function highlightCode(src: string, lang = "text"): string {
  const keywords = KEYWORDS[lang] || [];
  const pattern = new RegExp(
    [
      "(\\/\\*[\\s\\S]*?\\*\\/|\\/\\/[^\\n]*|#[^\\n]*|--[^\\n]*)", // 1 comment
      '("(?:[^"\\\\\\n]|\\\\.)*"|\'(?:[^\'\\\\\\n]|\\\\.)*\')', // 2 string
      "(\\b\\d+(?:\\.\\d+)?\\b)", // 3 number
      keywords.length ? "(\\b(?:" + keywords.join("|") + ")\\b)" : "(\\b\\u0000never\\b)", // 4 keyword
    ].join("|"),
    "g"
  );
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(src))) {
    out += escapeHtml(src.slice(last, m.index));
    const cls = m[1] ? "tok-c" : m[2] ? "tok-s" : m[3] ? "tok-n" : "tok-k";
    out += '<span class="' + cls + '">' + escapeHtml(m[0]) + "</span>";
    last = m.index + m[0].length;
    if (m[0].length === 0) pattern.lastIndex += 1;
  }
  out += escapeHtml(src.slice(last));
  return out;
}

export type PreviewStatus = "idle" | "loading" | "ready" | "restricted" | "unsupported" | "error";

export interface PreviewEntry {
  id: string;
  name: string;
  sizeBytes: number | null;
  mime?: string;
  remote?: boolean;
}

export interface PreviewState {
  status: PreviewStatus;
  renderer: PreviewRenderer;
  url: string;
  /** i18n key of the note shown for restricted / unsupported / error states. */
  noteKey: string;
  bytes: number | null;
  lang: string;
  /** Raw text for markdown/code renderers (escaped at render time). */
  text: string;
}

export const PREVIEW_RESTRICTED_KEY = "files.ops.preview.restricted";
export const PREVIEW_LOADING_KEY = "files.ops.preview.loading";
export const PREVIEW_UNSUPPORTED_KEY = "files.ops.preview.unsupportedNote";
export const PREVIEW_ERROR_KEY = "files.ops.preview.error";

export function initialPreviewState(entry: PreviewEntry | null): PreviewState {
  if (!entry) {
    return { status: "idle", renderer: "unsupported", url: "", noteKey: "", bytes: null, lang: "text", text: "" };
  }
  const renderer = rendererFor(entry);
  return {
    status: renderer === "unsupported" ? "unsupported" : "loading",
    renderer,
    url: "",
    noteKey: renderer === "unsupported" ? PREVIEW_UNSUPPORTED_KEY : PREVIEW_LOADING_KEY,
    bytes: entry.sizeBytes ?? null,
    lang: codeLanguageFor(entry.name),
    text: "",
  };
}

export type PreviewFetcher = (id: string) => Promise<PreviewBytes>;
export type PreviewUrlFactory = (blob: Blob, mime: string) => string;

function defaultUrlFactory(blob: Blob): string {
  try {
    if (typeof URL !== "undefined" && typeof URL.createObjectURL === "function") return URL.createObjectURL(blob);
  } catch {
    /* jsdom / hardened origin */
  }
  return "";
}

export interface LoadPreviewOptions {
  fetcher?: PreviewFetcher;
  makeUrl?: PreviewUrlFactory;
  readText?: boolean;
}

/**
 * CORS-safe byte load. Every failure mode is a LABELED state, never a throw:
 * a cross-origin refusal from a remote host becomes `restricted` with the
 * plan's "Preview restricted by external host" note, a server error becomes
 * `error`, an unsupported type never fetches at all.
 */
export async function loadPreview(entry: PreviewEntry, opts: LoadPreviewOptions = {}): Promise<PreviewState> {
  const base = initialPreviewState(entry);
  if (base.status === "unsupported") return base;
  const fetcher = opts.fetcher || fetchPreviewBytes;
  const makeUrl = opts.makeUrl || defaultUrlFactory;
  const wantsText = base.renderer === "markdown" || base.renderer === "code";
  let res: PreviewBytes;
  try {
    res = await fetcher(entry.id);
  } catch (err) {
    return { ...base, status: "restricted", noteKey: PREVIEW_RESTRICTED_KEY, text: "", url: "" };
  }
  if (!res || !res.ok) {
    const status: PreviewStatus = res && (res.status === 0 || /cors|failed to fetch|network/i.test(String(res.error || ""))) ? "restricted" : "error";
    return { ...base, status, noteKey: status === "restricted" ? PREVIEW_RESTRICTED_KEY : PREVIEW_ERROR_KEY };
  }
  const mime = res.mime || "application/octet-stream";
  const bytes = typeof res.bytes === "number" ? res.bytes : res.blob ? res.blob.size : entry.sizeBytes;
  if (wantsText) {
    let text = "";
    try {
      text = typeof opts.readText === "boolean" && !opts.readText ? "" : res.blob ? await res.blob.text() : "";
    } catch {
      text = "";
    }
    return { ...base, status: "ready", bytes: bytes ?? null, text, url: "", noteKey: "" };
  }
  const url = res.blob ? makeUrl(res.blob, mime) : "";
  return { ...base, status: "ready", bytes: bytes ?? null, url, noteKey: "" };
}
