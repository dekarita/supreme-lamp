# Mission Control — Feature and Control Coverage Matrix

Status: PLAN ONLY. Denominator is explicit and static (source read this session). See master plan §3.

Legend: `Diag` = diagnostic coverage · `Test` = test coverage · `Live` = live verification · all cells are
**NOT MEASURED** unless stated. "Route" comes from `src/App.tsx`; "Registry" from `src/lib/feature-registry.json`.

## A. Denominator

| Class | Count | Source |
|---|---|---|
| Registry features | 11 | `src/lib/feature-registry.json` |
| Concrete routes | 13 (+ `*` fallback) | `src/App.tsx` |
| Lab routes | 2 (`/lab`, `/lab/:featureId`) + 1 search lab (`/search/lab/:targetId`) | `src/App.tsx` |
| Buttons / forms / menus / keyboard commands | **not counted** | NOT_READ |

## B. Feature-family matrix

| Feature (registry id) | Route | Registry | Diag | Test | Live | Gap | Work item |
|---|---|---|---|---|---|---|---|
| overview | `/` | present | NOT MEASURED | NOT MEASURED | NOT MEASURED | control inventory missing | WP-03, WP-07 |
| search | `/search` | present | NOT MEASURED | NOT MEASURED | NOT MEASURED | 0 real-site coverage read | WP-03, WP-09 |
| sessions | `/sessions` | present | NOT MEASURED | NOT MEASURED | NOT MEASURED | RDP session state probe absent | WP-05 |
| connections | `/connections` | present | NOT MEASURED | NOT MEASURED | NOT MEASURED | connection health probe absent | WP-05 |
| keys | `/keys` | present | NOT MEASURED | NOT MEASURED | NOT MEASURED | key-presence view must stay secret-free | WP-04 (redaction) |
| files | `/files` | present | NOT MEASURED | NOT MEASURED | NOT MEASURED | queue recovery and explorer ops unmapped | WP-03, WP-10 |
| mirror | `/mirror` | present | NOT MEASURED | NOT MEASURED | NOT MEASURED | upload pipeline progress truth unmeasured | WP-05 |
| telemetry | `/telemetry` | present | NOT MEASURED | NOT MEASURED | NOT MEASURED | overlaps DVR/telemetry; reuse required | WP-06 |
| health | `/health` | present | NOT MEASURED | NOT MEASURED | NOT MEASURED | candidate host for WP-07 summary | WP-05, WP-07 |
| collector | `/collector` | present | NOT MEASURED | NOT MEASURED | NOT MEASURED | collector recursion guard must be tested | WP-06 |
| settings | `/settings` | present | NOT MEASURED | NOT MEASURED | NOT MEASURED | settings writes unmapped | WP-03 |

## C. Non-feature surfaces

| Surface | Source | Coverage state | Work item |
|---|---|---|---|
| Lab routes (`/lab`, `/lab/:featureId`) | `App.tsx`, `src/components/lab` | NOT_READ internals | WP-03 |
| Search lab (`/search/lab/:targetId`) | `App.tsx` | NOT_READ internals | WP-03 |
| FeatureBoundary / ChromeBoundary | `src/components/primitives` | NOT_READ internals | WP-03 |
| Global chrome (`collector-bridge`, chrome slots) | `App.tsx` | Mounted; behavior NOT_READ | WP-06 |
| DebugHUD | `src/components/DebugHUD.tsx`, `src/lib/debugHud*` | NOT_READ | WP-06 |
| Collector / action capture | `src/lib/collectorAgent.ts`, `globalClickCapture.ts` | NOT_READ | WP-06 |
| DVR / replay / IndexedDB | `src/lib/dvr`, `src/replay` | NOT_READ | WP-04, WP-10 |
| Live Patch | `src/lib/livePatch`, `src/components/livePatch` | Emitter broken per #181 | WP-08 |
| Auth / dash token | `src/lib/dashToken.ts`, `api.ts` | NOT_READ | WP-05 (redaction) |
| PowerShell server / watcher / launcher | `payloads/*.ps1`, `payloads/*.cs` | NOT_READ | WP-05 (read-only health) |
| Worker | `worker.js` | NOT_READ (CORS origin noted) | WP-05 |
| Pages / status snapshot | `docs/status.json`, pages workflows | Snapshot STALE (2026-10-07) | WP-01 |
| CI gates / e2e-ui lane | `.github/workflows/*`, `tests/e2e` | e2e-ui cancelled on `823bcb6` | WP-09 |

## D. Coverage result (current, honest)

- Registry features mapped to a plan row: **11 / 11**.
- Features with measured runtime diagnostic coverage: **0 / 11**.
- Features with measured test coverage: **NOT MEASURED** (existing e2e/smoke suites not run for this plan).
- Controls inventoried: **0** (control-level inventory is WP-03's deliverable).
- Live verification of any Mission Control feature: **0 / 11** (the only live item is M8, NOT RUN).

No "100% coverage" is claimed. Re-measure after WP-03.
