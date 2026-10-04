# F77 deploy order — merge → build-ui → ui-dist release → main.yml → runner dashboard

The stale-dashboard bug was a race, not a build failure: `main.yml` stages the UI from the
**release asset pinned to its own commit sha**, `ui-dist-<sha>.zip`. That asset is produced by a
*separate* workflow, `build-ui.yml`, which only runs on pushes that touch UI sources
(`src/**`, `index.html`, `package.json`, `pnpm-lock.yaml`, `vite.config.ts`, `tsconfig*.json`,
`tailwind.config.ts`, `postcss.config.cjs`, `scripts/**`, its own file —
`.github/workflows/build-ui.yml:14-24`). A docs-only commit on `main` therefore has **no**
asset for its sha, and a dispatch fired while `build-ui.yml` is still running races it.

```
merge PR ──► push to main
                ├─► build-ui.yml (paths filter)
                │      pnpm install → tsc + vite build (VITE_BUILD_SHA=$GITHUB_SHA)
                │      → zip ui/dist/index.html as ui-dist-<sha>.zip + .sha256
                │      → gh release upload ui-dist --clobber        [~1-3 min]
                │
                └─► main.yml (manual dispatch, AFTER the above is GREEN)
                       jobs.build-ui:
                         download ui-dist-<GITHUB_SHA>.zip  ── hit ──► SHA-256 verify (fail-closed)
                                │ missing: poll 3 × 60 s           └─► ui/dist/index.html → dist-ui
                                │ [F77 §2.5]                                │
                                └─ still missing ⇒ ::error:: + on-runner     ▼
                                   build of THIS sha (never another sha)   rdp job: stage C:\ghrdp\ui-v2.html
                                                                            → dashboard + footer "ui: <sha7>"
```

## Operator order (mandatory)

1. Merge the PR (web UI).
2. Wait for `build-ui.yml` on `main` to go GREEN. Do not skip.
3. Confirm `ui-dist-<merge-sha>.zip` + `.sha256` are attached: `gh release view ui-dist`
   (or https://github.com/dekarita/supreme-lamp/releases → `ui-dist`).
4. Stop the current `ghrdp-*` session (close the WEB DESKTOP tab, let it idle out).
5. Dispatch `main.yml` fresh from Actions.
6. Open the NEW `ghrdp-*` dashboard URL.
7. Hard-reload once (Ctrl+Shift+R) to purge the browser's cached bundle.
8. Read the bottom-bar badge: **`ui: <merge-sha-7>`**. Search sits directly under Overview.

If the badge shows an older sha after step 7, `main.yml` ran before `build-ui.yml` published —
steps 2–3 were skipped. The `[F77 ui-prebuilt]` line in `jobs.build-ui` says which sha it polled
for, and `scripts/f60-stage-and-start.ps1` / `scripts/f60-bootstrap.ps1` now **throw** on a
commit-matched miss instead of staging the newest asset in the release.

## What F77 changed here

- `AppShell.tsx`: no NAV filter — Search renders unconditionally; cached lane keys
  (`__GHRDP_SEARCH_ENABLED`, `f56.search.enabled`, `ghrdp.lane.search`) are purged on mount.
- `lib/search/lane.ts`: hardcoded enabled; no window/storage read.
- `App.tsx`: `/search` and `/search/lab/:targetId` route guards deleted.
- `vite.config.ts`: `import.meta.env.VITE_BUILD_SHA` define (7 chars of `VITE_BUILD_SHA`
  → `GITHUB_SHA` → `"dev"`), printed by the footer badge.
- `main.yml`: `ui-prebuilt` step polls the release 3 × 60 s for `ui-dist-<GITHUB_SHA>.zip`,
  emits `::error::` with the recovery order, and never falls back to a foreign sha.
