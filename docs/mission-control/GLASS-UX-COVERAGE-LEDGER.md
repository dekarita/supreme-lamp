# Glass + UX coverage ledger — #213 / #214

**Parent**: #191 (Mission Control implementation hub).
**Work items**: **#213** (Mornye-inspired glass system) · **#214** (responsive, accessible, text-light UX).
**Researched input, kept as evidence**: #215 / #218 (recommendations and corrections).
**Session**: 2026-10-10 · mode `IMPLEMENTATION_AND_VERIFICATION` · branch `arena/96d87183-supreme-lamp`.
**Not a new plan hierarchy**: this is one compact requirement → implementation → evidence table, in the
existing `docs/mission-control/` structure, using Addendum R's column set and status vocabulary.

## Status vocabulary

`OPEN` · `IN_PROGRESS` · `IMPLEMENTED_UNVERIFIED` · `VERIFIED_IN_TEST` · `BROWSER_LAB_VERIFIED` ·
`THROTTLED_BROWSER` · `REAL_DEVICE` (unused — nothing here ran on a phone) · `DEPLOYED_PREVIEW` ·
`NOT_MEASURED` · `WONT_DO_WITH_REASON`

## Evidence labels used below

`STATIC_CHECK` · `COMPONENT_BEHAVIOR` (jsdom) · `BROWSER_LAB` (real Chromium, unthrottled) ·
`THROTTLED_BROWSER` (Chromium + CDP 4× CPU throttle — a lab signal, **not** a device result).
**No `REAL_DEVICE` and no `LIVE_RDP_ACCEPTANCE` row exists in this session.**

---

## 1. Reference source and what was actually adapted

| Item | Value |
|---|---|
| Repository | https://github.com/spotiflacapp/SpotiFLAC-Mobile |
| Revision inspected | `a434e66fa8f30fd8489ee16e3d5d37b492f88edc` |
| License | MIT (repo license API) |
| Files read (previous session, #215/#218) | `lib/theme/mornye_theme.dart`, `lib/widgets/mornye_chrome.dart` (`MornyeGlass`), `lib/widgets/mornye_liquid_backdrop.dart`, `lib/models/theme_settings.dart`, `lib/providers/runtime_profile_provider.dart`, `test/mornye_glass_level_test.dart` |
| Source copied into this repo | **none** — no Dart, no shader, no artwork, no dependency |
| Dependency of the reference | `liquid_glass_easy: 4.3.4` (MIT) — **REFERENCE_ONLY**, not installed |

| Reference mechanism | Local adaptation | Receiving file |
|---|---|---|
| `_GlassBackdropScope` sets `insideGlass`; children skip backdrop sampling ("child controls paint on this surface; never re-blur their parent") | `GlassBackdropScope` React context; a descendant `GlassContainer` is forced to `surface="nested"` whatever it asked for | `src/components/primitives/GlassContainer.tsx` |
| Clarity is one clamped, **quantized** 0..1 value; blur rebuilt only on a step change | `CLARITY_STEPS = [0, .25, .5, .75, 1]`, `quantizeClarity()`; **the CSS never transitions `--glass-blur`** | `src/lib/glass/quality.ts` |
| Blur off below a threshold even when clarity is non-zero (frosted 0.5, liquid 0.2) | `BLUR_THRESHOLD = 0.5`: clarity ≤ 0.5 paints a tinted **but unblurred** surface | `src/lib/glass/quality.ts` |
| Tint is paint, not a saturation filter | alpha on `background-color` (`rgb(var(--glass-tint-rgb) / a)`), **never** `opacity` on the element | `src/styles/globals.css` |
| Dark mode bounds bright artwork by blending black into the fill | `--glass-veil-*` over the gradient field (raised from the source's 0.35 because a CSS gradient is flatter than album art and the contrast target is measured) | `src/styles/tokens.css` |
| Strong tint stays the menu/popover treatment | `.glass-menu` / `.glass-drawer` at a higher fill floor | `src/styles/globals.css` |
| One overlay batch so overlapping menus do not each capture the screen | **one** backdrop surface in the shell + **one** while an overlay is open; counted in the lab | `src/components/layout/AppShell.tsx` |
| Flat/frosted/liquid levels | `auto` → frosted · `opaque` → flat · `clear` → low-fill glass. **Liquid is not ported** (Impeller-only shader; CSS has no equivalent) | `src/lib/glass/quality.ts` |

**Not claimed**: pixel equivalence with the reference. Flutter `ImageFilter.blur` sigma is not a CSS
`blur()` px, and no reference screenshot was sampled. `MEASURED_FROM_REFERENCE: none`.

---

## 2. Requirement → implementation → evidence

| # | Requirement | Implementation location | Status | Test / evidence | Limitation |
|---|---|---|---|---|---|
| 1 | Semantic visual tokens, not scattered blur utilities | `src/styles/tokens.css` §1.8 (paint channels only) + `src/lib/glass/quality.ts` (all numbers) | `BROWSER_LAB_VERIFIED` | mode matrix: `--glass-alpha` moves 1 → 0.72 as clarity rises; no `backdrop-blur-*` utility anywhere in `src/` | — |
| 2 | `GlassContainer` with `variant` / `surface` / `clarity` / `quality` / `as` + ref forwarding | `src/components/primitives/GlassContainer.tsx` | `VERIFIED_IN_TEST` + `BROWSER_LAB_VERIFIED` | `src/tests/smoke/r-glass-container.test.tsx` (16) + browser computed styles | — |
| 3 | `surface` is a rendering prop; `role` stays ARIA | same | `VERIFIED_IN_TEST` | test asserts `role="navigation"` survives and `role` never contains `backdrop`/`nested` | — |
| 4 | Shared backdrop ownership (one sampler) | `GlassBackdropScope` + TopBar as the single `surface="backdrop"` | `BROWSER_LAB_VERIFIED` | 11 routes × 4 viewports: **sampling = 1** on every one | — |
| 5 | Quality + clarity preferences, persisted beside the theme | `src/stores/prefsStore.ts` (`ghrdp:glass`) | `VERIFIED_IN_TEST` | `theme-persist` suite pattern; inventory gate F111-e/i declares the surface | — |
| 6 | Auto as the intended default (deviation from #213 §8's opaque proposal — see §4) | `DEFAULT quality: "auto"`, resolves to frosted | `BROWSER_LAB_VERIFIED` | `html[data-glass-requested=auto][data-glass-quality-resolved=frosted]`; opaque proven on all 4 override paths | — |
| 7 | Responsive shell (desktop sidebar / tablet sidebar / phone 5-slot bar) | `src/components/layout/AppShell.tsx` | `VERIFIED_IN_TEST` + `BROWSER_LAB_VERIFIED` | `r-ux-shell.test.tsx` (11) + 4 viewports, no overflow at 360/390/768/1440 | — |
| 8 | Phone primary nav ≤ 5 slots, no invented Download route | `MOBILE_PRIMARY` + More → the existing drawer | `VERIFIED_IN_TEST` | test asserts 5 slots, every href is a registered route, and the locked `[data-testid="sidebar"] nav a` still counts 11 | — |
| 9 | 44×44 CSS-px primary touch targets | `.tap-44` + `min-h-[44px]` on nav rows, top-bar controls, modal buttons | `VERIFIED_IN_TEST` (class-level) | `r-ux-shell` asserts the class on every top-bar control and sidebar row | jsdom has no layout engine, so the **px** is asserted by class + CSS, not measured |
| 10 | Safe-area insets | `.safe-top/.safe-bottom/.safe-x` + `env()` in TopBar/Sidebar/BottomBar/MobileNav | `VERIFIED_IN_TEST` (CSS pin) + `BROWSER_LAB_VERIFIED` | test greps `globals.css` for all four insets | **NOT_MEASURED on iOS** — no iPhone Safari was used this session |
| 11 | Escape, focus trap, focus restoration on overlays | `src/lib/useOverlayA11y.ts` (adapted behaviour, **not** a Radix migration) | `VERIFIED_IN_TEST` | `r-ux-shell`: Escape closes the drawer, focus moves in, focus returns to the opener | — |
| 12 | Every control has an accessible name; ambiguous actions keep a visible label | shell-wide | `VERIFIED_IN_TEST` | `r-ux-shell` scans every top-bar and phone-bar control | a repo-wide sweep of all 49 lucide-importing files was **not** completed |
| 13 | Menus, dialogs, drawers, cards on the system | `Feedback` confirm, `CommandPalette`, `Card`, `DiagSideDrawer`, `ExplorerContextMenu`, `PreviewDialog` | `BROWSER_LAB_VERIFIED` | overlay-open case: **sampling = 2**, at budget | — |
| 14 | Bounded visual effects (no blur on rows/cards) | `Card` is `surface="nested"`; nested fill floor 0.86 | `BROWSER_LAB_VERIFIED` | page with 12 glass surfaces → **1** sampler | — |
| 15 | Opaque fallback preserves the new layout | `html[data-glass-quality-resolved=opaque]` | `BROWSER_LAB_VERIFIED` | `quality-opaque-clarity-*` screenshots: same layout, backdrop `absent`, alpha 1 | — |
| 16 | `<!>` Reduced transparency / forced colors / unsupported | CSS media queries + `@supports not` + JS resolution | `BROWSER_LAB_VERIFIED` | reduced-transparency → opaque; forced-colors → opaque (contrast 13.99); `@supports not` rule present | reduced-transparency was exercised via a `matchMedia` shim (Chromium exposes no CDP knob) |
| 17 | Quantized clarity, no continuous filter animation | 5 steps; `--glass-blur` is **not** transitioned | `VERIFIED_IN_TEST` + `BROWSER_LAB_VERIFIED` | `quantizeClarity` unit tests; `globals.css` transitions only `background-color`/`border-color` | — |
| 18 | Decorative backdrop with no desktop capture | `.app-backdrop` — four CSS radial gradients + a veil | `BROWSER_LAB_VERIFIED` | no `<img>`, no canvas, no network fetch in `AppBackdrop.tsx` | — |
| 19 | Measured performance fallback | `src/lib/glass/perfWatchdog.ts` (3 bounded rAF samples, p95 > 50 ms, **one-way latch**) | `VERIFIED_IN_TEST` | `src/tests/smoke/r-glass-perf-fallback.test.ts` (3) | never tripped in the lab (p95 stayed at 16.9 ms), so the trip path is proven only in test |
| 20 | Embedded troubleshooting entry point | existing `DiagSideDrawer` / `DiagnosticsDrawer` / `DiagBundleCard`, now glass surfaces; unchanged behaviour | `ALREADY_SATISFIED_WITH_EVIDENCE` | drawer opens/closes in the browser lab | #202/#205 own these; not redesigned |
| 21 | Lab verification of the **real** routes | `/#/lab` (11 harnesses) + `/#/lab/glass` (new static harness) | `BROWSER_LAB_VERIFIED` | harness mounts the shipped `VisualQualityCard` and writes to the same persisted store | — |
| 22 | i18n parity | 24 new keys in **both** catalogs; all 5 count locks moved 1050 → 1074 | `VERIFIED_IN_TEST` | `f-i18n-parity`, `merge-hygiene`, `f109/f110/f110b` locks | Sinhala strings are **operator-native-review pending**, as the rest of the catalog is |
| 23 | Navigation out of Lab restores normal behaviour | `GlassLab` snapshots the preference on mount and restores on unmount | `IMPLEMENTED_UNVERIFIED` | code path present; **no automated test yet** | follow-up |
| 24 | Rapid repeat clicks / duplicate launches (#10 of the brief) | **NOT IMPLEMENTED this session** | `OPEN` | — | see §5 |
| 25 | Supplied `mcrec` interaction regressions (auto-login, web-desktop, search submit, DVR dialog) | **NOT IMPLEMENTED this session** | `OPEN` | — | see §5 |

---

## 3. Browser and Lab results (real Chromium 153, headless, local build)

### 3.1 Page sweep — 11 routes × 4 viewports (360 / 390 / 768 / 1440)

| Check | Result |
|---|---|
| Page-level horizontal overflow | **none** on all 44 page/viewport pairs |
| Elements owning a `backdrop-filter` (normal shell) | **1** on all 44 |
| Glass surfaces rendered | 4 – 12 per route |
| Minimum text contrast (WCAG AA, computed from real `getComputedStyle` colour + composited background) | **4.74:1** worst case; **0** failing samples |
| Uncaught page errors introduced | **0** (the 16 console entries are the pre-existing React `javascript:` warning and 404s for endpoints the F78 mock does not serve) |

### 3.2 Quality × clarity matrix (27 scenarios)

| Scenario | resolved | `--glass-alpha` | blur | samplers | backdrop | min contrast |
|---|---|---|---|---|---|---|
| frosted, clarity 0 / .25 / .5 | frosted | 1 / 0.93 / 0.86 | **off** (≤ threshold) | 0 | visible | 5.29 |
| frosted, clarity .75 (**default**) | frosted | **0.79** | 8 px | 1 | visible | 5.29 |
| frosted, clarity 1 | frosted | 0.72 | 8 px | 1 | visible | 5.29 |
| clear, clarity .75 / 1 | clear | 0.625 / 0.50 | 4 px | 1 | visible | 5.29 |
| opaque (any clarity) | opaque | 1 | off | 0 | **absent** | 5.29 |
| `prefers-reduced-transparency: reduce` | **opaque** | 1 | off | 0 | absent | 5.29 |
| `forced-colors: active` | **opaque** | 1 | off | 0 | absent | 13.99 |
| `prefers-reduced-motion: reduce` | frosted (motion zeroed, not quality) | 0.79 | 8 px | 1 | visible | 5.29 |
| overlay (Ctrl+K palette) open | frosted | 0.79 | 8 px | **2** (top bar + palette) | visible | 5.29 |

### 3.3 Performance — the #213 §10 workload

Same script for every target: load → all 11 routes → scroll → open/close an overlay → change
quality/clarity twice → 60 s of real dashboard polling. Chromium 153 headless, sandbox container,
no GPU.

**Unthrottled (`BROWSER_LAB`)**

| Target | p50 | p95 | max | frames > 32 ms | long tasks | DOM nodes | samplers w/ overlay | heap Δ |
|---|---|---|---|---|---|---|---|---|
| baseline (pre-redesign, solid) | 16.7 ms | 17.2 ms | 52.2 ms | 6 | 0 | 1096 | 0 | 0 KB |
| redesign, opaque | 16.7 ms | 16.9 ms | 80.7 ms | 1 | 1 (71 ms) | 1123 | 0 | 0 KB |
| **redesign, frosted (default)** | 16.7 ms | **16.9 ms** | 102.3 ms | 2 | 1 (83 ms) | 1123 | **2** | 0 KB |
| redesign, clear @ clarity 1 | 16.7 ms | 16.9 ms | 121.5 ms | 3 | 1 (105 ms) | 1123 | 2 | 0 KB |

**4× CPU throttle (`THROTTLED_BROWSER`)** — `evidence/r-glass/perf-throttled4x.json`

| Target | p50 | p95 | max | frames > 32 ms | long tasks | DOM nodes | samplers w/ overlay |
|---|---|---|---|---|---|---|---|
| baseline (pre-redesign, solid) | 16.7 ms | 18.1 ms | 177.6 ms | **18** | **0** | 1096 | 0 |
| redesign, opaque | 16.7 ms | 17.7 ms | 228.2 ms | 7 | 4 | 1123 | 0 |
| **redesign, frosted (default)** | 16.7 ms | **18.1 ms** | 376.9 ms | 9 | 4 | 1123 | **2** |
| redesign, clear @ clarity 1 | 16.7 ms | 18.2 ms | 344.1 ms | 10 | 5 | 1123 | 2 |

Reading: **steady-state p95 is identical to the baseline at both throttle levels** (16.9 ms unthrottled,
18.1 ms at 4×) and stays inside #213's 32 ms target. The redesign has *fewer* frames over 32 ms than the
baseline (7–10 vs 18 at 4×; 1–3 vs 6 unthrottled).

What it does add is **long tasks**: 0 → 4 at 4× throttle, 0 → 1 unthrottled. They land on mount and on
quality/clarity change — the new chrome's first layout+paint — not during steady interaction, which is
why p95 barely moves. This is the honest cost of the redesign and it is the reason `auto` resolves to
**frosted** rather than `clear` (the clear row is the worst on every single-task metric).

The measured watchdog trips on **p95 > 50 ms**, which is the "is the UI janky while you use it" measure.
It did **not** trip in either run — so on this hardware the redesign stays frosted. On hardware slow
enough to push steady-state p95 past 50 ms, it trips to opaque automatically and stays there.

**Bundle**: 1,159,976 → 1,191,695 bytes (**+31.7 KB, +2.7 %**) for the single-file build.

**Honest gaps in this benchmark**
* Heap is reported at Chromium's coarsened 10 MB granularity, so "0 KB" means *no bucket moved*, not
  *no allocation*.
* The brief's "scroll a 5000-row fixture" cell is **not applicable as written**: `src/pages/FileExplorer.tsx`
  renders its own in-page fixture (13 rows), and `src/components/explorer/data/fixtures/5000-files.json`
  is consumed by the `/api/fx/*` endpoint client, which the page does not call yet. The mock now serves
  that fixture for `/api/fx/list`, but the page still renders the in-page one. The benchmark scrolled the
  largest real scrollable surface instead (≈900 px at 1440×900) — a weak scroll workload, and reported
  as such.
* **No `REAL_DEVICE` row.** Zero phones, zero iPads, zero Windows/macOS machines, zero iOS Safari.
  Playwright WebKit was unavailable (the sandbox cannot reach the browser CDN), so no WebKit run at all.

---

## 4. Decision record: `auto` is the default, not `opaque`

#213 §8 recommended **opaque** as the default "so the retired solid UI remains the default until the
operator opts in", and flagged the alternative as an open question. This session was asked to ship
`auto` and to document the decision. It does:

* `auto` resolves to **opaque** on every path the issue was protecting — no `backdrop-filter` support,
  `prefers-reduced-transparency: reduce`, `forced-colors: active`, and a measured p95 above 50 ms.
  An ineligible browser therefore gets **exactly** the solid presentation #213 wanted as the default.
* `auto` resolves to **frosted** (8 px, fill 0.79 at the 0.75 default) on an eligible browser, which is
  the presentation the operator asked to see. Shipping `opaque` as the default would have meant the
  redesign is invisible until someone finds a setting — the exact failure #214 warns about.
* An **explicit stored `opaque` choice is never upgraded.** Resolution only ever moves *towards*
  opaque, never away from an operator decision.
* `frosted` (not `clear`) is what `auto` picks, because `clear` at clarity 1 produced the 105 ms long
  task in §3.3 and the lowest fill alpha (0.50).

**Not yet validated for production rollout**: the default has been validated on one headless Chromium
in one container. Before it becomes the shipped production default, re-run §3.3 on a low-end Android
Chrome and an iPhone Safari and record `REAL_DEVICE` rows.

---

## 5. Deliberately not done this session

| Item | Why |
|---|---|
| #10 of the brief — isolated regressions for auto-login / web-desktop launch feedback, search submit + failure recovery, DVR dialog consent/confirm/cancel, rapid repeat clicks | These are **handler/behaviour** work on `PrimaryActions`, `WebDesktopCard`, the search lane and `DvrFab`. They are real, they are not visual, and doing them properly needs the download/telemetry work already lodged in its own issues. Lodged as follow-ups rather than half-done here. |
| Radix / shadcn migration | #214 §3 recorded `REFERENCE_ONLY`. Only the focus-trap + focus-restore behaviour was adapted (~60 lines, no dependency). |
| Tailwind v4 / new design framework / new icon set / react-window upgrade | No demonstrated requirement; #213 §5 and #214 §5 reject each explicitly. |
| Replacing telemetry infrastructure, doing the download engine, reopening the historical repair program | Out of scope per the brief. |
| The broad `e2e-ui` lane | Inherited red, unchanged by this work, and its investigation would consume the redesign session. No new regression was introduced (see §3.1: zero new page errors). |

---

## 6. Test inventory added this session

| File | Count | Class |
|---|---|---|
| `src/tests/smoke/r-glass-container.test.tsx` | 16 | `COMPONENT_BEHAVIOR` |
| `src/tests/smoke/r-ux-shell.test.tsx` | 11 | `COMPONENT_BEHAVIOR` + `STATIC_CHECK` |
| `src/tests/smoke/r-glass-perf-fallback.test.ts` | 3 | `COMPONENT_BEHAVIOR` |
| `src/tests/smoke/f106-lab-isolation.test.tsx` (+1 cell) | 1 | `COMPONENT_BEHAVIOR` |

Full suites after the change: **vitest 98 files / 1265 tests pass**; **repo-root `node --test tests/*.test.js`
819 tests → 793 pass, 0 fail, 26 skipped**.

Structural expectations that were **frozen to the old layout and updated in this PR**, each with the
product behaviour that forced the change:

| Gate | Old pin | New pin | Why |
|---|---|---|---|
| `f106-lab-isolation` index rows | document-wide `[data-testid^="lab-index-link-"]` | scoped to `[data-testid="feature-lab-index-list"]` + a new assertion that `/lab/glass` is a static route outside the registry list | the index now links one non-registry harness; the document-wide selector stopped meaning "derived from the registry" |
| `F105-h` | every App.tsx page route must be registry-owned | + `/lab/glass` as an explicitly named lab path | a lab harness is not a 12th feature (`registry.features.length` stays 11) |
| `M2-b` | AppShell renders exactly 7 element names | + `AppBackdrop`, `MobileNav` | two new **layout** parts, both classified: the backdrop is an empty `aria-hidden` div (nothing to fence), `MobileNav` is a sibling of `BottomBar`/`Sidebar` |
| `F111-e` / `F111-i` | 24 storage surfaces | 25 (`ghrdp:glass`, `addedBy: F-GLASS`) | one new persisted preference, declared and ledger-backed |
| `F110-j` / `F110b-h` | i18n lock 1050 | 1074 | 24 keys added to **both** catalogs |

---

## 7. Remaining production activation step

Merged code does **not** change the operator's running RDP session. The dashboard is served by
`payloads/ghrdp-server.ps1` from `/v2` as a single file, so activation is:

1. merge the PR, 2. let the `build-ui` workflow publish `ui-dist-<sha>`, 3. restart / re-fetch on the
   operator's runner so `/v2` serves the new single-file bundle, 4. confirm the footer badge
   (`ui: <sha7>`) matches the merged commit.

**None of that is done by this session.** No recommendation to "clear cache" is made: nothing here
shows a stale asset.
