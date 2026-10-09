# Mission Control — Feature and Control Coverage Matrix

Status: PLAN ONLY (v2, 2026-10-09). Denominators are static and re-derived at `823bcb6` with an explicit counting
method. Cells are **NOT MEASURED** unless stated; NOT MEASURED ≠ failed ≠ absent. Census details:
[mission-control/CONTROL-CENSUS.md](mission-control/CONTROL-CENSUS.md).

## A. Denominators

| Class | Count | Counting method / source |
|---|---|---|
| `<Route>` elements | **16** | every `<Route` element in [App.tsx L100-L124](https://github.com/dekarita/supreme-lamp/blob/823bcb6e94df8117a2f43d491a73e60265a968a1/src/App.tsx#L100-L124) |
| ↳ pathless layout route | 1 | `<Route element={chrome("shell", <AppShell />)}>` |
| ↳ navigable route patterns | **14** | `index` + 13 `path=` values other than `*` |
| ↳↳ literal (incl. index `/`) | 12 | `/`, `/sessions`, `/connections`, `/keys`, `/files`, `/mirror`, `/search`, `/telemetry`, `/health`, `/collector`, `/settings`, `/lab` |
| ↳↳ parameterized | 2 | `/search/lab/:targetId`, `/lab/:featureId` (domain: 11 registry ids + invalid ids) |
| ↳ wildcard fallback | 1 | `*` → overview fence |
| `fence()` calls | 13 | 11 sections + search lab + wildcard (pinned by F105-g) |
| Registry features | 11 | `src/lib/feature-registry.json` `features[]` |
| Chrome surfaces | 10 | `CHROME_SURFACES` (8 mounted in App.tsx, 2 in AppShell) |
| Static DOM control call-sites | **301** | census §C.1 (AST; excludes 27 primitive-internal sites, 17 component-callback props, 3 media handlers) |
| ↳ inside dynamic families (`.map`) | 42 | rendered instances NOT counted |
| ↳ conditionally rendered | 60 | ternary/`&&`/`if` between site and component |
| Global keyboard listeners | 12 | `addEventListener('keydown')` |
| Programmatic action sites | 27 | `window.open`, `.click()`, `location.href=`, `launchProto(`, `createElement('a')` |
| Collector Click-now targets | 18 | `KNOWN_BUTTONS` (9 `mutating`) |
| Rendered control instances | NOT MEASURED | requires a browser session (WP-03A) |

v1 values withdrawn: "13 concrete routes (+ `*`)", "14 `<Route>` entries" (correction B1).

## B. Feature-family matrix

DOM-site counts are file-level import reachability (approximate; shared components counted per feature).
"Capture" = static F104 eligibility; "Instr" = explicit Collector instrumentation at the call-site.

| Feature | Route(s) | DOM sites reachable | Capture-eligible | Instr | Diag (runtime) | Test (behavioural) | Live | Main gap | WP |
|---|---|---|---|---|---|---|---|---|---|
| overview | `/`, `*` | see census §C.5 | mostly SELF | 0 | NOT MEASURED | NOT MEASURED | NOT MEASURED | DiagnosticsDrawer background probe pollutes attribution | WP-06 |
| search | `/search`, `/search/lab/:targetId` | largest family set | mostly SELF | 1 (add-site save) | NOT MEASURED | e2e named, lane failing | NOT MEASURED | add-site attribution (MC-P9); `cred-password` capture (MC-P8) | WP-06, WP-13 |
| sessions | `/sessions` | census §C.5 | — | 0 | NOT MEASURED | NOT MEASURED | NOT MEASURED | protocol launch hops beyond "dispatched" | WP-05B |
| connections | `/connections` | census §C.5 | — | 1 (`.rdp`, hard-coded ok) | NOT MEASURED | none | NOT MEASURED | MC-P16 | WP-14 |
| keys | `/keys` | census §C.5 | — | 0 | NOT MEASURED | NOT MEASURED | NOT MEASURED | secret display stays masked; not captured | WP-04 |
| files | `/files` | Explorer family + drag/drop | partial (drag/drop never) | 0 | NOT MEASURED | NOT MEASURED | NOT MEASURED | R6 unread | WP-05A |
| mirror | `/mirror` | census §C.5 | — | 0 | NOT MEASURED | NOT MEASURED | NOT MEASURED | progress denominators | WP-05A |
| telemetry | `/telemetry` | census §C.5 | — | 0 | NOT MEASURED | NOT MEASURED | NOT MEASURED | — | WP-05B |
| health | `/health` | census §C.5 | — | 0 | NOT MEASURED | NOT MEASURED | NOT MEASURED | F92 reuse for provenance | WP-05B |
| collector | `/collector` | 15 (all IGNORED by design) | IGNORED | n/a (is the instrumentation) | NOT MEASURED | e2e named, lane failing | NOT MEASURED | MC-P13, MC-P15 | WP-13, WP-14 |
| settings | `/settings` | census §C.5 | — | 0 | NOT MEASURED | NOT MEASURED | NOT MEASURED | — | WP-03A |

## C. Non-feature surfaces

| Surface | Evidence state | Coverage note | WP |
|---|---|---|---|
| Chrome: shell (top bar/sidebar/bottom bar) | partial read | ws-reconnect logs request only; watcher chip semantics wrong | WP-14 |
| Chrome: diag-drawer | READ | misclassification, focus | WP-14, WP-07 |
| Chrome: dash-token-gate | partial read | password value capture | WP-13 |
| Chrome: collector-bridge, dvr-fab, debug-hud, version-gate, toasts, logon-banner, command-palette | partial / NOT_READ | null-on-crash by design | WP-07 |
| Lab routes `/lab`, `/lab/:featureId` | NOT_READ | SYNTHETIC probe host candidate | WP-05A |
| DVR-lite / DVR-full | READ / partial | screenshots opt-in for export | WP-10 |
| Live Patch | re-measured | producer absent (optional) | WP-08 |
| Worker (Pages control plane) | partial read | separate channel C4 | WP-05A |
| PowerShell server / watcher / launcher | grep only | endpoint semantics | WP-05A |
| Status snapshot / Pages | live initial snapshot observed | finalizer pending; Pages served state unknown | WP-01, WP-05A |
| CI e2e-ui lane | measured | 0/100 recent successes | WP-09 |

## D. Coverage result (current, honest)

| Measure | Value | Denominator |
|---|---|---|
| Registry features mapped to a plan row | 11 | 11 |
| Features with measured runtime diagnostic coverage | 0 | 11 (NOT MEASURED) |
| Static DOM control sites inventoried | 301 | 301 (complete for the static-site definition; rendered instances excluded) |
| Sites with handler body researched | 24 | 301 |
| Sites with explicit Collector instrumentation | 3 | 301 |
| Sites the Collector can exercise (Click now) | 18 | 301 |
| Sites self-eligible for F104 capture | 235 | 301 (keyboard/submit/drag paths never captured) |
| Sites named by ≥1 test file | 149 | 301 (naming ≠ behavioural assertion) |
| Sites named by ≥1 E2E spec | 34 | 301 (E2E lane currently yields no passing evidence) |
| Live verification of any Mission Control feature | 0 | 11 |

No "100% coverage" is claimed.
