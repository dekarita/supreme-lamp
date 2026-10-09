# Mission Control — Endpoint and Process-Ownership Contracts (WP-05A, partial)

Parent: [#191](https://github.com/dekarita/supreme-lamp/issues/191) · Package: **WP-05A**
([#199](https://github.com/dekarita/supreme-lamp/issues/199)) · Revision `823bcb6`.
Permalink base: `https://github.com/dekarita/supreme-lamp/blob/823bcb6e94df8117a2f43d491a73e60265a968a1/`

**Read status of this document.** The **route inventory is complete** (derived by extracting every `path -eq`,
`path -like` and `path.StartsWith` literal from `payloads/ghrdp-server.ps1` → **76 distinct literals**). The
**security model is read** (§1, §2). **Individual handler bodies are NOT read** except where a row says so — every
"auth" cell below is either a verified call-site line number or the literal string `NOT_READ`. Do not upgrade a
`NOT_READ` cell without reading the handler.

## 0. Process ownership — resolves the open question in HANDOFF.md

| Question | Answer | Evidence |
|---|---|---|
| Who answers `/ws`? | **The PowerShell server** (`ghrdp-server.ps1`), not a Rust process | [L2286-L2292](https://github.com/dekarita/supreme-lamp/blob/823bcb6e94df8117a2f43d491a73e60265a968a1/payloads/ghrdp-server.ps1#L2286): `Invoke-F99WebSocketUpgrade`; falls back to `400 websocket upgrade required` |
| Port / bind | **7331**, default `Bind = '0.0.0.0'` | [L2-L3](https://github.com/dekarita/supreme-lamp/blob/823bcb6e94df8117a2f43d491a73e60265a968a1/payloads/ghrdp-server.ps1#L2), listener [L9220](https://github.com/dekarita/supreme-lamp/blob/823bcb6e94df8117a2f43d491a73e60265a968a1/payloads/ghrdp-server.ps1#L9220), readiness file writes `LISTENING pid/bind/port` [L9225](https://github.com/dekarita/supreme-lamp/blob/823bcb6e94df8117a2f43d491a73e60265a968a1/payloads/ghrdp-server.ps1#L9225) |
| Does the browser go through the Cloudflare Worker? | **No** for Mission Control APIs. `apiBase()` = page origin on 7331/7332/https, else `http://<host>:7331` ([api.ts L25-L31](https://github.com/dekarita/supreme-lamp/blob/823bcb6e94df8117a2f43d491a73e60265a968a1/src/lib/api.ts#L25-L31)). The Worker is a **separate Pages-origin control plane** for GitHub dispatch/cancel (`/dispatch`, `/cancel`, `/workflow`, `/ping`; `/proxy` = 410) | `worker.js`; correction E1 |
| **Consequence** | A 2xx/4xx from an `/api/...` call is evidence about **the PowerShell server on 7331**, never about the Worker. Diagnostics must name the owning process in the verdict | — |

**Bind is `0.0.0.0`, not loopback.** So the connection-class guard in §1 — not the listener address — is the real
security boundary. Recorded as an observation to classify; **no change is proposed by this planning task.**

## 1. Security model — two layers (this is the contract to preserve)

**Layer 1 — connection class** (`Test-ClientAllowed`, [L786-L798](https://github.com/dekarita/supreme-lamp/blob/823bcb6e94df8117a2f43d491a73e60265a968a1/payloads/ghrdp-server.ps1#L786);
enforced at [L440-L470](https://github.com/dekarita/supreme-lamp/blob/823bcb6e94df8117a2f43d491a73e60265a968a1/payloads/ghrdp-server.ps1#L440)):

| Client class | Test | Token required? |
|---|---|---|
| loopback | `Test-IsLoopbackAddr` | **No** |
| tailnet CGNAT `100.64.0.0/10` (`b[0]=100, 64 ≤ b[1] ≤ 127`) | `Test-TicketSource` / explicit octet test | **No** |
| `other` | — | **Yes** — `?key=` must equal `$Token`; 401 `dash token required` / `dash token invalid` |

Conditional: if `$Token` is empty, `Test-ClientAllowed` returns `true` for **all** classes.
**`OPERATOR_CONFIRMED_CONFIGURATION` states the token is configured; this was not independently verified, and a
403/401 in a diagnostic must not be read as proof the secret is missing.**

**Layer 2 — route-level token.** `Test-GhrdpDashToken` is called at exactly **three** groups:

| Group | Call-site |
|---|---|
| mirror status/enable/disable | [L2418](https://github.com/dekarita/supreme-lamp/blob/823bcb6e94df8117a2f43d491a73e60265a968a1/payloads/ghrdp-server.ps1#L2418) |
| search (`/api/search`, `/status`, `/cancel`, `/probe`) | [L4108](https://github.com/dekarita/supreme-lamp/blob/823bcb6e94df8117a2f43d491a73e60265a968a1/payloads/ghrdp-server.ps1#L4108) |
| f58 sources / lab inspect / launch-url(+diag) / f87-selftest / preview / launcher queue+health / stream / f92-selftest | [L5256](https://github.com/dekarita/supreme-lamp/blob/823bcb6e94df8117a2f43d491a73e60265a968a1/payloads/ghrdp-server.ps1#L5256) |

Token acceptance is a **union**: snapshot token ∪ `dash-token.txt` ∪ `config.json.dashToken`, compared
constant-time via `Test-TicketBearer` ([L861-L890](https://github.com/dekarita/supreme-lamp/blob/823bcb6e94df8117a2f43d491a73e60265a968a1/payloads/ghrdp-server.ps1#L861)).

**Layer 3 (narrower) — credential routes.** `Test-CredsAllowed` is *stricter* than layer 1: **bare loopback never
receives the creds block**; only tailnet CGNAT or a valid `?key=` ([L799-L811](https://github.com/dekarita/supreme-lamp/blob/823bcb6e94df8117a2f43d491a73e60265a968a1/payloads/ghrdp-server.ps1#L799)).

> **Diagnostic consequence (WP-05B).** A 401/403 must be attributed to a **named layer**, never to "the secret is
> wrong". `401 dash token required` (layer 1, no key presented) and `403 tailnet POST required` (layer 3, source
> class) are different facts with different operator actions.

## 2. Route inventory (76 literals) with verified auth call-sites

`AUTH` column values: `L1` = layer 1 only · `L1+L2` = layer 2 verified at the cited line · `L3` = creds layer ·
`TICKET` = one-time ticket · `BEARER` = explicit `Authorization: Bearer` · `NOT_READ` = handler not yet read.

| Route(s) | Line | Method(s) | AUTH | Effect class | Notes / next read |
|---|---|---|---|---|---|
| `/ws` | 2286 | GET (upgrade) | `L1` | long-lived WS | PowerShell-owned (§0) |
| `/api/rdp-token` | 2255, 7047 | OPTIONS, POST | `L1` (+`Test-TicketSource` at 7059) | issues ticket | ticket issue path |
| `/api/fx`, `/api/fx/*`, `/preview-sandbox`, `/preview-sandbox/*` | 2303 | via module | decided **inside** the fx module ("dash-token presentation, query-credential refusal, CSRF, path containment") | Explorer file API | 503 `Explorer API unavailable` when `FxReady` false — **read `src/lib/explorer/*` + the fx module** |
| `/rentrydiag` | 2360 | NOT_READ | NOT_READ | diag | — |
| `/flush` | 2364 | NOT_READ | NOT_READ | **possible side effect** | never assume a non-GET is safe |
| `/api/mirror/status` `/enable` `/disable` | 2379, 2484, 2501, 2517 | GET / POST | **`L1+L2` @2418** | enable/disable = **mutating** | WP-05B probe candidate: `/api/mirror/status` GET |
| `/launch` | 2587 | NOT_READ | NOT_READ | **launches** (side effect) | do not probe |
| `/diag` | 2593 | NOT_READ | NOT_READ | diag JSON | **WP-14 MC-P14 target**; read next |
| `/api/fetch` | 2692 | NOT_READ | NOT_READ | **server-side fetch** | SSRF-class surface; classify, do not probe |
| `/api/search`, `/status`, `/cancel`, `/probe` | 3400, 4123, 4358, 4438, 4478 | POST/GET/POST/POST (method-gated at 4067-4070) | **`L1+L2` @4108** | `cancel` = mutating; `probe` = **type-10 probe (deliberate)** | #153/#156 B3 disagreement is about keeping these probes |
| `/api/f58/sources`(+`/*`), `/api/lab/inspect`, `/api/launch-url`(+`/diag`), `/api/f87-selftest`, `/api/preview`, `/api/launcher/queue`, `/api/launcher/health`, `/api/stream`, `/api/f92-selftest` | 4530 (group), 5280, 5316, 5985, 6049, 6112, 6170, 6187, 6282, 6311, 6502, 6547 | mixed | **`L1+L2` @5256** | `launch-url`, `launcher/queue`, `preview`, `f87-selftest` = **mutating/launching** | `/api/launcher/health` GET and `/api/f92-selftest` GET are the existing health probes (`captureServiceStates`) |
| `/dl`, `/dl/*` | 7011 | NOT_READ | `L1` (+`RemoteEndPoint` at 7016) | download | `Content-Disposition: attachment` — **this is where a real download could be observed** (J3) |
| `/rdp-creds`, `/api/rdp-info` | 7081 | NOT_READ | NOT_READ | **credential surface** | — |
| `/api/rdp-creds` | 7085 | **POST only** | **`TICKET`** — `Test-TicketSource` + `Use-RdpTicket`; 403 `tailnet POST required`, 401 `ticket invalid or expired`, 409 `credential config unavailable` | returns `{fqdn, user, pass}` | **never a probe target.** Tickets are single-use and source-bound ([L833-L845](https://github.com/dekarita/supreme-lamp/blob/823bcb6e94df8117a2f43d491a73e60265a968a1/payloads/ghrdp-server.ps1#L833)) |
| `/api/native-status` | 7120 | NOT_READ | NOT_READ | status | polled every 15 s **and** 10 s (MC-P20) |
| `/api/diag/comprehensive` | 7568 | NOT_READ | NOT_READ | diag bundle | F96; **not listed in `feature-registry.json` overview endpoints** — registry incompleteness |
| `/api/collector/run` `/status` `/report` | 7990, 7991, 8151, 8159 | POST/GET/GET | NOT_READ | `run` = **starts work** | — |
| `/api/purge-stale-creds` | 8179 | POST | **`BEARER`** (`Authorization: Bearer <Token>`, constant-time) | **returns a command; no server-side side effect** | returns `command` for the operator to run once — a "purge" route that does **not** purge. Good example of why route names must not be trusted |
| `/api/handler-hello` | 8206 | POST | NOT_READ | NOT_READ | — |
| `/api/rdp-telescope` | 8247 | POST | NOT_READ | NOT_READ | — |
| `/api/launcher-status`, `/api/rdp-status`, `/api/version`, `/api/ping` | 8283, 8299, 8339, 8376 | NOT_READ | NOT_READ | status | safe probe candidates **once handlers are read** |
| `/api/diag.ps1`, `/api/logon-status` | ~8387, ~8399 | NOT_READ | NOT_READ | NOT_READ | — |
| `/webdesk-probe` `/webdesk-status` `/webdesk-frame` `/webdesk-input` `/webdesk-clip` `/webdesk-ctl` | 8453, 8465, 8472, 8481, 8504, 8516 | NOT_READ | NOT_READ | `-input`, `-ctl` = **mutating** | — |
| `/terminal`, `/terminal-exec`, `/terminal-result` | 8542, 8596, 8673 | NOT_READ | **NOT_READ — guard not located** | **executes scripts** (`system` or `interactive` session; timeout clamped 1 s–300 s) | **must be read before any probe contract is written** |
| `/remote-exec` | 8698 | POST | **no route-level check found in its own block** | **executes a base64 script** via `Start-Job` → `powershell -NoProfile -ExecutionPolicy Bypass -File`; audits length + first 200 chars | Reachable per layer 1 (loopback/tailnet). **Existing security contract — preserve and document; never a diagnostic probe target.** |
| `/webdesk`, `/novnc`, `/vncstatus`, `/webdesk-boot` | 8720, 8727, 8767 | NOT_READ | NOT_READ | NOT_READ | — |
| `/config`, `/api/config` | 8776, 8956 | NOT_READ | NOT_READ | status/config | `?key=` appears in client URLs (MC-P12) |
| `/progress`, `/api/progress`, `/mirror`, `/api/stats` | 8785, 8992 | NOT_READ | NOT_READ | status | polled every 3 s |
| `/fonts/*.woff2` | 8891 | GET | `L1` | static | — |
| `/rdp` | 8906 | NOT_READ | NOT_READ | **download** | the `.rdp` file (J3/J4) |
| `/ping`, `/health`, `/api/ping` | 8947, 8951, 8376 | GET | `L1` | status | **`/health` still needs its body read** before being called side-effect-free |
| `/parsec-push` | 9022 | NOT_READ | NOT_READ | NOT_READ | — |
| `/`, `/index.html` | — | GET | `L1` | static SPA | — |

## 3. Probe rules that follow from §1–§2

1. **Never** target: `/remote-exec`, `/terminal-exec`, `/terminal`, `/launch`, `/api/launch-url`,
   `/api/launcher/queue`, `/api/rdp-creds`, `/rdp-creds`, `/api/rdp-token`, `/api/purge-stale-creds`,
   `/api/collector/run`, `/api/mirror/enable|disable`, `/api/search/cancel`, `/webdesk-input`, `/webdesk-ctl`,
   `/api/fetch`, `/flush`, `/api/f87-selftest`.
2. **No GET is automatically "risk: none."** `/health` and `/api/ping` bodies are unread; `/api/search/probe`
   performs deliberate network probes by design. Risk is set from the handler, not the verb.
3. Every probe must carry: route, method, owning process, auth layer expected, timeout, cancellation, concurrency
   limit, output allow-list, and the interpretation limits.
4. A probe that races with a user action **must not** be labelled "pre-action state" (correction §4.B/§9).
5. **Retired endpoints stay retired.** `/proxy` on the Worker answers `410`; planning must not propose restoring it.

## 4. Remaining WP-05A reads (exact)

1. `payloads/ghrdp-server.ps1` L2593-L2692 (`/diag`) — WP-14 MC-P14 depends on this.
2. L7568-L7990 (`/api/diag/comprehensive`) — F96 bundle fields.
3. L8542-L8600 (`/terminal` guard) — needed before any webdesk probe contract.
4. L7120-L7568 (`/api/native-status`).
5. The `fx` module behind `/api/fx` + `src/lib/explorer/*` — Explorer journey J4.
6. `.github/workflows/*` Pages deploy + the M8 heartbeat writer — WP-01 stages C/D.

## 5. What this document does NOT establish

No endpoint was called. No production probe was run. Every cell is `SOURCE_REVIEW` at `823bcb6`, or an explicit
`NOT_READ`. Nothing here is `CONTROLLED_BEHAVIOR_VERIFIED`, and no live acceptance is implied.
