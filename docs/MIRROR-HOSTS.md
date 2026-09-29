# MIRROR HOSTS - the pinned gofile contract, the retry policy and the probe

F46 scope: the mirror worker must never again fail five times in the same second
with the only recorded reason being a bare `upload failed after 5 tries (all
hosts)`. Every attempt is classified, every terminal failure names its host,
phase, status and the COMPLETE host message, and the retry cadence follows the
same policy the Explorer clients use (F44/S3).

Ground truth (watcher log 2026-09-28 12:15-12:19Z): `NeatDM_setup.exe` (917340
bytes) got 5 attempts ~10 s apart, each failing inside the second it started,
and the UI error column was truncated with no host/phase/status anywhere. Mirror
uploads stay **default OFF** — with the single operator-authorized exception of
the `Downloads` root, which is **always-on** (F51 auto-upload, §11) — and the
mirror path is remediation-locked, so an attempt with no enabled host is
reported as ONE labeled fail-fast reason.

## 1. Reason visibility (F46 §1)

One structured line per attempt, from `payloads/ghrdp-mirror.ps1`
(`Format-F46AttemptLine`), used by the worker, the artifact and the UI:

```
[mirror] attempt 3 host=gofile phase=http status=429 msg=<first 200 chars, tokens redacted> ms=812
```

- `phase` vocabulary: `dns | tcp | tls | encrypt | size | type | auth | http | parse`
  plus the policy-only `policy` (no enabled host).
- Terminal failures use `Format-F46FailureSummary`:
  `[mirror] failed host=gofile phase=auth status=403 attempts=1 msg=<full>`.
- The bare `upload failed after N tries` / `FAILED after N tries` strings are
  retired; a gate fails the build if they reappear in the worker or the lib.
- `progress.json` carries the whole attempt table (`mirrorDiag.attempts`) and the
  UI error column renders `phase=… status=… msg=…` with the COMPLETE message
  (expandable, never truncated; no `slice`, no CSS truncation).
- CI ships `mirror-diag` (probe matrix + attempt table) and prints both into the
  step summary; the attempt table step runs with `if: always()`.

## 2. Retry policy (F46 §2) - identical to `src/components/explorer/api/retryPolicy.ts`

| Class | Statuses / phases | Attempts | Delay |
| --- | --- | --- | --- |
| Fail-fast | `401 / 403 / 413 / 415`, `error-token`, `error-limits`,
`error-notFound`, `error-field*`, `error-owner`, `error-notPremium`, any
`size` / `type` / `auth` / `parse` / `encrypt` / `policy` phase | **exactly 1** |
none - the reason is reported immediately |
| Transient | phases `dns` / `tcp` / `tls` / `http`, statuses `429`, `500`, `502-504` |
5 total (1 initial + 4 retries) | jittered exponential backoff |
| Success | `status=ok` with a file id/code/download page | 1 | - |

- Backoff: `min(8000, 500 * 2^attempt)` with a `100 ms` floor and full jitter.
- `Retry-After` is a **FLOOR**, clamped to `120000 ms` - the host's hint wins when
  longer, a hostile header can never park the queue. The header is honoured even
  on error responses.
- The worker makes ONE attempt per scan and schedules the next via the shared
  `Get-F46BackoffMs`; the fixed ~10 s cadence is gone (a file inside its backoff
  window is reported as `queued` with the reason, and no network call is made).
- **Attempt 0 (preflight, zero network tries)**: `mirrorHosts[].maxFileBytes` and
  `mirrorHosts[].blockedExtensions` are evaluated before any upload request. F52
  fills the cap from the cached read-only `GET /servers` matrix;
  a violation is reported as `phase=size` / `phase=type` with `0` network tries.
- Encryption requested but unavailable, a `phase=auth` refusal (F48: the host
  requires an account token and token-less mode is unsupported) and "no enabled
  host" are all terminal, single-attempt, labeled reasons - failures are never
  silent and never blind-retried.

## 3. Documented gofile API contract (F46 §3, token-less per F48 §0)

Fetched from <https://gofile.io/api> on 2026-09-28 and pinned in
`payloads/ghrdp-mirror.ps1` (`$script:F46GofileContract`). **[F48] TOKEN-LESS
GUEST MODE: the upload contract has no credential of any kind.** No
`Authorization`, no `X-Gofile-Token`, no `Cookie` header is ever attached to a
host request, nothing token-shaped travels in a URL, and no account token is
read, minted, stored or rendered anywhere in this system. The previous
account-minting rung (`POST /accounts` -> token) and every token config/file/env
rung were deleted; a CI gate fails the build if any of them reappears.

- **`GET https://api.gofile.io/servers`** -> `data.servers[].name`: the
  read-only probe endpoint (unauthenticated) and the documented two-step upload
  flow (host config `uploadHostMode='fleet'`).
- **Upload (guest contract)** - multipart/form-data, field name **`file`**,
  optional `folderId`, **no request header beyond `Accept`**:
  - current reference (default, `uploadHostMode='auto'`):
    `POST https://upload.gofile.io/uploadfile`. Uploads do not go to
    `api.gofile.io`; the fleet routes the file to the closest store. The
    regional hosts (`upload-eu-par`, `upload-na-phx`, `upload-na-nyc`,
    `upload-ap-sgp`, `upload-ap-hkg`, `upload-ap-tyo`, `upload-ap-syd`,
    `upload-sa-sao`) pin a region by hostname and are an operator config choice,
    never something the worker switches between;
  - fleet form (`uploadHostMode='fleet'`):
    `POST https://<server>.gofile.io/contents/uploadfile`.
- **Probe procedure (F48 §2)**: a read-only, unauthenticated
  `GET <apiRoot>/servers` per configured host records `{host, status, note}`
  (never a body parse, never an upload). The FIRST real upload attempt is also
  unauthenticated: `status=ok` -> a guest success row with the `downloadPage`
  link and `authMode=guest`; `401/403` -> **exactly ONE attempt** with
  `phase=auth` and the labeled reason
  `host requires account token; token-less mode unsupported` plus the operator
  options below - **no retry loop on auth, ever**. The result is what sets
  `authMode='guest' | 'requires-account'`; it is never derived from any secret
  (none exists).
- **Response data** (current reference): `id`, `type`, `name`, `parentFolder`,
  `parentFolderCode`, **`downloadPage`**, `code`, `size`, `md5`, `mimetype`,
  `createTime`, `modTime`, `servers[]`. The legacy form returned `fileId` and
  `directLink`; the parser accepts both (`idFields`, `pageFields`) - the previous
  code read only `fileId`/`directLink` and therefore recorded a "success" with an
  empty id and link on the current API.
- **Always branch on the `status` envelope**: some endpoints answer HTTP 200 with
  `status=error-*`. Documented statuses: `error-token` (401), `error-accountId`
  (403), `error-notPremium` (401), `error-rateLimit` (429), `error-limits` (403),
  `error-notFound` (404), `error-owner`/`error-notOwner` (401), `error-field`
  (400). No envelope + non-2xx = a labeled HTTP failure; `status=ok` with no
  id/code/download page = `phase=parse` (never a silent success).
- Free accounts cap at 10,000 stored contents; rate limits are per endpoint per
  IP **and** per account - back off, never switch identity.

Legitimate documented usage only: no User-Agent spoofing, no proxy or IP
switching, no header spoofing, no block-evasion tricks, no token in a URL, no
credential in a log or artifact. A gate fails the build on those patterns.

## 4. Encryption honesty (F46 §4, made real by F47 §3)

- The worker reports the encryption that ACTUALLY happened (`encrypted=false`
  for a plaintext upload; the flag is never inferred from `encryptMode`).
- **F52: encryption is the default, and streams with the socket.** Auto-upload
  and runtime opt-in ALWAYS use the per-run 32-byte key with
  `AES-256-CBC-PBKDF2` (salt(16) + iv(16) + AES-256-CBC over
  PBKDF2-SHA256(key, salt, 100000), the existing `.ghenc` form). The source is a
  bounded pull stream: no full-file byte array and no ciphertext staging file.
  Its length is `32 + 16 * (floor(plainBytes / 16) + 1)`, computed in Int64.
  CBC is not authenticated GCM, and is labeled CBC, never GCM. The existing
  GCM container remains readable by the legacy decrypt helper; the runner's
  `Test-F46AesGcmUsable` self-test remains available for legacy compatibility.
- Only an explicit `mirror_encrypt=false` dispatch elects manual plaintext;
  `media-plain` and missing/old `encryptMode=none` are NOT plaintext elections.
- Algorithm and actual mode are recorded per file and attempt. A malformed or
  missing key/encryptor yields a single `phase=encrypt` refusal, never fallback.
- Encrypted parts are uploaded with the part mime
  **`application/x-ghrdp-mirror`** (already in the Explorer preview allowlist),
  and the display name gains the `.ghenc` suffix (the legacy Explorer decrypt
  path). Plaintext uploads keep `application/octet-stream`.
- If the key is missing or no AES-256 encryptor can be constructed, the attempt
  is refused with `phase=encrypt status=- msg=… refusing to upload plaintext` -
  it never uploads plaintext behind an "AES-256" card.
- The Mirror card derives its title from the reported mode: "Mirror - plaintext
  runner upload (no AES-256)" unless the worker reports encrypted rows, in which
  case it reads "Mirror - AES-256 encrypted runner upload" and names the
  algorithm; a DOM test pins title/worker parity, so the UI cannot overclaim.
- The key lives ONLY in runner-local config `mirrorKey` (no UI reveal/copy) and is in
  the log-redaction set: it never appears in a log line, attempt record,
  artifact, UI or URL. [F48] There is **no gofile token at all** in this system -
  the mirror is token-less guest mode end to end (§9).

## 5. Read-only host probe (F46 §5)

`Invoke-F46HostProbe` performs a read-only `GET` of the API root
(`/servers`) per configured host - no credential, no upload, no body parsing -
and yields a `{host, status, note}` matrix rendered by `Format-F46ProbeTable`:

| host | status | note |
| --- | --- | --- |
| `gofile` | `200` | read-only GET /servers reachable; upload flow is documented + enabled=False |
| `gofile` | `403` | runner egress rejected (403) - token-less guest probe refused (authMode=requires-account); policy/endpoint level rejection; operator option: operator-owned VPS egress (no evasion) |
| `gofile` | `-` | transport failure: NameResolutionFailure - … |

Where it appears: the CI step summary + `mirror-diag` artifact (every dispatch,
`main.yml`), and the Diagnose drawer (`/diag` -> `mirrorHosts`,
`mirrorAttempts`, `mirrorPolicy`) on the runner itself.

**All-403 from the runner egress is a policy dead-end, not a puzzle.** The two
honest operator options are: (a) run the mirror upload from an operator-owned VPS
egress that the operator configures themselves, or (b) accept that the mirror is
unavailable from ephemeral runners and leave it off. No evasion is permitted.

## 6. Host configuration (`config.json`)

```json
{
  "mirrorHosts": [
    {
      "id": "gofile",
      "displayName": "gofile.io",
      "apiRoot": "https://api.gofile.io",
      "uploadHostMode": "auto",
      "uploadHost": "upload.gofile.io",
      "uploadPath": "/uploadfile",
      "enabled": false,
      "maxFileBytes": null,
      "blockedExtensions": [],
      "authMode": "guest",
      "timeoutSec": 120
    }
  ]
}
```

`enabled=false` is the shipped default (mirror OFF, unchanged CI gate).
`authMode` is `'guest' | 'requires-account'` and is set **only** by a probe or
first-attempt result (401/403 flips it), never by the presence of any secret -
no token field exists in this schema. `maxFileBytes`
null (and legacy 0) means **unknown cap**, never a proven unlimited host.
`blockedExtensions` empty means "no blocked types". The cached host matrix
provides any explicitly advertised cap; a smaller manual config limit is still
honored. No client-side size cap is added to the Downloads auto lane.

## 7. Proof (F46 §6)

- `tests/f46-mirror-policy.ps1` (Windows lane) drives the shipped module with a
  mock transport: 403/413/415 => exactly 1 attempt; 429/500/502/tls-reset =>
  policy backoff retries; preflight size/type => 1 attempt with 0 network tries;
  the full-length host message is preserved while the log line keeps its 200-char
  copy; the current + legacy response bodies parse; the envelope wins over HTTP
  200; the probe matrix renders. The one real probe is a read-only GET.
- `tests/f46-mirror-contract.test.js` (Node) pins the policy parity with
  `retryPolicy.ts`, the contract fields, the watcher's structured lines, the
  default-OFF rule, the staging/lane wiring and the evasion bans.
- `src/components/explorer/data/fixtures/gofile-mock-server/handlers.ts`
  (MSW) models the same token-less flow for the client lane:
  `GET /servers` -> `data.servers[].name`, the guest upload paths
  (`upload.gofile.io/uploadfile` and `<server>/contents/uploadfile`) with
  **no auth header on the request** (request inspection), `id` +
  `downloadPage`, the legacy `fileId`/`directLink` alias, and the policy matrix
  (401/403 fail-fast, 413/415, 429/500/502 retries plus `tls-reset` as a
  transport rejection).
  `src/tests/smoke/fx-gofile-mock.test.tsx` exercises all of it; no real call.
- `src/tests/smoke/f46-mirror-truth.test.tsx` renders the shipped Mirror card
  against worker payloads and asserts the untruncated reason column and the
  title/`encrypted` parity.

## 8. Operator verification (token-less)

1. Secret hygiene first (F48 §4): delete the former mirror-host account-token
   secret from repo `Settings > Secrets and variables > Actions` **and**
   invalidate that token on the host account page (treated as compromised).
   Confirm both before dispatching. The workflow reads NO mirror secret.
2. Dispatch `main.yml` with `mirror_enable=true` (encryption defaults on; only explicit
   `mirror_encrypt=false` elects manual plaintext); read the `F46 mirror host probe` matrix in the step summary.
3. Open the Mirror page: the **Mirror host matrix** card renders the same
   `{host,status,note}` rows live from `/diag` (`mirrorHosts`, token-less guest
   mode), and the Diagnose drawer carries them plus the worker's attempt table
   (`mirrorAttempts`).
4. Click **Upload everything now** once and upload ONE small benign `.txt`.
   With the mirror disabled the ConfirmModal opens FIRST (§10); choose
   **[Enable & Upload]** (enable+flush in one action for this run only).
5. Expect either a guest success row with a `downloadPage` link, or ONE labeled
   reason (`phase=… status=… msg=…`) - e.g.
   `host requires account token; token-less mode unsupported` with the operator
   options rendered - never "failed after 5 tries" without a cause.
6. Paste the `[mirror]` attempt lines including the
   `[mirror] RUNTIME OPT-IN:` ledger line (live log / `/api/progress` log).

## 9. F48 token-less guest mode (per-run opt-in stays, tokens are gone)

Mirror default-OFF is a locked gate: the shipped `Get-F46DefaultHost` keeps
`enabled=false` and the CI gate that forbids a default-ON mirror is unchanged.
Enabling the mirror is **operator intent expressed per dispatch**:

| Input | Default | Effect |
| --- | --- | --- |
| `mirror_enable` | `false` | `true` writes `mirrorHosts[0].enabled=true` into `config.json` **for this run only** (enabled flag + host id, nothing else). |
| `mirror_encrypt` | `true` (F52) | Explicit `false` elects manual plaintext + banner. Every run gets a runner-local 32-byte key; auto/runtime always encrypt (§4). |

**No token anywhere (operator directive, binding).** Every gofile API token
plumbing path was deleted: no repository secret read, no step or process
environment variable, no config key, no token file, no auth header, no UI field.
A **missing credential is the NORMAL state** - the stage step never halts on it
(the F47 fail-closed halt is removed) and uploads use only the anonymous guest
contract. CI gates fail the build if the banished secret name, an
`Authorization` / `X-Gofile-Token` / `Cookie` header targeting the host, or a
missing-token staging halt ever reappears.

**Probe-first, fail-fast (§2).** The probe is an unauthenticated read-only
`GET /servers`; the first real upload is unauthenticated. `status=ok` records a
guest row with the link (`authMode=guest`); `401/403` records exactly ONE
attempt with `phase=auth`, the reason `host requires account token;
token-less mode unsupported` and the operator options. There is no retry loop
on auth.

**Operator options when the host refuses token-less uploads:**
1. **Disable the mirror** (`mirror_enable=false`) - nothing is attempted.
2. **Self-hosted operator target** - point `mirrorHosts[0]` at an upload
   endpoint you own and control (e.g. an operator-owned VPS).
3. **Token mode** - a **separate future decision, explicitly out of scope
   here**; this build never accepts, prints or stores a host token.

**Where the truth is rendered.** The dispatch step summary prints the probe
matrix plus `mirror opt-in for THIS run: token-less guest mode …`; the Mirror
page renders the same rows from `/diag`; the `mirror-diag` artifact keeps both
tables.

**If every probe row is blocked from the runner egress (403)**, that is a policy
dead-end with honest options - run the upload from an operator-owned VPS egress
you configure yourself, or accept the mirror as unavailable from ephemeral
runners and leave `mirror_enable=false`. Nothing in this repository
attempts to work around a host policy.

## 10. F49 one-click runtime opt-in (this-run scope, token-less)

The dispatch `mirror_enable` path (§9) is unchanged; F49 adds the second,
operator-clicked path for a run that dispatched with the mirror OFF:

1. The Mirror page shows the **disabled banner** while the mirror is off
   (`GET /api/mirror/status` says `enabled=false`).
2. Clicking **Upload everything now** while disabled opens the **ConfirmModal
   FIRST** (focus-trapped, Escape-dismissible, `role=dialog`).
3. **[Enable & Upload]** POSTs `/api/mirror/enable` (dash token in
   `X-Dash-Token` + per-process `X-CSRF-Token`) and is enable+flush in ONE
   action: the server converges `config.json` (`mirror=true`,
   `mirrorHosts[0].enabled=true`, the `mirrorRuntimeOptIn` marker), writes the
   `mirror-optin-beacon.json` beacon, and queues both the opt-in flag and the
   flush flag. The watcher applies the flags on its next pass and stamps the
   `[mirror] RUNTIME OPT-IN: …` ledger line.
4. The attempt rows then show `host=gofile` with phase progress, ending in
   either a success row with a link or exactly one labeled reason (§8 step 5).
5. `POST /api/mirror/disable` reverts to default-off (mirror=false, every host
   disabled, marker + beacon removed); the watcher ledgers the clear.

Scope is **this run only** on both paths: the runner is ephemeral, so a
`config.json` write can never outlive the run; the shipped code default stays
`enabled=false`. The API lives on the always-on PowerShell dashboard (7331);
a page served from the real-time Rust dashboard (7332) reaches across
explicitly. The guest contract is unchanged: no `Authorization`, no
`X-Gofile-Token`, no `Cookie` toward the host, ever.

## 11. F51 ALWAYS-ON DOWNLOADS AUTO-UPLOAD + F50 STREAMING TRANSPORT

**The rule (canonical).** `PROJECT-CONTEXT-v2-CANONICAL.md` Section 6, Rule 5
now reads: "Mirror is default-OFF, EXCEPT for the `Downloads` root which is
Always-ON (Auto-upload)." This is an operator-authorized override of the
formerly blanket default-OFF lock, for the `Downloads` root only.

### 11.1 What auto-uploads (F51)

- Any file that lands in the **Downloads root** — the profile `Downloads`
  folder, the shell-known Downloads library, and anything nested inside a
  Downloads family folder such as `Downloads\qBittorrent` or a qBittorrent
  `SavePath` under it — is queued for mirror upload **automatically**, without
  `mirror_enable=true` in `main.yml` and without the F49 runtime opt-in
  (the ConfirmModal is not required for these files).
- **Still fully opt-in** (dispatch input or the F49 one-click modal):
  `Desktop`, `Documents`, `Temp`, `RDP-Storage`, and every other root.
- The override is **in-memory, this run only**: `config.json` keeps
  `mirror=false` on disk, the `mirror-optin-beacon.json` and the
  `mirror-enable.flag` / `mirror-disable.flag` channels are untouched, and
  disabling via the F49 modal still governs every non-Downloads root. When the
  mirror was never opted in, the auto path attempts with the documented gofile
  **guest** host enabled in memory (`New-F51AutoHost`) — no credential exists
  anywhere (F48).
- Per-host policy still applies to auto files: preflight size/type refusals
  (`mirrorHosts[].maxFileBytes` / `blockedExtensions`) cost **zero network
  tries**, and every attempt is classified + retried under the F44 policy
  exactly like an opted-in file.

**Ledger lines** (the watcher log, also in `mirrorDiag`):

```
[mirror] F51 AUTO-UPLOAD: 2 file(s) in the Downloads root queued automatically (always-on; opt-in not required)
[mirror] AUTO-UPLOAD: invoice.pdf (Downloads root; F51 always-on, opt-in not required)
[mirror] F51 AUTO: Downloads root always-on override applied (host=gofile, guest, this run only; config.json mirror stays false)
```

`mirrorDiag.autoUpload` is `downloads-always-on` while the override drives the
worker and `opt-in` under a full opt-in; `autoRoots` + `autoQueued` carry the
classified roots and the per-file count.

### 11.2 How large files travel (F50)

The upload path is **streamed**: `Send-F46GofileUpload` posts with
`HttpClient` + `MultipartFormDataContent` + `StreamContent(FileStream)`. The
file is never materialised in memory — no whole-file byte array, no buffering
request stream. (The previous `HttpWebRequest` path relied on the in-box
request buffering, whose 2GB ceiling surfaced on the runner as the error
`Stream was too long`; multi-GB uploads now move in bounded chunks straight
from the `FileStream`.) The wire contract is byte-identical: multipart field
`file`, part Content-Type `application/octet-stream` (or
`application/x-ghrdp-mirror` when encrypted), no auth header of any kind.

**F44 policy is preserved verbatim**: fail-fast `401/403/413/415` get exactly
one attempt, only `dns | tcp | tls | http` are retried, backoff is jittered
with a `Retry-After` hint as a FLOOR capped at 120s, and the F48/F49 contracts
are untouched.

### 11.3 Lab proof (windows-native lane, `tests/f46-mirror-policy.ps1`)

- Sparse files created with `fsutil file createnew` at **100 MB / 1 GB / 3 GB /
  6 GB** are streamed by the shipped uploader into a **discarding loopback
  listener** that counts (never stores) the body bytes; 6 GB lands above the
  old 2GB ceiling with the full byte count accounted for.
- Real-transport retry cells: `429` (with a `Retry-After` floor), `500`, `502`
  and a refused connection are classified and retried to the policy budget;
  `tls-reset` stays covered by the mock scenario matrix.
- Preflight refusals (size / type) are proven with **zero network tries**.
- F51 cells execute the REAL watcher helpers (extracted, never copied): a
  simulated download into `Downloads` auto-queues and attempts without any
  opt-in state, while Desktop/Documents/Temp/RDP-Storage files stay gated, and
  the F49 modal contract is asserted untouched.


## 12. F52 HONEST TELEMETRY, Int64 streams and guest-cap reality

**Socket truth.** `StreamContent` is wrapped at its outgoing destination. Only
successful payload `Write` + `Flush` completions increment `bytesSent` (Int64);
file reads, encryption, scans, multipart framing and attempted/failed flushes
never do. This measures bytes handed to the socket, NOT host acceptance. Live
samples are published while `SendAsync` is pending, to `mirrorDiag.progress`,
`/mirror` and `/api/progress`; classic and v2 cards poll every 3s (plus existing
WebSocket push). Counts above 9,007,199,254,740,991 are decimal JSON strings;
BigInt subtraction/ratios keep the cards exact before human-unit formatting.

**Stall semantics.** Speed is the payload-byte delta over a bounded 60s rolling
window (one-second samples), not smoothed scan/completion jumps. ETA exists ONLY
with a positive window delta; otherwise both row and header show
`stalled (no bytes in <N>s)` and ETA is hidden. The window clock is monotonic.
At each 60s no-byte window a structured `host/phase=http/status/ms/msg` stall
record is emitted. Three such windows cancel/classify that attempt as failed
`phase=http`, retaining the last socket/host text. The F44 transient-only
five-attempt budget, jitter and Retry-After floor/cap are byte-for-byte unchanged.
A whole-request 120s timeout is not used as a hidden large-file cap. Active and
done rows override “Waiting for first upload”; retry rows are upserted rather
than accumulating stale active copies. Bytes/size drive progress percentages.

**Guest cap is evidence, not a promise.** An explicit byte-valued
`maxFileBytes` in a successful, unauthenticated `GET /servers` envelope is an
ADVERTISED cap. Fleet mode uses the first usable server (no rotation); the
automatic endpoint uses a global cap or unanimous explicit per-server caps.
Absent/mixed caps stay null (unknown), so the stream may be attempted. Before
upload, a known cap below the exact wire length produces `phase=size`,
`network=0` and that exact cap in `hostMessage`. The read-only matrix always
keeps `maxProvenBytes=null`: a GET cannot prove upload acceptance. Likewise,
128 GiB loopback success does NOT prove a 128 GiB guest-host cap. If host-cap
proof is below the 100 GB target (100,000,000,000 bytes), STOP; operator options
are **self-hosted target for that size class | accept the cap**. No identity
spoofing, proxy, rotation, account auth or tokens. F48 GATE1–3 remain zero-hit.
Sandbox probe on 2026-09-29: TLS EOF before HTTP; advertised cap and upload-proven
cap both unknown. The Windows lab records a separate read-only runner verdict.

**Auto-upload rule and plaintext election.** Any completed/stable RDP download
into the Downloads root (including Downloads subfolders and sub-512-byte files)
auto-queues without opt-in, even when the other roots are disabled. No client
size cap; encryption is an on-demand bounded stream, including 100 GB+ lengths.
Desktop/Documents/Temp/RDP-Storage retain the full opt-in gate. Every Downloads
attempt encrypts with the per-run key and reports worker `encryptMode=all` in
its row and structured attempt. Runtime opt-in converges to `all` as well.
Explicit `mirror_encrypt=false` dispatch is manual-lane-only and renders:
`PLAINTEXT ELECTED: mirror_encrypt=false dispatch — manual lane only. Downloads auto-upload and runtime opt-in always encrypt.`
No runtime or automatic plaintext fallback is allowed. The key never enters
URLs, logs, UI, public snapshots, indexes or artifacts; only runner-local config
and cryptographic memory hold it.

**Lab cells.** `tests/f52-mirror-telemetry.ps1` streams fsutil-marked sparse
8/64/128 GiB files (8,589,934,592 / 68,719,476,736 / 137,438,953,472 bytes) into a
discarding loopback receiver. It checks counter/drain parity, monotonic samples,
bounded socket lead, failed-flush=0, 60s window/180s classification, a genuinely
frozen socket (loopback-only shortened clock), cap refusal with network=0,
streamed encrypted Downloads trigger, mode labels and secret-free records.
Windows PowerShell 5.1 runs the small compatibility cell separately; CI never
skips the full pwsh sparse matrix. Node classic-DOM and Vitest v2-DOM frozen-byte
cells require a stall label, hidden ETA and truthful headers. Host acceptance
and the >4 GB live Downloads/operator verification remain PENDING-USER. The
session never dispatches `main.yml` or claims the final LIVE line before those
operator confirmations.
