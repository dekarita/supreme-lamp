# F56-a §1 AUDIT — read-only inventory of the F56 landing surface

Session: `arena/01a0f142-supreme-lamp` (branched from `70d21385`, `main` HEAD).
Scope: audit only. No `src/`, `payloads/*.ps1`, `.github/workflows/`, or `tests/`
file was opened for write. Every statement below is re-derivable by the greps
named in each row.

Inputs: `payloads/docs/f56-search-explorer-plan.md` (this PR, verbatim plan),
`PROJECT-CONTEXT-v2-CANONICAL.md` §6 Locked Rules, `STATE.md`.

---

## A. F38 tokens used in the v2 shell

### A.0 Where the tokens live

| Layer | File | Role |
|---|---|---|
| F38/F39 origin (v1) | `payloads/ui.html` (`:root`, `html[data-theme=dark|light]`) | The tokens `tests/f38-ui-glass.test.js` locks (F38-4 … F38-8) |
| v2 single source of truth | `src/styles/tokens.css` | CSS custom properties; `tailwind.config.ts` only MIRRORS them |
| v2 utilities | `tailwind.config.ts` | `bg-base`, `text-primary`, `border-default`, … |
| v2 base layer | `src/styles/globals.css` | focus ring, reduced-motion, reduced-transparency, skip-link, `svg.ic` legacy alias |
| v2 faces | `src/styles/fonts.css` | Inter 400/600, JetBrains Mono 400, Noto Sans Sinhala 400 (inlined, ≤120 KB) |

Legend used below:

* **extends** — the v2 token is the same semantic role as an F38 token and
  carries it forward (name changed, value re-derived from the slate/sky ramp).
* **new-sibling** — no F38 counterpart; added beside the F38 family for a role
  F38 did not model.

### A.1 Surfaces

| v2 token | Value (light / dark) | F38 origin | Classification |
|---|---|---|---|
| `--color-bg-base` | `#f8fafc` / `#0f172a` | `--bg` (`#f5f7fb` / `#05070d`) | extends |
| `--color-bg-surface` | `#ffffff` / `#1e293b` | `--glass-bg`, `--tier-card-bg` (retired glass) | extends |
| `--color-bg-surface-raised` | `#f1f5f9` / `#273345` | none | new-sibling |
| `--color-bg-surface-sunken` | `#f1f5f9` / `#0b1220` | `--tier-inset-bg` (retired) | extends |
| `--color-fx-thumb-bg` (F45) | `#f1f5f9` / `#0b1220` | none | new-sibling |
| `--color-fx-preview-scrim` (F45) | `rgba(15,23,42,.60)` / `.72` | `--glass` overlay family | new-sibling |
| `--color-fx-mask` (F45) | `#334155` / `#94a3b8` | none | new-sibling |
| `--color-fx-selection` / `-border` / `--color-fx-drop-target` (F45) | sky @ .12/.08 | `--acc1` family | new-sibling |
| RETIRED: `--glass-blur`, `--glass-edge`, `--glass`, `--glass-hi`, `--sheen`, `--tier-bar-*`, `--tier-card-*`, `--tier-inset-*`, `--aurora-1..3`, `--vibrancy-1..3`, `--card-radius:16px`, `--card-shadow:0 8px 32px` | — | F38-4 asserts them **in `payloads/ui.html` only** | not available to F56 in v2 — see decisions B1 |

### A.2 Borders

| v2 token | Value (light / dark) | F38 origin | Classification |
|---|---|---|---|
| `--color-border-default` | `#e2e8f0` / `#334155` | `--line` (alpha white/black) | extends |
| `--color-border-strong` | `#cbd5e1` / `#475569` | `--line-hi` | extends |
| `borderColor.default` / `.strong` (Tailwind) | mirrors the two above | — | extends |
| RETIRED: `--glass-edge: 0.5px solid rgba(255,255,255,0.25)`, `--tier-hi: inset 0 1px 0 rgba(255,255,255,.12)` | — | F38-4 | not available in v2 |

### A.3 Type

| v2 token | Value | F38 origin | Classification |
|---|---|---|---|
| `--font-sans` | Inter → system → Noto Sans Sinhala | `--font-ui` (`"SF Pro Text"` first, Inter fifth) | extends (re-ordered; Inter is now primary) |
| `--font-mono` | JetBrains Mono → Consolas → ui-monospace | `--font-mono` (Consolas first) | extends (re-ordered) |
| `--body-size` | `14px` | `html{font-size:18px}` body cascade | new-sibling |
| `html[data-scale=large]` | `15px`, root `17.1429px` | `html[data-text="large"]{font-size:21px}` | extends (different key + values) |
| `html[data-scale=a11y]` | `16px`, root `18.2857px` | none | new-sibling |
| persistence key | `ghrdp:textScale` (`useScaleStore`) | `ghrdp:textScale` (F38-5) | extends — **same key** |
| RETIRED: `--font-display` (`SF Pro Display`), 28/24px display sizes, `letter-spacing:-0.01em` | — | F38-8 | not available in v2 |
| Sinhala face | `noto-sans-sinhala-400-latin-free.woff2`, `unicode-range:U+0D80-0DFF` | F38-3 (both 400 and 600 embedded in v1) | extends (v2 drops 600 for the font budget) |

### A.4 Spacing / radius / shadow / z

| v2 token | Value | F38 origin | Classification |
|---|---|---|---|
| `--space-1,2,3,4,5,6,8,12,16` | 4/8/12/16/20/24/32/48/64px | F38 4px grid (implicit) | new-sibling (first explicit scale) |
| `--space-fx-row` / `-row-compact` / `-tile` / `-column` / `-drawer` (F45) | 36/28/128/240/480px | none | new-sibling |
| `--radius-sm/md/lg` | 4/6/8px | `--radius: var(--card-radius)` = 16px | extends (values reduced; enterprise geometry) |
| `--shadow-xs/sm/md` | flat 1–2px shadows | `--card-shadow: 0 8px 32px rgba(0,0,0,0.12)` | extends (deliberately flatter) |
| `--z-fx-context/drawer/palette` (F45) | 60/45/70 | none | new-sibling |
| `maxWidth.shell` | 1600px | `main{max-width:1440px}` (F38-8) | extends (widened) |

### A.5 Focus

| v2 token / rule | Value | F38 origin | Classification |
|---|---|---|---|
| `--color-focus-ring` | `#0ea5e9` light / `#38bdf8` dark | `--acc1` (`#0891b2` / `#22d3ee`) | extends |
| `:focus-visible` (globals.css) | `outline: 2px solid var(--color-focus-ring); outline-offset: 2px` | F38-8 `:focus-visible` | extends |
| `.skip-link` / `.skip-link:focus` | `--space-2/3`, `--color-border-strong`, `--radius-md` | F38 skip link | extends |
| hit-area floor | F38-8 `min-height:2.444rem` (44px @18px root) | F38-8 | **no v2 token** — F56 `search.commandBar.controlHeight` / `search.grid.minRowHeight` must carry the 44px floor themselves (decisions B6) |

### A.6 Motion

| v2 token | Value | F38 origin | Classification |
|---|---|---|---|
| `--motion-fast/med/slow` | 100/150/200ms `cubic-bezier(0.4,0,0.2,1)` | `--ease: cubic-bezier(.2,.8,.2,1)` | extends (curve changed, no overshoot) |
| Tailwind `transitionDuration.fast/med/slow` | 100/150/200ms | — | extends |
| `@media (prefers-reduced-motion: reduce)` | all durations → `0ms !important` (globals.css) **and** `--motion-*: 0ms linear` (tokens.css) | F38-8 | extends (kept verbatim) |
| `@media (prefers-reduced-transparency: reduce)` | `backdrop-filter: none !important` | F38-4 | extends (kept, now a no-op surface-wise) |
| RETIRED: `--spring: cubic-bezier(0.34,1.56,0.64,1)` | — | F39 §2 | banned in v2 (no spring overshoot) |

### A.7 Semantic status colours (constraint for Plan §C licence palette)

`--color-success` is the ONLY green (`#059669` light / `#10b981` dark);
`--color-warning` `#d97706`/`#f59e0b`; `--color-danger` `#dc2626`/`#ef4444`;
`--color-accent` `#0ea5e9`. `scripts/check-no-neon-green.mjs` bans the literals
`#22c55e`, `#39ff14`, `#00ff41`, `#00ff00` in the built bundle. The Plan §C
"muted mint" public-domain pair must therefore be a new-sibling semantic token
that avoids those four literals **and** keeps AA contrast in both themes.

**Net for F56:** every Plan §C `search.*` token is a **new-sibling** in the v2
naming convention (`--color-search-licence-*`, `--space-search-*`), reusing the
A.1–A.6 families for surface/border/type/spacing/focus/motion. No F38 glass,
aurora, vibrancy, sheen, spring or display-type token may be reintroduced into
`src/` — the F38 gate enforces those only against `payloads/ui.html` (v1).

---

## B. Verbatim dump: the 219 IDs of `tests/f38-ui-glass.test.js`

Source of truth: `tests/f38-ui-glass.test.js`, `const BASELINE_IDS=[ … ];`
(line 19 onward). Mirror: `src/lib/regression-ids.ts` `REGRESSION_IDS`
(kept in lockstep by `scripts/check-regression-ids.mjs`, which extracts both
lists and fails CI on any drift).

Count: **219** (verified by extraction, not by eye).
Status: **FROZEN UNCHANGED**. F56-a modifies neither file; Plan §I entries are
additive and land in F56-c at the earliest.

The block between the `BEGIN/END VERBATIM` markers is a byte-for-byte copy of
the array literal as it appears in the test file:

<!-- BEGIN VERBATIM 219 IDS -->
```js
const BASELINE_IDS=[
  'activeBar', 'activeBytes', 'activeName', 'activePct', 'activePhase', 'aggBar',
  'archiveLink', 'archiveRow', 'autoLoginNative', 'autoLoginStatus', 'btnFixReconnect', 'btnKitDl',
  'btnRunCheck', 'btnRunDiag', 'btnTermCopy', 'btnTermOpen', 'btnWebDesk', 'btnWinAuto',
  'c2Fps', 'c2Jit', 'c2Rtt', 'c2Spark', 'c2Srv', 'c2Via',
  'clientDnsCmds', 'clientDnsFix1', 'clientDnsFix2', 'clientDnsFix3', 'clientDnsRow', 'clientDnsText',
  'cmdkeyLine', 'connBadge', 'connBanner', 'connCredsspBox', 'connDiagCiphers', 'connDiagCredsspPol',
  'connDiagEvtClient', 'connDiagEvtList', 'connDiagEvtSch', 'connDiagEvtSec', 'connDiagEvtTerm', 'connDiagFailBox',
  'connDiagFqdn', 'connDiagLmCompat', 'connDiagMstscVerbose', 'connDiagPing', 'connDiagPurgeAll', 'connDiagRd',
  'connDiagResolved', 'connDiagRow', 'connDiagServerPurge', 'connDiagTls13', 'connDiagTlsBox', 'connDiagTnc',
  'connDiagTshark', 'connFps', 'connJit', 'connRtt', 'connSpark', 'connUdpAdv',
  'connUdpAdvText', 'credIp', 'credUser', 'credVncPass', 'credWinPass', 'decryptLink',
  'decryptRow', 'diagBox', 'drawer', 'drawerScrim', 'egressLine', 'endedBanner',
  'explorerLink', 'explorerRow', 'fallbackLink', 'fileRows', 'ghrdpBuild', 'handoffChain',
  'kitGuideA', 'kitPathB', 'lastRdpLogon', 'legacyKey', 'legacyLink', 'liveDispatchAcl',
  'liveDispatchAclCmd', 'liveDispatchChecks', 'liveDispatchFix', 'liveDispatchRow', 'liveDispatchSummary', 'logBox',
  'logPauseBtn', 'manualVerifyBrowser', 'manualVerifyCmdkey', 'manualVerifyList', 'manualVerifyRdp', 'manualVerifySchannel',
  'manualVerifySteps', 'manualVerifyStill', 'mirrorKey', 'mstscFallback', 'mstscVal', 'nrAdvisory',
  'nrAdvisoryRow', 'nrBuildWarn', 'nrBuildWarnText', 'nrCert', 'nrCertReason', 'nrCmdkeyConfirmed',
  'nrCredssp', 'nrCredsspReason', 'nrEphemeralRow', 'nrHostKind', 'nrHostKindNote', 'nrLauncherOutdated',
  'nrLauncherOutdatedRow', 'nrLauncherVersions', 'nrMagicDns', 'nrMagicDnsRow', 'nrNla', 'nrNlaReason',
  'nrReady', 'nrReadyRow', 'nrReasons', 'nrReasonsRow', 'nrVpsPending', 'nrVpsPendingRow',
  'nrVpsShortcutRow', 'pagesLink', 'pillClock', 'pillConn', 'pillMirror', 'pillRust',
  'pillWatcher', 'primaryLink', 'pubDot', 'pubTxt', 'rdpAuthCmdCapi2', 'rdpAuthCmdCapi2Wrap',
  'rdpAuthCmdKeyDel', 'rdpAuthCmdKeyDelWrap', 'rdpAuthCmdSystem', 'rdpAuthCmdSystemWrap', 'rdpAuthCmds', 'rdpAuthDetail',
  'rdpAuthPassCopy', 'rdpAuthPassWrap', 'rdpAuthRow', 'rdpAuthVerdict', 'rdpFqdn', 'rdpListenerAge',
  'rdpListenerLine', 'rdpListenerRow', 'recoveryCmdkey', 'recoveryNote', 'recoveryRow', 'recoveryText',
  'ringFill', 'ringGrad', 'rootsWrap', 'searchLink', 'searchRow', 'sec-conn',
  'sec-keys', 'sec-log', 'sec-mirror', 'sec-native-rdp', 'sparkNow', 'sparkline',
  'srvConnLogBind', 'srvConnLogLines', 'srvConnLogRow', 'srvConnLogState', 'srvConnLogTls', 'stBytes',
  'stBytesSub', 'stDone', 'stEta', 'stFailed', 'stOverall', 'stScans',
  'stScansSub', 'stSpeed', 'telegraphLink', 'telescopeDeath', 'telescopeRow', 'telescopeSegments',
  'telescopeSummary', 'telescopeTrace', 'termRow', 'termUrl', 'ticketAudit', 'tileFailed',
  'timerElapsed', 'timerRdpUsage', 'timerRemaining', 'toasts', 'tsAuthAdvisory', 'tsAuthAdvisoryText',
  'tsAuthGuidance', 'usageState', 'vncPassForget', 'vncPassInput', 'vncPassRemember', 'vncPassState',
  'webdeskAuthAdvisory', 'webdeskAuthAdvisoryText', 'webdeskAuthVal', 'webdeskUrlVal', 'webdeskVncAdvisory', 'webdeskVncAdvisoryText',
  'webdeskVncGuidance', 'winAutoFiles', 'winAutoInstall', 'winAutoNote', 'winAutoStale', 'winBeacon',
  'winBeaconLog', 'winBeaconStall', 'winKitRow'
];
```
<!-- END VERBATIM 219 IDS -->

### B.1 Frozen-list verification performed in this audit

| Check | Result |
|---|---|
| Array length | 219 |
| Duplicates | none |
| `tests/f38-ui-glass.test.js` modified by F56-a | no |
| `src/lib/regression-ids.ts` modified by F56-a | no |
| Renames / removals / renumbering | none |
| F56 IDs present in the list today | none (`f56.search.*` is Plan §I, additive, F56-c) |

Already-present anchors F56 must not disturb: `searchLink`, `searchRow` (the v1
static `docs/search.html` row), `explorerLink`, `explorerRow`, `rootsWrap`,
`sparkline`, `sparkNow`, `stSpeed`, `stEta`, `stBytes`, `activePhase`,
`pillMirror`, `sec-mirror`.

---

## C. F46 fetch-progress + cancellation surfaces F56-d will consume (read-only)

### C.1 Progress plane — the authoritative snapshot

| Item | Location | Detail |
|---|---|---|
| Producer | `payloads/ghrdp-watcher.ps1` | `$progPath = Join-Path $Root 'progress.json'` (line 336); `Initialize-MirrorProgress` (341), `Flush-MirrorProgress -Force` (347, 592, 683, 765, 783, 811, 907, 951, 960, 966) |
| State owner | `payloads/ghrdp-lib.ps1` | `Initialize-MirrorProgress` (61), `Set-ActiveFile` (name/phase/total), `Tick-MirrorBytes` (per-write bytes), `Add-MirrorLog` (200-line cap, `Protect-F46SecretText` redaction), `Flush-MirrorProgress` (122; 0.2 s throttle, `-Force` bypasses) |
| Transport truth | `payloads/ghrdp-mirror-progress.cs` | `Ghrdp.Mirror.ProgressState` → `Written(int)`, `SocketMessage(string)`, `CancelForStall()`, `Reset()` ([F53] a retry never inherits the previous attempt's socket count), `Snapshot()` / `SnapshotAt(double)`; `ProgressSnapshot` = `BytesSent, WindowBytes, WindowSeconds, SpeedBps, ElapsedSeconds, NoBytesSeconds, StallWindows, Stalled, Failed, LastMessage`; `Stalled = StallWindows >= 1`, `Failed = StallWindows >= 3` |
| HTTP read | `payloads/ghrdp-server.ps1` | `GET /api/progress` (aliases `/progress`, `/mirror`, `/api/stats`; lines 2641 and 2843) |
| Response shape | same, line 2843+ | `{ serverTs, kind:'snapshot', mirror, encryptMode, mirrorIndexUrl, rentryNewUrl, legacyIndexUrl, runnerEgressIp, keepAliveDeadline, keepAlivePhase, pagesBase, startedAt, runStartedAt, sessionStartedAt, progress, conn, wire }` |
| `progress` shape | `Initialize-MirrorProgress` | `{ ts, alive, mirror, active{name,phase,bytesSent,bytesDone,bytesTotal,pct,speedBps,windowBytes,windowSeconds,etaSeconds,stalled,noBytesSeconds,stallLabel}, agg{total,done,active,failed,bytesDone,bytesTotal,overallPct,speedBps}, telemetry{scans,lastScan,roots[],seen,skippedJunk,skippedSmall,locked,queued}, archives[], files[], log[], speedHistory[] }` |
| Per-file row | `src/lib/domain/progress.ts` | `{name, phase, pct, pctText, size, status, error, link, expired, host, encrypted, encryptMode, statusLabel, byteCounts, attempts[{n,line}]}` |

### C.2 Client consumers (the exact modules/exports F56-d reads)

| Module | Exports | Event/shape F56-d consumes |
|---|---|---|
| `src/lib/domain/mirrorBytes.ts` | `mirrorBytes(value): bigint`, `mirrorQueueProgress(file)`, `mirrorPercent(sent,size)`, `mirrorTransfer(progress,live)` | Int64-exact byte math (decimal strings above 2^53−1 stay exact); `mirrorTransfer` returns `{sent,size,window,seconds,gap,stalled,label,speed,eta}` — this is the speed/ETA/stall source for a progress row |
| `src/lib/domain/progress.ts` | `interface MirrorModel`, `mirrorModel(d, prevHistory): MirrorModel` | `speedHistory` (≤90 samples, server list wins else locally appended), `activePhase`, `activePct`, `activeBytes`, `encryptMode/encryptRequested/encryptedAny/encAlg/plaintextElected/encryptionDefect` (F46 §4 encryption honesty), `roots`, `pubDot/pubTxt` |
| `src/stores/telemetryStore.ts` | `useTelemetryStore`, `elapsedSeconds`, `remainingSeconds` | `setProgress(d)` derives `clockOffsetMs` from `serverTs`, `mirror`, `speedHistory`, `logLines`; `serverNow()` for ETA clocks |
| `src/hooks/useDashboardPolling.ts` | `useDashboardPolling()` | cadence: config 15 s, native-status 15 s + 10 s, **progress 3 s**, `/ping` 2 s, `/health` 30 s; `AbortController` is used only on the `/health` probe (3 s) |
| `src/lib/mirror.ts` (F49) | `getMirrorStatus()`, `setMirrorEnabled(on, csrf)`, `interface MirrorStatus`, `interface MirrorOptState` | `GET /api/mirror/status`, `POST /api/mirror/enable|disable`; `X-Dash-Token` header only + per-process `X-CSRF-Token` (header or `ghrdp_mirror_csrf` cookie); 404 ⇒ pre-F49 server ⇒ legacy flush |
| `src/components/domain/ConnectionCard.tsx` | `Sparkline({samples,width=220,height=34,id})` | canvas sparkline already reused by `MirrorCard` — the Plan §A "accessible speed sparkline" + `search.sparkline.height` extends this component, it does not replace it |
| `src/components/explorer/api/*` (F45) | `FX_PATHS`, `createFxApi`, `createFxClient`, `FxError`, `assertUploadState`, `assertGofileState`, `assertFileEntry`, `assertUploadAccepted`; `retryPolicy`: `TRANSIENT_PHASES`, `MAX_TRANSIENT_ATTEMPTS=5`, `BACKOFF_BASE_MS=500`, `BACKOFF_CAP_MS=8000`, `BACKOFF_FLOOR_MS=100`, `RETRY_AFTER_CAP_MS=120000`, `canRetry`, `shouldRetryNow`, `attemptsRemaining`, `backoffDelayMs` | the F44/F46 phase ladder and retry budget the Plan's `retryable`/`retryAfterSeconds` envelope must line up with |

### C.3 Enumerations already frozen (F56 must map onto these, not invent a second ladder)

| Enum | Values | Location |
|---|---|---|
| `UploadPhase` | `dns, tcp, tls, encrypt, size, type, auth, http, parse` | `src/components/explorer/data/schema.ts:4` |
| `UploadStatus` | `idle, queued, uploading, success, failed, canceled` | `schema.ts:5` |
| `GofileStatus` | `none, uploaded, processing, expired, failed` | `schema.ts:6` |
| `IndexRoot` | `Downloads, Desktop, Documents, Temp, RDP-Storage` (**5**) | `schema.ts:3` |
| `FAIL_FAST_HTTP` | `401, 403, 413, 415` (1 attempt, never retried) | `src/components/explorer/api/errors.ts` |
| `FxErrorKey` | `fx.err.auth, forbidden, notFound, tooLarge, type, rateLimit, hostBadGateway, hostTimeout, parse` | `errors.ts` (closed set: "S10 must not add more") |

### C.4 Cancellation surfaces — what exists and what does NOT

| Surface | Kind | Reachable by F56-d? |
|---|---|---|
| `ProgressState.CancelForStall()` (`ghrdp-mirror-progress.cs:80`) | in-process stall abort | no — internal to the upload worker |
| `CancellationTokenSource` + `$state52.CancelForStall(); $cancel.Cancel()` (`ghrdp-mirror.ps1:827, 835, 851, 857-858, 934`) | no-byte-window cancels a transfer | no — server-side only |
| `POST /api/mirror/enable` \| `/api/mirror/disable` (`ghrdp-server.ps1:1328+`, client `src/lib/mirror.ts`) | run-level convergence, dash-token + CSRF | yes — but it is a **run-level** switch, not a per-fetch cancel |
| `/flush` (`ghrdp-server.ps1:1313`) | legacy flush | yes — not a cancellation |
| `UploadStatus 'canceled'` (`ghrdp-fx.ps1:54`, `schema.ts:5`) | enum member | **the string `cancel` occurs exactly once in `ghrdp-fx.ps1` — in that enum. No route, no worker transition, no client call ever sets it.** |
| `POST /api/fx/upload/events` (SSE) | declared in `FX_PATHS.uploadEvents` + `uploadEventsUrl()`; `endpoints.ts` says "EventSource wiring lands with S8" | **no server-side implementation exists** (`grep -rn 'upload/events' payloads/` ⇒ 0 hits) |
| per-job cancel of an F45 upload job | — | **does not exist** |

**Conclusion (read-only, no code touched):** the progress *reference* half of
Plan Assumption 3 is satisfied (`GET /api/progress` + `mirrorModel` +
`mirrorTransfer` + `UploadState`). The *cancellation* half is **not**: there is
no existing per-fetch/per-job cancellation command to delegate to. Plan §F
`operation: cancel` says it "is delegated to the existing fetch/transport
cancellation path" — that path does not exist yet. Recorded as blocker **B2**;
Assumption 3 is left open for operator decision rather than being silently
re-interpreted. Nothing in F56-a may fix this, because the fix would live in
`payloads/*.ps1` / `src/` (out of scope) and the mirror side is locked.

### C.5 Framing / cipher invariants F56-d must carry (anchors)

| Invariant | Anchor |
|---|---|
| `wire length == EncryptedSource.WireLength` | `ghrdp-mirror-progress.cs:249` `public readonly long WireLength`; `:251 GetWireLength(plainLength) => ContainerLength.Cbc(plainLength)`; `:307 override long Length => WireLength`; locked by `tests/f52-mirror-telemetry.test.js:124` |
| Content-Length framing | `Get-F53DeclaredPartLength` (`ghrdp-mirror.ps1:741`) — the container formula when the source publishes `WireLength`, never a plaintext `Length`, never an index `FileEntry.size`; `New-F46UploadContent` (`:755`) is the single multipart-framing owner |
| Container formula (F53) | `ContainerLength.CbcHeader=32`, `GcmHeader=40`; `Cbc(n) = 32 + (n/16+1)*16`; `Gcm(n) = 40 + n` |
| Ciphertext snapshot-bound | `SnapshotReadStream` (`ghrdp-mirror-progress.cs:183`) stops the encryptor at the opening snapshot so a file growing under `FileShare.ReadWrite` cannot lengthen the ciphertext |
| Mirror default-OFF | Locked Rule 5 as overridden 2026-09-29: default-OFF **except** the `Downloads` root, which is Always-ON (F51, in-memory, never writes `config.json`). Desktop/Documents/Temp/RDP-Storage keep the full `mirror_enable` + F49 modal gate |
| Push channel | `/health` answers `{ok:true, ws:false, …}` (`ghrdp-server.ps1:2808`), so `wsLive` stays false on the PowerShell dashboard and the WS `/ws` bridge never connects — F56 progress must be **poll-driven** (3 s) on that host, exactly like the mirror card |

---

## D. `roots=5` → `roots=6` (adding `D:\RDP-Storage\Fetched`) — lands in F56-d, not now

| Item | Current state (5 roots) | F56-d change (6 roots) |
|---|---|---|
| UI type | `src/components/explorer/data/schema.ts:3` — `IndexRoot = 'Downloads' \| 'Desktop' \| 'Documents' \| 'Temp' \| 'RDP-Storage'` | add the 6th member |
| UI validator | `src/components/explorer/api/endpoints.ts` — `const ROOTS = ['Downloads','Desktop','Documents','Temp','RDP-Storage']`, enforced by `assertIndexJson` and `assertFileEntry` (**an unknown root is a fail-visible `parse` error**) | must be extended in the same commit or the index fails closed |
| Server enum | `payloads/ghrdp-fx.ps1:52` — `$script:FxRoots = @('Downloads','Desktop','Documents','Temp','RDP-Storage')`; used at `:422`, `:431`, `:641` (`Get-FxMember … 'Temp'` fallback, root filter rejection) | add `Fetched` |
| Watcher roots | `payloads/ghrdp-watcher.ps1` `Get-WatcherRoots` (207) + `Get-ExtraRoots` (71) — the extra-root candidates are `Downloads`, `Downloads\qBittorrent`, `Torrents`, **`D:\RDP-Storage`**, `C:\Torrents`, plus any qBittorrent `SavePath` from the profile `.ini`; `$telemetry.roots` is emitted at `:346/503-504/512-513` and logged as `roots={4}` at `:583` | `D:\RDP-Storage\Fetched` becomes an explicit 6th root (it is currently only covered implicitly, as a child of `D:\RDP-Storage`) |
| Fixture | `src/components/explorer/data/fixtures/index-v1.json` + `5000-files.json` | regenerate in F56-d |
| Locked-rule interaction | `Test-F51DownloadsRoot` matches only `(^|\)downloads$` or `\downloads\` — `D:\RDP-Storage\Fetched` never matches, so it stays **fully gated** behind `mirror_enable` + the F49 ConfirmModal | unchanged; F56 must not turn the new root into an always-on lane |

**F56-a action: none.** All six rows above are `src/`, `payloads/*.ps1`, or
fixture files — outside this session's writable set (`docs/f56/` + the plan
file). Recorded here so F56-d inherits an exact change list instead of
re-deriving it. The Plan's "no mirror-side change" gate is unaffected: adding a
watcher root does not alter `Get-F46DefaultHost` (`enabled=false`), the F49
flags/modal, or the F51 Downloads override.

---

## E. Audit findings that constrain later phases (no code touched)

| # | Finding | Consequence |
|---|---|---|
| E1 | `payloads/search-sources/` does not exist; no `f56*` file exists anywhere in the tree | F56-b creates the directory + 27 descriptors + `own-storage.json`; F56-a only freezes the schema (`docs/f56/schema.json`) |
| E2 | No `aria2c` integration exists. The only occurrences of the string are the incomplete-download extension filters `.aria2` (`ghrdp-watcher.ps1:58`, `:431`) | Plan's "aria2c foundation" is greenfield; G1 (Chocolatey + SHA verify) is a real install step, not an upgrade |
| E3 | qBittorrent exists only as (a) a file-type/protocol handler pointing at the plain installed app (`payloads/ghrdp-provision-apps.ps1` `Get-QbittorrentProgId` / `Set-QbittorrentDefaultHandler`) and (b) a `SavePath` harvest for watcher roots. There is **no qBittorrent-nox Web API client and no Tailnet bind** anywhere | The Torrent Lane module is greenfield; G1's `qBittorrent-nox 4.6.x` is an install + a new Tailnet-only control path |
| E4 | v2 nav is `/ /sessions /connections /keys /mirror /telemetry /settings` (`src/App.tsx:33-42`, `src/components/layout/AppShell.tsx:148-154`) — there is no Runner/Explorer/Timeline/Quick-Access tree and **no command palette component in `src/`** (the palette tokens `--z-fx-palette`, `fx-palette` are F45 Explorer artifacts) | Plan §A's "existing left tree" and §D's Ctrl+K palette describe the F45 Explorer/v1 surface. F56-c must state which shell it inserts into; recorded as blocker B3 |
| E5 | `docs/search.html` already exists and is byte-identical to `docs/explorer.html` (the "GHRDP Unified Explorer" static page, Win11-Mica styling); `docs/` is a published location (`docs/.nojekyll`, `pages: write` in `main.yml`) | `docs/f56/` is a **new** published subtree. No existing file is overwritten by this PR, but the F56 name collides with a live `search.html` URL — recorded as observation B7 |
| E6 | i18n catalogues are asymmetric today: `src/i18n/en.json` = 223 leaf keys, `src/i18n/si.json` = 135 leaf keys; `fallbackLng: "en"` | Plan §H ("identical key sets", "no new F56 string may fall back silently to English") is a **new** parity gate that the existing catalogue does not satisfy; F56-c adds 206 `search.*` keys to both, and the parity check must be scoped to F56 keys or it fails on the pre-existing 88-key gap. Recorded as blocker B4 |
| E7 | `launch-gates.yml` triggers are `pull_request` + `push` only (no `workflow_dispatch`) | The post-merge launch-gates run for this PR is the `push`-triggered run on `main`; the session never dispatches it (Locked Rule 7) |
| E8 | Local clone depth is 1 (`git rev-list --count HEAD` = 1) | Merge shas `d1c747d` (PR #87, F49) and `8124647` (PR #92, F52) are not present locally; both were confirmed through the GitHub API instead |
