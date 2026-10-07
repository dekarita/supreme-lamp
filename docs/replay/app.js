// [F108 §3] The public replay viewer - DOM half.
//
// WHAT THIS FILE IS. A dependency-free ES module that turns a `.mcrec` bundle
// into a scrubbable replay. It is loaded by docs/replay/index.html with
// `<script type="module" src="./app.js">`, next to a byte-identical copy of the
// shipped cores (docs/replay/vendor/…), because the page is published from
// docs/ by GitHub Pages and cannot import out of that root.
//
// WHAT THIS FILE IS NOT. It is not a second parser: every decision about what a
// bundle is, whether it may be trusted, how it is summarized and which rows a
// timeline has lives in src/replay/replayCore.js (copied verbatim into
// docs/replay/vendor/replay/replayCore.js and pinned byte-for-byte by
// tests/f108-replay-core.test.js). This file only builds DOM.
//
// THE TWO DOM RULES (both enforced by tests):
//   1. textContent ONLY. No innerHTML, no outerHTML, no insertAdjacentHTML, no
//      document.write, no eval, no new Function. A bundle is operator-supplied
//      data - i.e. hostile input - so a `<script>` in a test id stays a visible
//      string and can never become an element node.
//   2. img sources come from core.safeImageSrc() ONLY, which delegates to the
//      F107 thumbnail fence (data:image/png;base64, + 200 kB ceiling + 320x240
//      box). A bundle that points at a remote image renders a placeholder, so
//      opening somebody else's recording cannot beacon your IP to their host.
//
// NETWORK: none. The page ships `connect-src 'none'`, and this file names no
// networking primitive at all - the F108 gate greps the published files for every
// one of them (fetch, XHR, sockets, beacons, streams) and fails if any appears.

import * as core from "./vendor/replay/replayCore.js";

const CLIPBOARD_TIMEOUT_MS = 20_000;

/** Tiny createElement helper - the only DOM construction primitive in this file. */
function el(tag, opts) {
  const node = document.createElement(tag);
  const o = opts || {};
  if (o.id) node.id = o.id;
  if (o.cls) node.className = o.cls;
  if (o.testid) node.setAttribute("data-testid", o.testid);
  if (o.type) node.setAttribute("type", o.type);
  if (o.title) node.title = o.title;
  if (o.attrs) for (const [k, v] of Object.entries(o.attrs)) node.setAttribute(k, String(v));
  // Rule 1: textContent, always. Never innerHTML.
  if (o.text != null) node.textContent = String(o.text);
  return node;
}

/** Replace every child of `node` with `children` (text nodes allowed). */
function fill(node, children) {
  while (node.firstChild) node.removeChild(node.firstChild);
  for (const child of children) {
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

/**
 * gzip inflate for `mcrec1:gzip:` / `mcrec2:gzip:` envelopes.
 *
 * Deliberately injected-capable (tests pass node:zlib) and deliberately absent
 * from replayCore.js (which stays platform-free). Returns null - never throws -
 * when the platform cannot inflate, so the caller can say so in words.
 */
async function inflateGzip(bytes) {
  try {
    if (typeof DecompressionStream !== "function") return null;
    if (typeof Blob !== "function" || typeof Response !== "function") return null;
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * Mount the viewer into `root`. Returns a handle the tests drive directly:
 * `{ loadText, loadFile, select, state, summaryText, destroy }`.
 *
 * `opts.inflate(bytes) -> Promise<Uint8Array|null>` and
 * `opts.clipboard -> { readText(), writeText(text) }` are the only seams.
 */
export function mountViewer(root, opts) {
  const o = opts || {};
  const inflate = typeof o.inflate === "function" ? o.inflate : inflateGzip;
  const clipboard = o.clipboard || (typeof navigator !== "undefined" ? navigator.clipboard : null);

  const q = (id) => root.querySelector("#" + id);
  const input = q("replay-input");
  const status = q("replay-status");
  const verdictLine = q("replay-verdict");
  const result = q("replay-panel-result");
  const scrubber = q("replay-scrubber");
  const entryBox = q("replay-entry");
  const rowsBox = q("replay-rows");
  const rowsNote = q("replay-rows-note");
  const shotsBox = q("replay-shots");
  const shotsNote = q("replay-shots-note");
  const mutTable = q("replay-mutations");
  const sessionTable = q("replay-sessions");
  const featureTable = q("replay-features");
  const summaryBox = q("replay-summary");
  const copyStatus = q("replay-copy-status");

  const TABS = [
    ["timeline", q("replay-tab-timeline"), q("replay-panel-timeline")],
    ["shots", q("replay-tab-shots"), q("replay-panel-shots")],
    ["dom", q("replay-tab-dom"), q("replay-panel-dom")],
    ["storage", q("replay-tab-storage"), q("replay-panel-storage")],
    ["features", q("replay-tab-features"), q("replay-panel-features")],
    ["summary", q("replay-tab-summary"), q("replay-panel-summary")],
  ];

  const state = { bundle: null, version: 0, verdict: null, rows: [], selected: 0, refusedShots: 0 };

  function showTab(name) {
    for (const [key, button, panel] of TABS) {
      const on = key === name;
      if (button) button.setAttribute("aria-selected", on ? "true" : "false");
      if (panel) panel.hidden = !on;
    }
  }

  function setStatus(text, kind) {
    if (!status) return;
    status.textContent = String(text);
    status.className = "status" + (kind ? " " + kind : "");
  }

  function renderTable(table, headers, rows) {
    if (!table) return;
    const head = el("tr");
    for (const h of headers) head.appendChild(el("th", { text: h }));
    table.appendChild(el("thead")).appendChild(head);
    const body = el("tbody");
    for (const row of rows) {
      const tr = el("tr");
      for (const cell of row) tr.appendChild(el("td", { text: core.safeText(cell, 200) }));
      body.appendChild(tr);
    }
    table.appendChild(body);
  }

  function renderRow(index) {
    if (!state.rows.length) {
      fill(entryBox, [el("p", { cls: "note", text: "This recording has no timeline entries." })]);
      return;
    }
    const at = Math.max(0, Math.min(index, state.rows.length - 1));
    state.selected = at;
    const row = state.rows[at];
    if (scrubber) {
      scrubber.value = String(at);
      scrubber.setAttribute("aria-valuetext", "#" + row.seq + " " + row.kind);
    }
    for (const child of Array.from(rowsBox.children)) {
      const isCurrent = child.dataset.index === String(at);
      child.setAttribute("aria-current", isCurrent ? "true" : "false");
      // jsdom has no scrollIntoView; a DOM-less environment must not crash a render.
      if (isCurrent && typeof child.scrollIntoView === "function") child.scrollIntoView({ block: "nearest" });
    }
    const shot = core.attachShot(state.bundle, row.at);
    const parts = [
      el("h3", { text: "#" + row.seq + " · " + row.kind + " · " + core.formatStamp(row.at) }),
      el("p", { text: row.detail || "(no fields)" }),
    ];
    if (row.route) parts.push(el("p", { cls: "note", text: "route " + row.route }));
    if (shot) {
      const img = el("img", { attrs: { alt: "thumbnail for event #" + row.seq, width: String(shot.w), height: String(shot.h) } });
      img.src = core.safeImageSrc(shot);
      parts.push(img);
    }
    fill(entryBox, parts);
  }

  function renderTimeline() {
    const { rows, truncated } = core.timelineRows(state.bundle, { maxRows: core.MAX_RENDERED_ROWS });
    state.rows = rows;
    if (scrubber) {
      scrubber.min = "0";
      scrubber.max = String(Math.max(rows.length - 1, 0));
      scrubber.value = "0";
    }
    fill(
      rowsBox,
      rows.map((row, i) => {
        const li = el("li", {
          attrs: { "data-testid": "replay-row", tabindex: "0" },
        });
        li.dataset.index = String(i);
        li.appendChild(el("span", { cls: "seq", text: "#" + row.seq }));
        li.appendChild(el("span", { cls: "at", text: core.formatStamp(row.at) }));
        li.appendChild(el("span", { cls: "kind kind-" + row.kind, text: row.kind }));
        li.appendChild(el("span", { cls: "detail", text: row.detail }));
        li.addEventListener("click", () => renderRow(i));
        li.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter" || ev.key === " ") {
            ev.preventDefault();
            renderRow(i);
          }
        });
        return li;
      })
    );
    if (rowsNote) {
      rowsNote.hidden = !truncated;
      rowsNote.textContent = truncated ? truncated + " further event(s) are in the bundle but not listed here." : "";
    }
    renderRow(0);
  }

  function renderShots() {
    const shots = Array.isArray(state.bundle && state.bundle.shots) ? state.bundle.shots : [];
    const kept = [];
    for (const shot of shots) {
      const src = core.safeImageSrc(shot);
      if (src) kept.push({ shot, src });
    }
    state.refusedShots = shots.length - kept.length;
    if (shotsNote) {
      shotsNote.textContent =
        kept.length +
        " thumbnail(s) kept" +
        (state.refusedShots ? " · " + state.refusedShots + " refused by the thumbnail fence (not a fenced PNG data URL)" : "") +
        (state.version === 1 ? " · a v1 (clipboard) bundle carries no screenshots" : "");
    }
    fill(
      shotsBox,
      kept.map(({ shot, src }) => {
        const fig = el("figure", { cls: "shot" });
        const img = el("img", {
          attrs: { alt: "screenshot at " + core.formatStamp(shot.at), width: String(shot.w), height: String(shot.h) },
          testid: "replay-shot",
        });
        img.src = src;
        fig.appendChild(img);
        fig.appendChild(
          el("figcaption", {
            text: core.formatStamp(shot.at) + " · " + shot.w + "×" + shot.h + " · " + core.formatBytes(shot.bytes),
          })
        );
        return fig;
      })
    );
    if (!kept.length) fill(shotsBox, [el("p", { cls: "note", text: "No renderable screenshots in this bundle." })]);
  }

  function renderMutations() {
    const { rows, truncated, total } = core.mutationLines(state.bundle, { maxRows: core.MAX_RENDERED_ROWS });
    fill(
      mutTable,
      []
    );
    if (!total) {
      fill(mutTable, []);
      mutTable.appendChild(el("caption", { text: "No DOM mutation descriptors in this bundle." }));
      return;
    }
    renderTable(
      mutTable,
      ["type", "target", "attribute", "×", "+added", "−removed", "folded", "first at"],
      rows.map((r) => [r.type, r.target, r.attr || "—", r.count, r.added, r.removed, r.folded, core.formatStamp(r.at)])
    );
    if (truncated) {
      mutTable.appendChild(el("caption", { text: truncated + " further descriptor kind(s) not listed." }));
    }
  }

  function renderStorage() {
    const rows = core.sessionRows(state.bundle);
    fill(sessionTable, []);
    if (!rows.length) {
      fill(sessionTable, [el("caption", { text: "The storage index is empty in this bundle." })]);
      return;
    }
    renderTable(
      sessionTable,
      ["session", "started", "ended", "clicks", "mut", "shots", "bytes"],
      rows.map((s) => [
        s.id,
        core.formatStamp(s.startedAt),
        s.endedAt ? core.formatStamp(s.endedAt) : "(open)",
        s.clicks,
        s.mutations,
        s.shots,
        core.formatBytes(s.bytes),
      ])
    );
  }

  function renderFeatures() {
    const rows = core.featureRows(state.bundle);
    fill(featureTable, []);
    if (!rows.length) {
      fill(featureTable, [el("caption", { text: "No feature-registry snapshot in this bundle." })]);
      return;
    }
    renderTable(featureTable, ["feature", "route"], rows.map((f) => [f.id, f.route || "—"]));
  }

  function summaryText() {
    return state.bundle ? core.summarize(state.bundle) : "";
  }

  function renderAll() {
    const v = state.verdict;
    result.hidden = false;
    if (verdictLine) {
      verdictLine.hidden = false;
      const bits = [
        "mcrec v" + state.version,
        v.counts.timeline + " timeline",
        v.counts.mutations + " mutations",
        v.counts.shots + " shots",
        v.counts.sessions + " stored sessions",
        v.counts.features + " features",
      ];
      verdictLine.textContent =
        "Read OK · " + bits.join(" · ") + (v.warnings.length ? " · warnings: " + v.warnings.join(", ") : " · no warnings");
      verdictLine.className = "verdict" + (v.warnings.length ? " warn" : " ok");
    }
    renderTimeline();
    renderShots();
    renderMutations();
    renderStorage();
    renderFeatures();
    if (summaryBox) summaryBox.textContent = summaryText();
  }

  async function loadParsed(jsonText, note) {
    const parsed = core.parseBundle(jsonText);
    if (!parsed.ok) {
      setStatus("Not a readable .mcrec bundle: " + parsed.reason, "error");
      return false;
    }
    state.bundle = parsed.bundle;
    state.version = parsed.version;
    state.verdict = core.verdict(parsed.bundle);
    renderAll();
    setStatus(
      (note ? note + " · " : "") +
        "loaded a mcrec v" +
        parsed.version +
        (parsed.version === 1 ? " (lite) bundle" : " (full) bundle") +
        ": " +
        state.verdict.counts.timeline +
        " timeline event(s).",
      "ok"
    );
    showTab("timeline");
    return true;
  }

  /** Load from raw text: an envelope line, or the exported JSON document. */
  async function loadText(text) {
    const cls = core.classifyInput(text);
    if (cls.kind === "gzip-envelope" || (cls.ok && cls.codec === "gzip")) {
      const inflated = await inflate(cls.bytes);
      if (!inflated) {
        setStatus("This bundle is gzip-compressed and this browser refused to inflate it.", "error");
        return false;
      }
      return loadParsed(core.decodeUtf8(inflated), cls.kind);
    }
    if (!cls.ok) {
      setStatus(
        cls.kind === "empty"
          ? "Nothing to read yet - paste a bundle line or choose a file."
          : "Unreadable input (" + cls.reason + ").",
        "error"
      );
      return false;
    }
    return loadParsed(cls.jsonText, cls.kind);
  }

  async function loadFile(file) {
    if (!file) return false;
    if (Number(file.size || 0) > core.REPLAY_MAX_CHARS) {
      setStatus(
        "That file is larger than " + core.formatBytes(core.REPLAY_MAX_CHARS) + " - refusing to read it.",
        "error"
      );
      return false;
    }
    const text = await file.text();
    return loadText(text);
  }

  const onRead = () => {
    if (!input) return;
    void loadText(input.value);
  };
  const onClipboard = async () => {
    if (!clipboard || typeof clipboard.readText !== "function") {
      setStatus("Clipboard reading is not available here - paste into the box instead.", "error");
      return;
    }
    try {
      const text = await clipboard.readText();
      if (input) input.value = String(text || "");
      await loadText(text);
    } catch {
      setStatus("Clipboard refused - paste into the box and press Read pasted text.", "error");
    }
  };
  const onCopy = async () => {
    const text = summaryText();
    if (!text) return;
    try {
      if (clipboard && typeof clipboard.writeText === "function") {
        await clipboard.writeText(text);
        if (copyStatus) copyStatus.textContent = "Copied " + text.length + " characters.";
      } else {
        throw new Error("no clipboard");
      }
    } catch {
      if (copyStatus) copyStatus.textContent = "Copy refused - the summary below is selectable.";
      if (summaryBox) {
        const range = document.createRange();
        range.selectNodeContents(summaryBox);
        const sel = typeof window !== "undefined" && window.getSelection ? window.getSelection() : null;
        if (sel) {
          sel.removeAllRanges();
          sel.addRange(range);
        }
      }
    }
  };

  const listeners = [];
  function on(node, type, handler) {
    if (!node) return;
    node.addEventListener(type, handler);
    listeners.push([node, type, handler]);
  }

  on(q("replay-read"), "click", onRead);
  on(q("replay-load-clipboard"), "click", () => void onClipboard());
  on(q("replay-copy-summary"), "click", () => void onCopy());
  on(q("replay-prev"), "click", () => renderRow(state.selected - 1));
  on(q("replay-next"), "click", () => renderRow(state.selected + 1));
  on(scrubber, "input", () => renderRow(Number(scrubber.value)));
  on(q("replay-file"), "change", (ev) => {
    const file = ev.target && ev.target.files ? ev.target.files[0] : null;
    void loadFile(file);
  });
  for (const [name, button] of TABS) {
    on(button, "click", () => showTab(name));
  }
  on(root, "dragover", (ev) => ev.preventDefault());
  on(root, "drop", (ev) => {
    ev.preventDefault();
    const file = ev.dataTransfer && ev.dataTransfer.files ? ev.dataTransfer.files[0] : null;
    void loadFile(file);
  });
  // A pasted envelope straight into the textarea is read on paste, so the flow is
  // "paste → see it" with no extra click (the button stays for empty-box cases).
  on(input, "paste", () => {
    if (typeof window === "undefined") return;
    window.setTimeout(() => {
      if (input && input.value.trim()) void loadText(input.value);
    }, 0);
  });

  return {
    loadText,
    loadFile,
    select: (i) => renderRow(i),
    showTab,
    state: () => ({ version: state.version, verdict: state.verdict, rows: state.rows.length, selected: state.selected }),
    summaryText,
    root,
    destroy() {
      for (const [node, type, handler] of listeners) node.removeEventListener(type, handler);
      listeners.length = 0;
    },
    _clipboardTimeoutMs: CLIPBOARD_TIMEOUT_MS,
  };
}

// Auto-mount only on the shipped page (its own container id). A jsdom suite that
// imports this module and builds its own container is never touched by this.
if (typeof document !== "undefined") {
  const boot = () => {
    const host = document.getElementById("replay-app");
    if (!host) return;
    try {
      mountViewer(host, {});
      host.setAttribute("data-replay-ready", "1");
    } catch (err) {
      const status = document.getElementById("replay-status");
      if (status) status.textContent = "Viewer failed to start: " + String((err && err.name) || "error");
    }
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
}
