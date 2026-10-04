# F79 — Google-simple Search (review before merge)

## Locked decisions
- D1: progress OFF by default, session-only `showProgress`; Advanced toggle `f79.search.showProgressToggle`.
- D2: honest query-specific zero-results message; its custom-site button opens F78 AddSiteQuick, never an adapter list.
- D3: backend `$script:DefaultFanOutAdapterIds` owns exactly github-releases, internet-archive, arxiv-public, wikipedia-public, google-books-public. Empty wire selection delegates to it; legacy aliases normalize before fan-out.
- D4: one centered spinner + “Searching...” while queued/running/partial with no results.
- D5: Your sites first, then cards; results heading only with 2+ categories (or explicit debug).
- D6: Google navigation retained as a muted 12px secondary External row beside Alt+F help, below the form.
- D7: Classifier/Federated probes/Consolidation, adapter lists and empty transfer scaffolding are debug-only; actual accepted transfers remain reachable.
- D8: cache the Ubuntu runner’s prebuilt Chromium-based Chrome, with APT fallback and explicit executablePath; no Playwright CDN fetch or snap-wrapper browser path. Test the production bundle; always publish SHA-named screenshots for 14 days.

## Root-cause audit / lab
- Authenticated GitHub user: dekarita. PR #128 merged as 864800ee1fb4d51236f5361080bcef33e2c3e77a and is an ancestor of base bebd0c4. The session never merges or dispatches main.yml.
- Rail renderer: `src/pages/search/v2/ProgressiveLab.tsx:103-178`; unconditional primary mounts were in Search. Its empty-status fallback expanded the 29-label Advanced roster, not the actual fan-out. Backend really defaulted to five **legacy-named** ids, while the initial client selected only Google Books.
- Status data remains: `payloads/ghrdp-server.ps1:2283`, `src/stores/searchStore.ts:270,292`. F78 quick-add/Your sites/Lab inspector and F77 visibility/badge/lane/auto-purge remain intact; F78 has 20 passing real-browser assertions.
- Baselines: node 453/453, Vitest 766/766, production tsc 0; final node 462/462, Vitest 786/786, production + touched-file tsc 0, build clean, E2E 30/30, 30 explicit screenshots, all 11 YAML workflows parse, both PS audits and four UI regression gates pass. STATE remains 60 lines.
- TypeScript scope is explicit: `tsconfig.build.json` is the shipped/CI gate. The test-inclusive legacy tsconfig already had 25 errors before F79; touched tests/new specs were separately typechecked. No claim that unrelated legacy fixtures were repaired. Local Chromium came from a temporary npm-pack binary, not a committed dependency. Preview/API are mocks, not a live runner.

## Change evidence (file:line)
| File | Change / verification |
| --- | --- |
| `src/pages/Search.tsx:119,150-198,246-272` | 760px layout, truly hidden landing title in results, sites first, conditional debug/header/loading/empty/transfer composition; tsc + UI/E2E. |
| `src/stores/searchStore.ts:89,168-169,213-215,252,270,292` | Session-only disclosure, empty default/reset/wire delegation, status ingestion kept; tsc + fan-out/unit contracts. |
| `src/pages/search/v2/AdvancedPanel.tsx:61,87-98` | Accessible default-off progress checkbox; tsc + UI/E2E. |
| `src/pages/search/v2/ProgressiveLab.tsx:57-61` | Debug fallback limited to actual selection/default five, never the whole roster; tsc + rail/E2E. |
| `src/pages/search/SearchStates.tsx:5-27` | One spinner and query-specific empty state + quick-add callback; tsc + unit/E2E. |
| `src/pages/search/CommandBar.tsx:95,225-252` | Full-width capped bar and secondary Google/help row; tsc + UI/E2E navigation. |
| `src/pages/search/ResultsGrid.tsx:15-17,144-151,190-223` | 16px padding, 24px gap, hover elevation, 18/14/12px title/snippet/green URL; tsc + dark/light computed-style E2E. |
| `src/api/search/index.ts:55` | Optional typed snippet; tsc. |
| `src/lib/search/fanOut.ts:6-25` | Canonical mirror; explicit deduplication/eight-source cap retained; tsc + contracts. |
| `payloads/ghrdp-server.ps1:1670,2243-2247,2605,2667,2982-2986,3057,3136-3168` | Canonical allowlists/default/status/result ids, legacy aliases, all F72 helpers kept; Node contracts + both PS audits. |
| `src/i18n/en.json:304-309,528-529,670`; `src/i18n/si.json:210-215,434-435,576` | Six UI keys + two public-source labels and truthful five-default hint, byte/placeholder parity; JSON parse + parity suite. |
| `.github/workflows/launch-gates.yml:2743,2871` | Re-pin the two superseded 60%-width assertions to the locked 760px layout; both affected shell gates run verbatim locally, YAML + PS audits. |
| `.github/workflows/e2e-ui.yml:27-48,55-88` | Chromium cache/executable, real E2E, mandatory always-uploaded screenshots + download-link summary; YAML parse + Node contracts. |
| `playwright.e2e-ui.config.ts:18,34-38` | executablePath + built-bundle preview on 0.0.0.0; tsc + real Chromium. |
| `vite.config.ts:40-50,61` | Preview host allowlist/server-side API proxy, include required root F79 unit specs; tsc + build/E2E. |
| `tailwind.config.ts:9-10` | Block a timestamp regex accidentally extracted as invalid CSS; tsc + warning-free CSS build. |
| `tests/e2e/fixtures/mock-backend.mjs:22-36,159-215` | Server-derived five defaults, typed search envelopes, request-id log, unique source ids; node --check + E2E. |
| `tests/e2e/fixtures/f79-results.json:1` | Deterministic two-card scholarly fixture; JSON parse + E2E. |
| `tests/e2e/f78-add-sites.spec.ts:2-7,26,49,132` | Fix pre-existing pathname-vs-HashRouter mismatch; retain all twenty assertions; tsc + E2E. |
| `tests/e2e/f79-google-simple.spec.ts:1` | Ten E2E tests + explicit review screenshots, request-id-isolated mock log; tsc + real Chromium. |
| `tests/f79-search-fixture.tsx:1`; `tests/f79-probe-rail-hidden.test.tsx:1` | Typed reset/render helpers, default-off/reveal/data/navigation/layout tests; tsc + Vitest. |
| `tests/f79-empty-state.test.tsx:1`; `tests/f79-loading-state.test.tsx:1` | Query/modal/sites/header/honest DEV-empty and single-spinner/partial tests; tsc + Vitest. |
| `tests/f79-default-5-adapters.test.ts:1`; `tests/f79-default-fanout.test.js:1` | Wire/backend defaults, preserved explicit cap/F72 dispatches, CI screenshot contracts; tsc/node --check + Vitest/Node. |
| `src/tests/smoke/f56c-v2-landing.test.tsx:102`; `src/tests/smoke/f56c-v3-lab.test.tsx:14,28,53,150,188` | Rewrite superseded width/debug assertions, normalize legacy typed fixtures; tsc + retained smoke tests. |
| `src/tests/smoke/f69-search-fixes.test.tsx:118-124`; `src/tests/smoke/f70-google-books.test.tsx:93-102`; `src/tests/smoke/i18n-f56-parity.test.ts:36` | Rewrite default/roster/catalog pins in place, delete no coverage; tsc + retained suites. |
| `tests/f70-google-books.test.js:87,188-195`; `tests/f70-search-endpoints.test.js:36,53` | Re-pin canonical default/31-label roster without dropping existing cases; node --check + Node. |
| `STATE.md:11-12`; `docs/f79-google-simple.md:1` | Record F79 lab + actual F78 merge, keep STATE <=60; line-count/diff/evidence audit. |

## Operator next — mandatory order
1. Download e2e-ui’s `screenshots-<sha>` artifact BEFORE merging. No artifact means no visual approval.
2. Open empty, loading, results and Your-sites screenshots (also inspect dark/light).
3. If any screenshot looks wrong, comment on the PR; do NOT merge.
4. Only if all screenshots look right, merge via GitHub’s web UI.
5. Wait for build-ui.yml GREEN on main.
6. Confirm `ui-dist-<merge-sha>.zip` in the ui-dist release.
7. Stop the current ghrdp session.
8. Dispatch main.yml fresh (operator only; this agent never dispatches it).
9. Open the new dashboard URL and Ctrl+Shift+R.
10. Footer badge must equal the new merge-sha’s first seven characters.
11. Click Search.
12. Confirm clean Search and small “Open on google.com” below the bar; no probe rail.
13. Type a query: loading is one spinner.
14. Zero results names the submitted query and offers custom-site quick-add.
15. Added sites appear in Your sites at the top.
16. Advanced → “Show search progress (debug)” reveals the preserved rail only when needed.
