# CI-gate brittleness inventory (§0.4, first v5 session)

> **Why this file exists.** Observatory sessions may only touch a handful of files, but
> `.github/workflows/launch-gates.yml` pins **431 lines** of them by text - 214 of those are
> fixed-string `grep -F`/`-qF` matches, i.e. the exact bytes of a source line. A step that edits
> `src/App.tsx` without reading this file will discover the pin the slow way: a red `gates` job
> 6 minutes into CI, on a PR whose code is already correct. This inventory lets §PRE-STEP §CI-PIN-DETECTION
> answer "does my step break a pin?" *before* the push, and it is the reason step 3 updated
> `tests/f104-global-click.test.js` in the same commit as the code it pins.
>
> **How to use it.** Find the file(s) you are about to modify in the index at the bottom. If any pin
> in the row targets it, read the pin, decide whether your change keeps it true, and if not, update
> the pin **in the same commit** - intent-preserving and strictly tighter, never deleted. Record the
> decision in the session log as `§CI-PIN-DETECTION` evidence.
>
> **Method (heuristic, re-derivable).** Line-level scan of `.github/workflows/*.yml` for
> `grep`/`rg`/`awk`/`python3 -c`/`assert`/`test -f`/`node --test`/`vitest run` lines whose arguments
> name a repo source path (`src/**`, `tests/**`, `payloads/**`, `docs/**`, `STATE.md`,
> `package.json`, `index.html`). Counts below are what that scan returned on `18660d9`; the scan does
> not understand shell continuation, so treat per-file lists as *lower bounds* and re-run the scan
> before relying on a number.

**Measured**: 2026-10-07 · base `18660d9` (main after PR #166/#167/#168) · by `arena/bd2c6418-supreme-lamp` (step 3).

## 1. Where the pins live

| workflow | pin lines | of which fixed-string `grep -F`/`-qF` | worst rating present |
|---|---|---|---|
| `launch-gates.yml` | 423 | 214 | **HIGH** |
| `autologin-lab.yml` | 6 | 0 | LOW (all are `node --test tests/<f>.test.js` invocations) |
| `f60-warm-pins-bootstrap.yml` | 1 | 0 | LOW (digest pins over its own published JSON) |
| `provision-warm-runner.yml` | 1 | 0 | LOW |
| `build-ui.yml`, `e2e-ui.yml`, `main.yml`, `warm-dispatch.yml`, `webdesk-lab.yml`, `apply-patch.yml`, `f81-sync-sources.yml`, `fixture-refresh.yml`, `e2e-real-sites.yml`, `f59-prebuilt-binaries.yml` | 0 | 0 | - |

`build-ui.yml` runs the in-repo script gates (`scripts/check-*.mjs`) instead of pinning source text;
that is the pattern to prefer. `main.yml` has no source pins at all - it *dispatches*, it does not
verify.

## 2. HIGH brittleness (verbatim arrangement - a refactor that preserves behaviour still fails)

| workflow | step | pin | why HIGH |
|---|---|---|---|
| `launch-gates.yml` | F56-c sidebar + search + file-explorer shell gates (L2636) | `grep -qF 'path="/files" element={<FileExplorer />' src/App.tsx` and the `/search` twin (L2662-2663) | pins the **element expression** of two routes. Any wrapper - e.g. F105's `fence(id, node)` - breaks it even though routing is unchanged. **This is the pin that fired in step 4's branch** (PR #170 updated it in the same commit; step 3 verified its copy still matches). |
| `launch-gates.yml` | same step (L2647-2655) | `python3 -c` extracting `const NAV: NavItem[]` and asserting `tos == ["/", "/search", …, "/settings"]` | pins the **ordered list** of sidebar routes, plus `id`/`hint`/`icon` tokens. Adding an entry anywhere fails; reordering fails. |
| `launch-gates.yml` | F56-c v2 Google-style gates (L2757-2761) | `grep -qF 'max-w-[760px]' … 'h-16' … 'min-h-[45vh]' … 'transition-all duration-500' … 'data-anim'` on `src/pages/search/CommandBar.tsx` | pins CSS **class strings**; a Tailwind class swap with identical rendering fails. |
| `launch-gates.yml` | F56-c v2 (L2771-2778) | `grep -qF 'export const DEFAULT_MAX_SIZE_BYTES = 0;'`, `… = 10 * GB;`, `LAB_*_END_MS = …` | pins constant **expressions** (not values): reformatting `10 * GB` fails. |
| `launch-gates.yml` | F41 v2 build + smoke + regression-id gates (L2234, L2254) | `test "$(wc -l < STATE.md)" -le 60` | a **line budget** on the project ledger. Any step that appends a line to `STATE.md` instead of folding into the last one fails here. |
| in-repo (run by the same job) | `tests/f-i18n-parity.test.js` | `EXPECTED_FLAT_KEYS = 970` | a **count lock** over both catalogs: adding a string to `en.json`/`si.json` without moving the lock fails, by design. Step 3 raised it 949 → 970 in the same commit as its 21 `dvr.*` keys. |
| in-repo | `tests/f104-global-click.test.js` F104-f | `installGlobalClickCapture({` + the two recorder method bodies in `src/main.tsx` | pins the **call shape** at the capture seam. Step 3 replaced the brace literal with a stricter form (named recorder + "nothing else may reach the installer") in the same commit. |
| in-repo | `src/tests/smoke/f76-sidebar-search.test.tsx` | reads `src/App.tsx` and asserts the `/search` + `/search/lab/:targetId` route elements verbatim | same class as F56-c; PR #170 rewrote it intent-preservingly for the fence. |

## 3. MED brittleness (common markup - buttons, routes, testids, class names)

Representative families in `launch-gates.yml` (each family is dozens of lines):

- **testid/markup pins on page components**: `grep -qF 'f56.search.v2.card.' src/pages/search/ResultsGrid.tsx`,
  `'f57.explorer.v2.fetchedGroup' src/pages/file-explorer/ExplorerTree.tsx`,
  `'classic-ui-link' src/components/layout/AppShell.tsx` (F43/F56-c/F57 steps).
  Renaming a testid, or moving markup to a child component, fails even when the UI is identical.
- **refusal greps over the whole tree**: `if grep -Rn '/api/fetch' src/ …` with an allow-list of lanes
  (F56-c/F56-d). A new *comment* mentioning the forbidden path is enough to fail - which is why the
  DVR gate in `tests/f-dvr-lite.test.js` strips comments before its own forbidden-token scan.
- **route/endpoint string pins**: `grep -qF '"/api/search"' src/api/search/index.ts` and friends.
  These pin the contract, so they are MED rather than HIGH: the string is the contract.
- **i18n key pins**: `grep -qF 'f56.search.v2.importBanner' src/pages/search/CommandBar.tsx` and the
  528-key `i18n-f56-parity.test.ts` lock. Key *presence* is a contract; key *arrangement* is not pinned.

## 4. LOW brittleness (contract/API shape, rarely touched by a UI step)

- `payloads/ghrdp-server.ps1` marker pins (`grep -qF 'Id = @(36870, 36871, 36888)'`,
  `'key-open-failed:'`, `'tls-alert-sent:'`) - these pin **error-reason vocabulary** the UI reads;
  changing one is a protocol change and *should* be loud.
- `package.json` dependency pins (`grep -qF '"react-window"' package.json`), `test -f …` existence
  checks, and the `node --test tests/*.test.js` / `pnpm exec vitest run` **globs**. The globs are the
  *best* kind of gate: they cannot be forgotten, and a new file is picked up automatically - which is
  why every Observatory gate so far rides one.

## 5. Index: file → pins that will evaluate it on the next `gates` run

| if you edit… | expect these pins | rating |
|---|---|---|
| `src/App.tsx` | F56-c route greps (L2662-2663); `f76-sidebar-search` source pin; `f102-real-buttons` `APP.includes('<CollectorRunBridge />')` | **HIGH** |
| `src/components/layout/AppShell.tsx` | F56-c NAV ordered-list python assert + `classic-ui-link`/`classicUiLink` + `navigate("/files")`/`navigate("/search")` + bottom-bar id/`useNow` script gate | **HIGH** |
| `src/i18n/en.json`, `src/i18n/si.json` | `tests/f-i18n-parity.test.js` count lock + key-set equality + prose ratchet; `i18n-f56-parity.test.ts` (528 keys); F56-c python parity | **HIGH** (count lock) |
| `src/main.tsx` | `tests/f104-global-click.test.js` F104-f (call shape + method bodies) | **HIGH** (call shape) |
| `src/lib/globalClickCapture.ts` | F104 a-d byte pins; `tests/f-testid-coverage.test.js` rule f (the `collector-`/`click-now-` blind spot); `aria-label`/`data-testid` greps across F56-c/F57 steps | MED |
| `src/components/primitives/*` | `f-testid-dom` (every `<button>` must render a non-empty `data-testid`); `Copy`/`Toggle`/`MaskedField` DOM assertions | MED |
| `tests/*.test.js` (adding one) | nothing pins the list - `node --test tests/*.test.js` picks it up. That is the intended extension point. | LOW |
| `STATE.md` | `wc -l ≤ 60` (twice) | **HIGH** (line budget) |
| `docs/OBSERVATORY-STATE.md` | no CI pin; its contract is the §1 step determination + the ≤60-line rule applies to `STATE.md` only | LOW |
| `package.json` | `grep -qF '"react-window"'`; `pnpm exec vitest run` globs; `node --test tests/*.test.js` | LOW |

## 6. Standing warnings for the remaining Observatory steps

- **F106 (step 5) adds 11 routes to `src/App.tsx`.** It must (a) keep the two F56-c element expressions
  byte-true, (b) re-run the F56-c step locally, and (c) re-check `f76-sidebar-search` - the same three
  obligations step 3 discharged and step 4's PR #170 had to repair.
- **F107 (step 6) adds storage keys.** No CI pin forbids `localStorage`, but `src/stores/searchUiStore.ts`
  and `src/lib/fetchStub.ts` are inside a `grep -RnE 'localStorage|sessionStorage'` refusal set (F56-c v2):
  adding a *new* storage key elsewhere is fine, adding one to those two files is not.
- **F108/F109 (steps 7-8) mount new chrome.** `src/App.tsx`'s chrome block is unpinned beyond
  `f102-real-buttons`'s single `includes()` - but the bottom-bar script gate and `ids-regression` (219 ids)
  both walk the rendered DOM, so anything mounted globally must add **no new `id`** and render **no clock
  text outside the bottom bar**.
- **F111 (step 10) is the fix for this whole class.** Its stated job is the #163 drift gate; this
  inventory is the evidence for broadening it: text pins should migrate to `scripts/check-*.mjs` or
  `tests/*.test.js`, where a change can be reasoned about in a review instead of discovered in CI.

## 7. Re-derive in one command

```bash
python3 - <<'EOF'
import re, io, os
for wf in sorted(os.listdir(".github/workflows")):
    lines = io.open(".github/workflows/"+wf, encoding="utf-8").read().split("\n")
    hits = [l.strip() for l in lines
            if re.search(r"(grep -|rg |test -f|assert |python3 -c|node --test|vitest run)", l)
            and re.search(r"src/|tests/|payloads/|STATE\.md|package\.json", l)]
    print(wf, len(hits))
EOF
```
