# Mission Control — Privacy Sink Map (WP-13 scope proof)

Parent: [#191](https://github.com/dekarita/supreme-lamp/issues/191) · Package: **WP-13** ([#193](https://github.com/dekarita/supreme-lamp/issues/193))
· Revision: `823bcb6` (= application code on `main` `adffebc0`). Permalink base:
`https://github.com/dekarita/supreme-lamp/blob/823bcb6e94df8117a2f43d491a73e60265a968a1/`

**Why this file exists.** WP-13 restricts edits to **three files** but its acceptance promises safety across
localStorage, the DVR ring, `.mcrec` v1 **and v2**, and exports. Correction-ledger row **J5** requires that promise
to be *proved sink by sink* or the package scope revised. This is that proof.

Verdict: **the three-file scope covers `.mcrec` v1 and the DVR ring, and verifiably cannot cover `.mcrec` v2's
screenshot and IndexedDB content.** WP-13 acceptance must therefore be split, and WP-13 planning state downgraded
from `READY_FOR_IMPLEMENTATION` to `SPECIFIED` until the v2 sinks are assigned.

## 1. The one producer

Every leak in this map starts at one function:

| Producer | Location | What it puts where |
|---|---|---|
| `describeClick(el)` | [globalClickCapture.ts L126-L148](https://github.com/dekarita/supreme-lamp/blob/823bcb6e94df8117a2f43d491a73e60265a968a1/src/lib/globalClickCapture.ts#L126-L148) | `label` falls back to `getAttribute("value")` — MC-P8 |
| `currentRoute()` | [globalClickCapture.ts L100-L107, L342](https://github.com/dekarita/supreme-lamp/blob/823bcb6e94df8117a2f43d491a73e60265a968a1/src/lib/globalClickCapture.ts#L100-L107) | raw `location.hash` → `params.route` — MC-P11 |
| fetch observer | [collectorAgent.ts L541-L561](https://github.com/dekarita/supreme-lamp/blob/823bcb6e94df8117a2f43d491a73e60265a968a1/src/lib/collectorAgent.ts#L541-L561) | raw `request.url` (incl. `?key=`) + 2000-char bodies — MC-P12 |
| `maskHeaders` | [collectorAgent.ts L459-L475](https://github.com/dekarita/supreme-lamp/blob/823bcb6e94df8117a2f43d491a73e60265a968a1/src/lib/collectorAgent.ts#L459-L475) | `sha=<FNV-1a>` fingerprint of token values — MC-P13 |
| **`.rdp` action row** | [Connections.tsx L40, L45](https://github.com/dekarita/supreme-lamp/blob/823bcb6e94df8117a2f43d491a73e60265a968a1/src/pages/Connections.tsx#L40) | `params.url = "http://<ip>:7331/rdp"` — runner IP (**J4**, unassigned) |

## 2. Sink-by-sink coverage

| # | Sink | Producer path | Covered by WP-13's 3 files? | Evidence |
|---|---|---|---|---|
| S1 | `localStorage` collector rows | recorder → `collectorAgent` persist store | **YES** — both files in scope | WP-13 scope |
| S2 | Cross-tab rehydration of S1 | `storage` event → rehydrate | **YES**, but only if the hydration redaction pass runs on the **rehydrate** path too, not just initial load | WP-13 "hydration pass" wording must name both paths |
| S3 | DVR **ring** (`30 s`) | `installDvr(inner)` **decorates** F104's recorder and copies `params.label` | **YES — indirectly and completely.** The ring is *downstream* of the recorder, so fixing `describeClick` removes the value before the ring ever sees it | [dvr.ts L216, L230](https://github.com/dekarita/supreme-lamp/blob/823bcb6e94df8117a2f43d491a73e60265a968a1/src/lib/dvr.ts#L216); wiring [main.tsx L43](https://github.com/dekarita/supreme-lamp/blob/823bcb6e94df8117a2f43d491a73e60265a968a1/src/main.tsx#L43) |
| S4 | `.mcrec` **v1** (clipboard) | "clicks only, clipboard-shaped" = the ring | **YES** — inherits S3 | [exportCore.js header](https://github.com/dekarita/supreme-lamp/blob/823bcb6e94df8117a2f43d491a73e60265a968a1/src/lib/dvr/exportCore.js) |
| S5 | `.mcrec` **v2** `timeline[]` | ring entries | **YES** — inherits S3 | `buildBundleV2` input `timeline` |
| S6 | `.mcrec` v2 `mutations[]` | `recordMutations()` | **N/A — verified content-free.** Descriptors carry tag name + attribute **NAME**; "never an attribute VALUE, never characterData, never node text"; `childList` is counts | [mutationCore.js L16, L84-L88](https://github.com/dekarita/supreme-lamp/blob/823bcb6e94df8117a2f43d491a73e60265a968a1/src/lib/dvr/mutationCore.js#L16) |
| S7 | `.mcrec` v2 `shots[]` | `captureShot()` → `XMLSerializer` | **NO** | see §3 |
| S8 | `.mcrec` v2 `storage.sessions[]` + IndexedDB `ghrdp-dvr` | `saveSession`/`saveShots` | **NO** — `dvr/storage.ts`, `dvr/session.ts` out of scope | [session.ts L105-L125](https://github.com/dekarita/supreme-lamp/blob/823bcb6e94df8117a2f43d491a73e60265a968a1/src/lib/dvr/session.ts#L105-L125) |
| S9 | `button-actions.json` | Collector export of raw rows | **YES** — in scope (export path) | [Collector.tsx L269-L283](https://github.com/dekarita/supreme-lamp/blob/823bcb6e94df8117a2f43d491a73e60265a968a1/src/pages/Collector.tsx#L269-L283) |
| S10 | Diagnostic **clipboard** export | same rows, different writer | **ONLY IF** the clipboard writer is also passed through redaction — WP-13 currently names only the file export | §5 |
| S11 | F96 diag bundle | server-generated | **NO** — different producer; belongs to WP-10 | [DiagBundleCard.tsx](https://github.com/dekarita/supreme-lamp/blob/823bcb6e94df8117a2f43d491a73e60265a968a1/src/components/domain/DiagBundleCard.tsx) |

## 3. Why S7 (screenshots) is not covered — and why the existing fence claim is wrong

`defaultRasterizer` does:

```ts
holder.appendChild(root.cloneNode(true));
const xml = new XMLSerializer().serializeToString(holder);   // screenshots.ts L46-L47
```

The file's own comment asserts this "reads STRUCTURE only — the content fence is that no F107 file names a content
API" ([screenshots.ts L41-L43](https://github.com/dekarita/supreme-lamp/blob/823bcb6e94df8117a2f43d491a73e60265a968a1/src/lib/dvr/screenshots.ts#L41)).

**That reasoning does not hold.** `XMLSerializer.serializeToString()` emits **text nodes and attribute values**.
The gate that scans F107 files for `innerHTML` / `textContent` / `getAttribute` therefore does not fence content:
`XMLSerializer` *is itself* a content-serializing API, and it is not on the scanned list. Recorded as **MC-P24**.

Consequence: any secret that is **visible as text or present in an attribute** on the captured root is rasterized
into the 320×240 PNG. Concrete candidate surfaces at this revision:

- `CopyLink value={() => secrets.credWinPass}` with the visible label *"copy CURRENT password from KEYS"* —
  [DiagnosticsDrawer.tsx L226](https://github.com/dekarita/supreme-lamp/blob/823bcb6e94df8117a2f43d491a73e60265a968a1/src/components/domain/DiagnosticsDrawer.tsx#L226)
- the rendered `mstsc /v:<fqdn|ip>` string — [Connections.tsx L20, L34](https://github.com/dekarita/supreme-lamp/blob/823bcb6e94df8117a2f43d491a73e60265a968a1/src/pages/Connections.tsx#L20)

Note this is a **different** mechanism from MC-P8: MC-P8 is an *attribute read*; MC-P24 is *pixel capture of
rendered content*. Fixing `describeClick` does not touch it.

**Unresolved (needs a render-level probe, not a source read):** whether `credWinPass` is resolved into visible DOM
text or only at click time. `CopyLink` takes `value: string | (() => string)`, so lazy resolution is possible — the
question is what the `<a>` renders.

## 4. Screenshots are opt-OUT, not opt-in

`void takeShot()` is called on **every** recorded click ([session.ts L138](https://github.com/dekarita/supreme-lamp/blob/823bcb6e94df8117a2f43d491a73e60265a968a1/src/lib/dvr/session.ts#L138)),
gated only by build-time flags `VITE_DVR_ENABLED` / `VITE_F107_FULL_DVR` ([main.tsx L50-L51](https://github.com/dekarita/supreme-lamp/blob/823bcb6e94df8117a2f43d491a73e60265a968a1/src/main.tsx#L50)).
There is **no run-time operator opt-in**. WP-10's "screenshots opt-in" is therefore a **behaviour change** with a
migration question, not a description of current behaviour (ledger **J7**).

## 5. Required contract changes

1. **Split WP-13 acceptance.**
   - *In scope (must pass):* S1, S2, S3, S4, S5, S9, S10.
   - *Explicitly out of scope, tracked separately:* S7, S8 (new package or WP-13b), S11 (WP-10).
   - *No claim required:* S6 (verified content-free) — but keep the existing `mutationCore` gate as the proof.
2. **Name both hydration paths** (initial load *and* cross-tab rehydrate) in the redaction pass.
3. **Assign S4/J4** (`params.url` at the `.rdp` call-site) to WP-14, which already owns `Connections.tsx`.
4. **State the irreversible-redaction consequence**: the hydration pass rewrites rows in place, so a reverted build
   keeps redacted rows. Do **not** promise "row counts unchanged" *and* "no secret present" without also saying
   old values are unrecoverable — and never preserve an unsafe value to keep a row byte-identical.
5. **Do not promise removal from already-downloaded files.** A previously exported `button-actions.json`,
   `.mcrec` or bundle is out of reach; the honest statement is "future exports are redacted; existing downloads are
   not retroactively cleanable."
6. **Rollback must not reopen the exposure.** "Keep existing downloads" (WP-10's current rollback line) is not a
   safe privacy rollback. Correct fallback: a kill-switch that **disables capture/export** rather than a revert that
   restores raw capture.

## 6. What this does NOT establish

- No runtime or browser verification was performed. Every row above is `SOURCE_REVIEW`.
- S7's exposure is a **confirmed mechanism** (the API serializes content) with an **unconfirmed production
  instance** (whether a secret is actually on screen at capture time). Do not report it as a confirmed leak.
- S6's cleanliness is a source-level contract plus its existing gate; it was not independently re-probed here.
