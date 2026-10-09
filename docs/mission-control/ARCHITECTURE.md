# Mission Control — Actual Architecture and Data Flow (source-traced)

Replaces the serial "browser → Worker → server" diagram of plan v1 (correction E1). Edges are labelled
**[S]** source-confirmed, **[R]** runtime-observed (CI/API evidence), **[?]** uncertain/not yet read.

## 1. Channels

```
 ┌──────────────────────── Operator browser ────────────────────────┐        ┌──── Pages site (dekarita.github.io) ────┐
 │ Mission Control SPA (HashRouter, single-file bundle)             │        │ docs/*.html + docs/status.json (served) │
 │  stores (zustand) · collector store (localStorage 500 rows)      │        │  control UI ──(C4) X-Access-Code──┐     │
 │  DVR ring (memory) · DVR sessions (IndexedDB ghrdp-dvr)          │        └───────────────────────────────────│─────┘
 │  dash token: ?key= → #key= → localStorage ghrdp.dashToken        │                                            ▼
 └──┬─────────────┬───────────────┬─────────────────┬───────────────┘                         Cloudflare Worker (worker.js)
    │(C1) HTTP     │(C2) WebSocket │(C3) protocol     │(C6) no-cors probe                          Origin == Pages origin only,
    │ apiBase()    │ ws(s)://host  │ ghrdp://…        │ http://<ip|fqdn>:7331/                      1 req/30 s/IP, code-hash check
    ▼              ▼  /ws          ▼                  ▼                                            │(C4) GitHub REST (GH_PAT)
 PowerShell dashboard server (payloads/ghrdp-server.ps1, port 7331)  ghrdp-handler (.NET, operator PC)   ▼
  raw TcpListener + hand-rolled HTTP parser [S per #153]              registers ghrdp: protocol,      GitHub Actions: main.yml
  /api/* routes, /diag, /health, /ping, /ws upgrade [S grep]          launches mstsc [S per #181]     dispatch / cancel / run list
  Test-GhrdpDashToken [S grep]                                                                          │
    │(C5) files / tasks / services [?]                                                                  │(C7) contents API commit
    ▼                                                                                                   ▼
 Windows runner (ephemeral, 6 h): watcher task, launcher service, Tailscale, RDP listener,     docs/status.json on main
 aria2/qBittorrent, Rust WS dashboard (GhrdpRustDash) [R step names]                            (initial, heartbeat, M8 finalizer)
```

| Ch. | Path | Auth | Evidence | Diagnostic relevance |
|---|---|---|---|---|
| C1 | SPA → `apiBase()` = page origin when served on 7331/7332/https, else `http://<hostname>:7331` | `X-Dash-Token` header (most clients); `?key=` in `/api/config`, `/api/native-status`, `/api/diag/comprehensive`; `Authorization: Bearer` for `/api/rdp-token`, `/api/purge-stale-creds` | [S] [api.ts L25-L88](https://github.com/dekarita/supreme-lamp/blob/823bcb6e94df8117a2f43d491a73e60265a968a1/src/lib/api.ts#L25-L88), [api/diag/index.ts L118-L120](https://github.com/dekarita/supreme-lamp/blob/823bcb6e94df8117a2f43d491a73e60265a968a1/src/api/diag/index.ts#L118-L120) | Three auth shapes → three failure signatures; token in URLs reaches capture rings (MC-P12) |
| C1′ | Relative-path calls: `/diag` (`runDiag`), `/ping`, `/health`, `/api/progress` (polling) | none / same-origin | [S] [sessionStore.ts L158](https://github.com/dekarita/supreme-lamp/blob/823bcb6e94df8117a2f43d491a73e60265a968a1/src/stores/sessionStore.ts#L158), polling hook grep | Differ from `apiBase()` when the page is not served by the API port (MC-P14) |
| C2 | SPA → `<proto>//<location.host>/ws` (+`?key=` and hello frame) | dash token | [S] polling hook L163-L180 (grep), server `Invoke-F99WebSocketUpgrade` L430 | Transport exists; no patch frames (#181). Same host:port as the page [S]; Rust WS dashboard is a separate service [?] |
| C3 | SPA → `ghrdp://rdp|recred|check|diag`, `ghrdp:connect?rid=` via `location.href` | single-use 60 s ticket from `POST /api/rdp-token` | [S] [sessionStore.ts L182-L255](https://github.com/dekarita/supreme-lamp/blob/823bcb6e94df8117a2f43d491a73e60265a968a1/src/stores/sessionStore.ts#L182-L255) | "Dispatched" ≠ "handler ran" ≠ "mstsc connected"; only the handler beacon (`lastHandlerVerb` in native-status, 20 s window) proves a hop |
| C4 | Pages site → Worker → GitHub REST (`/dispatch`, `/cancel`, `/workflow`) | `Origin` allow-list + `X-Access-Code` (SHA-256 compared to `WORKER_ACCESS_CODE_HASH`) + server-side `GH_PAT` | [S] [worker.js](https://github.com/dekarita/supreme-lamp/blob/823bcb6e94df8117a2f43d491a73e60265a968a1/worker.js) | **Not** on the SPA path. Workflow control failures belong to this channel; production dispatch/cancel is OPERATOR_CONTROLLED |
| C5 | Server ↔ Windows: scheduled tasks (watcher ONLOGON XML, launcher service, WebDesk), registry (AutoAdminLogon), files (`C:\ProgramData\ghrdp\…`), Tailscale | local | [S] main.yml step bodies (partial), [R] step names of run 37903915039 | Identity binding (MC-P21) decides whether ONLOGON tasks run in the operator's session |
| C6 | SPA → `http://<ip|fqdn>:7331/` no-cors, every 30 s while `DiagnosticsDrawer` is mounted | none | [S] [DiagnosticsDrawer.tsx L51-L100](https://github.com/dekarita/supreme-lamp/blob/823bcb6e94df8117a2f43d491a73e60265a968a1/src/components/domain/DiagnosticsDrawer.tsx#L51-L100) | Opaque status 0; pollutes capture windows (MC-P10) |
| C7 | Runner → GitHub contents API → `docs/status.json` on `main` (initial, heartbeat, M8 finalizer); Pages deploy by workflow (`build_type: workflow`) | runner token | [R] commit `580f231` "initial status.json" (`runAttempt: 1`); Pages API | Status provenance = run id + attempt; served Pages state not observable from this sandbox (github.io not on the egress allow-list) |
| C8 | Planning/tracking: GitHub issues/PRs | — | — | Never a runtime channel |

## 2. In-browser diagnostic data flow (as built)

```
 user click ──► document capture listener (F104) ──► recorder.record() ──► DVR decorator ──► logButtonAction()
                    │ per-click fetch/open wrappers (10 s)                     │ ring (30 s, memory)   │
                    └─ every exchange appended to EVERY pending row ──────────┘                       ▼
 instrumented handler ──► instrumentButton(): 4 probes ─► action ─► LAST non-probe exchange ─► 4 probes ─► row
 Collector "Click now" ──► navigate ─► pre-steps ─► probes ─► el.click() ─► observe (net idle + DOM quiet) ─► row
 FeatureBoundary / ChromeBoundary ──► window event ──► reporter (≤20 rows) ──► row
                                                                          ▼
                                    zustand persist "f102-collector-actions-v1" (localStorage; 50 full + 450 slimmed rows)
                                    ├─► Collector page tables (recorded vs global)
                                    ├─► "Download button-actions.json" (raw)
                                    └─► F107 session timeline / mutations / screenshots (IndexedDB) ─► .mcrec v2 export
```

## 3. Uncertain edges (explicit)

| Edge | Why uncertain | Discriminating read/probe |
|---|---|---|
| `/ws` served by the PowerShell server vs the Rust WS dashboard | Client uses `location.host`; run steps start both a PS server on 7331 and "GhrdpRustDash" | read polling hook L150-L200 + server `/ws` route; check which port the Rust dashboard binds |
| Fields of `/diag`, `/api/diag/comprehensive`, `/api/collector/report` | server handlers not read | server route table read (WP-05A) |
| Pages served state | sandbox cannot reach github.io; CI step is non-asserting | operator-side `curl -I` or a CI step that fails on non-200 (WP-05A proposal) |
| Heartbeat writer cadence for the current run | only the initial commit observed at 08:27Z | re-list `docs/status.json` commits after the run ends (WP-01) |
| Session identity for ONLOGON tasks | quser parsing on the runner; which user the operator RDPs into | read-only probe spec P-07 in the acceptance plan |
