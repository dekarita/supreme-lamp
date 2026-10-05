# F89 — PR #138 e2e unblock (exactly 1 known red assertion)

**Status: fix written + verified GREEN locally. Push to `arena/01a10a89-supreme-lamp` is
BLOCKED by this session's branch pin (session is bound to `arena/01a10ad7-supreme-lamp`).
PR #138 HEAD is therefore unchanged at `432d249a` until someone applies the patch below.**

## §0 Preconditions
- `gh` auth = `dekarita` ✓
- PR #138 state = OPEN, head = `arena/01a10a89-supreme-lamp` @ `432d249a0376b1958c97534d984e8e234ee501bb` ✓
- PR #138's branch is **not** this session's branch, and it is not fetchable as a local
  branch here (fetched read-only as `refs/remotes/origin/pr138`; no checkout/switch).
- This session's tree (`f6a65bb`, F87-era) does **not** contain the F88 files at all
  (`tests/e2e/f88-concrete-cases.spec.ts` is absent), so the fix was authored against
  PR #138's tree in a scratch clone at `/tmp/pr138` (outside the repo), and is delivered
  as a portable patch.

## §1 Root cause (proven, not guessed)
CI job `111645537534` (run `37273556047`), annotation `F79-E2E-FAIL`:

```
1) tests/e2e/f88-concrete-cases.spec.ts:41 case 1 (openculture.com …)
   expect(locator).toHaveCount(expected) failed
   Locator:  getByTestId('lab-link-download')
   Expected: 1     Received: 2
   > 69 |     await expect(dl).toHaveCount(1);
1 failed, 70 passed (1.5m)
```

Exactly one red test — case 1, line 69. Why 2 buttons: commit `432d249a` ("F88 fix loop 1")
unchecks matches-first before this point, so the **whole** search set is rendered. Two of
its 5 rows are file-like — `MIME_TO_EXT` maps `text/html → "html"` and `audio/mpeg → "mp3"`
(`src/pages/search/tokens.ts`), and `LabInspector` renders one `lab-link-download` per
file-like row:

| row href | ext | button |
|---|---|---|
| `https://www.openculture.com/freeonlinecourses` | – | no |
| `https://www.openculture.com/2011/04/walter_kaufmanns_lectures.html` | html | **yes** |
| `https://www.openculture.com/philosophy` | – | no |
| `https://www.openculture.com/category/philosophy` | – | no |
| `https://www.openculture.com/audio/platos-republic-lecture.mp3` | mp3 | **yes** |

So `toHaveCount(1)` is unsatisfiable; the one-file-ish-row comment predates the matches-first
uncheck. §1.1's prescribed fix (scope assert + click to the `.mp3` row) is exactly right.

## §2 Lab results (patched PR tree, real bundle + mock backend, Chromium 153.0.8010)
| check | result | baseline |
|---|---|---|
| f88 spec (all 4 cases) | **4 passed (5.7s)**, case 1 = 1.1s | was 1 red |
| full e2e suite (`npm run e2e`) | **71 passed (1.2m)** | CI: 1 failed / 70 passed |
| `node --test tests/*.test.js` | **533 pass / 0 fail** | floor 533+ ✓ |
| `npx vitest run` | **854 passed (67 files)** | floor 854+ ✓ |
| `tsc -p tsconfig.build.json` (build lane) | **0 errors**, bundle built (872 kB) | floor 0 ✓ |
| `tsc --noEmit` (tsconfig.json) | 27 errors, all pre-existing in `src/tests/smoke/*` | unchanged by patch |

§1.2 audit: cases 2 (archive.org) and 3 (openverse.org) **green**; case 4 (awesome.re)
**green** → the markdown/`## Networking` regex branch is **not** needed, no regex change made.

## §3 The fix — 1 file, 19-line diff
`tests/e2e/f88-concrete-cases.spec.ts:65-72` → `F89-evidence/f89-case1-scope-download.patch`

```diff
-    const dl = page.getByTestId("lab-link-download");
-    await expect(dl).toHaveCount(1);
+    // [F89] TWO rows in this set are file-like (the .html lecture page and the
+    // .mp3 audio), so scope the assertion + the click to the .mp3 row instead
+    // of every lab-link-download button in the list.
+    const mp3Row = page.locator('[data-testid=lab-link-row]:has-text(".mp3")');
+    const dl = mp3Row.getByTestId("lab-link-download");
+    await expect(dl).toBeVisible();
```

Click handler is scoped through the same `dl` locator; verified at runtime (the POST still
carries `platos-republic-lecture.mp3` and the "RDP-Downloads" toast still appears).

## §4 Landing (the blocked step — one push to PR #138's branch)
```bash
git fetch origin pull/138/head:pr138 && git checkout pr138
git apply F89-evidence/f89-case1-scope-download.patch
git commit -am "F89: scope F88 download assertion to .mp3 row"
git push origin HEAD:arena/01a10a89-supreme-lamp
```
Expected: `e2e-ui` flips green; then merge #138 from the web UI.

## §5 Evidence
- `F89-evidence/f88-screenshots/` — the 4 case screenshots from the green local run
  (`f88-openculture-philosophy.png` is the fixed case); kept in the workspace only
  (not committed — CI uploads the PR's own screenshots artifact).
- Patch applies cleanly to `432d249a`; no src/ or server change, zero new features.
