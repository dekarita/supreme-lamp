# MIRROR HOSTS - the pinned gofile contract, the retry policy and the probe

F46 scope: the mirror worker must never again fail five times in the same second
with the only recorded reason being a bare `upload failed after 5 tries (all
hosts)`. Every attempt is classified, every terminal failure names its host,
phase, status and the COMPLETE host message, and the retry cadence follows the
same policy the Explorer clients use (F44/S3).

Ground truth (watcher log 2026-09-28 12:15-12:19Z): `NeatDM_setup.exe` (917340
bytes) got 5 attempts ~10 s apart, each failing inside the second it started,
and the UI error column was truncated with no host/phase/status anywhere. Mirror
uploads stay **default OFF**; the mirror path is remediation-locked, so an
attempt with no enabled host is reported as ONE labeled fail-fast reason.

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
  `mirrorHosts[].blockedExtensions` are evaluated from config before any request;
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
- **F47: the documented AES-256 mode now exists.** `mirror_encrypt=true` at
  dispatch (or `encryptMode=all|media-plain` in config) makes the worker encrypt
  each file with a per-run 32-byte key before upload:
  - `AES-256-GCM` - preferred. Container: `GHRDPMIR` + ver + alg + nonce(12) +
    tag(16) + ciphertext. Availability is PROVEN per runner by a real
    encrypt/decrypt self-test (`Test-F46AesGcmUsable`), never assumed.
  - `AES-256-CBC-PBKDF2` - fallback when the runner's .NET cannot bind
    `AesGcm`, **and the only mode above the F50 one-shot cap (§11.4)**.
    Container: salt(16) + iv(16) + AES-256-CBC over
    PBKDF2-SHA256(key, salt, 100000) - byte-identical to the legacy `.ghenc`
    form, so `docs/decrypt.html` and the web index decrypt it in the browser.
    [F50] written by a chunked `FileStream -> CryptoStream -> FileStream` loop
    (64 KiB), so the working set is constant at any file size.
  - Which algorithm ran is recorded per file (`encAlg`) and printed in the
    attempt table; a 32-byte key length is asserted, a shorter key is refused.
  - [F50] `Invoke-F46EncryptFile` / `Invoke-F46DecryptFile` also return
    `mode` = `one-shot` (GCM, whole file in arrays, only up to the 1 GiB cap),
    `streamed` (CBC, chunked, any size) or `refused-too-large` (a GCM container
    above the decrypt cap); the F50 lab pins all three. What the worker surfaces
    is still `alg`, and it is the truth: `[mirror] encrypted <name> -> <bytes>
    bytes alg=<the algorithm that ran> ...`, `progress.json`
    `mirrorDiag.encAlg`, and the card's `encryptAlg` all read that value - a
    large file is never labeled GCM because GCM was requested.
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
- The key lives in config `mirrorKey` (masked + copy in the Keys card) and is in
  the log-redaction set: it never appears in a log line, attempt record,
  artifact or URL. [F48] There is **no gofile token at all** in this system -
  the mirror is token-less guest mode end to end (§9).

## 5. Read-only host probe (F46 §5)

`Invoke-F46HostProbe` performs a read-only `GET` of the API root
(`/servers`) per configured host - no credential, no upload, no body parsing -
and yields a `{host, status, note}` matrix rendered by `Format-F46ProbeTable`:

| host | status | note |
| --- | --- | --- |
| `gofile` | `200` | read-only GET /servers reachable; upload flow is documented + enabled=False |
| `gofile` | `403` | runner egress rejected (403) - token-less guest probe refused (authMode=requires-account); policy/endpoint level rejection; operator option: operator-owned VPS egress (no evasion) |
| `gofile` | `-` | transport failure: dns - dns resolution failed (HostNotFound): … |

[F50] the probe rides the same streaming `HttpClient` as the uploader, so a
transport failure now reports the F44 **phase** (`dns` / `tcp` / `tls` / `http`)
plus the inner reason instead of a `WebExceptionStatus` name. Every other note
above is verbatim unchanged.

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
      "maxFileBytes": 0,
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
0 means "no cap", `blockedExtensions` empty means "no blocked types" - both are
operator policy knobs, not invented defaults.

## 7. Proof (F46 §6)

- `tests/f46-mirror-policy.ps1` (Windows lane) drives the shipped module with a
  mock transport: 403/413/415 => exactly 1 attempt; 429/500/502/tls-reset =>
  policy backoff retries; preflight size/type => 1 attempt with 0 network tries;
  the full-length host message is preserved while the log line keeps its 200-char
  copy; the current + legacy response bodies parse; the envelope wins over HTTP
  200; the probe matrix renders. The one real probe is a read-only GET.
- [F50] `tests/f50-mirror-largefile.ps1` (Windows lane) drives the shipped
  module over loopback with **real multi-GB payloads**: the reported
  `Stream was too long.` symptom is reproduced from first principles, then
  100 MB / 1 GB / 3 GB / 6 GB sparse files are streamed through a discarding
  listener with the uploader's peak working set bounded far below the file size,
  the streamed CBC container round-trips above the GCM cap (SHA-256 equal), the
  over-cap GCM container is refused honestly, 429/500/502 retry with the exact
  deterministic jitter sequence and a `Retry-After` floor, a TLS-handshake reset
  and a TCP refusal are classified as transients, 403/413/415 fail fast in ONE
  attempt with the complete host message, and preflight size/type refusals prove
  ZERO network tries. Every cell prints `CELL=/EXPECT=/OBSERVED=/RESULT=`.
- [F50] `tests/f50-mirror-largefile.test.js` (Node) pins the same contract
  offline: the buffering transport is retired from code lines, the streaming
  transport + pinned part headers are present, the timeout-floor arithmetic is
  recomputed from the constants in the module, the streamed crypto paths carry
  no whole-file array, the F44 constants are byte-for-byte unchanged, both lanes
  and both structural audits are wired, and the guest/default-OFF locks hold.
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
2. Dispatch `main.yml` with `mirror_enable=true` (+ `mirror_encrypt=true` if you
   want AES-256); read the `F46 mirror host probe` matrix in the step summary.
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
| `mirror_encrypt` | `false` | `true` sets `encryptMode=all` and generates the per-run 32-byte `mirrorKey` (§4). |

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

## 11. F50 large-file streaming (the `Stream was too long.` fix)

### 11.1 Symptom and root cause (two 2 GiB walls, not one)

The watcher ledger line was:

```
phase=http status=- msg=upload failed: Exception calling "Write" with "3" argument(s): "Stream was too long."
```

- **Wall 1 - the upload.** `Send-F46GofileUpload` already copied the file
  through a 64 KiB `FileStream` loop, but into
  `HttpWebRequest.GetRequestStream()` with the .NET default
  `AllowWriteStreamBuffering = true`. That default assembles the **entire
  multipart body in a `MemoryStream`** before the first byte reaches the socket,
  and a `MemoryStream` cannot grow past `Int32.MaxValue` (2 GiB) - which is
  exactly where `Write(byte[], int, int)` throws `Stream was too long.`. The
  phase was reported as `http` with `status=-` because the throw happened inside
  the generic catch, after zero bytes had been sent: a 6 GiB file never even
  started uploading.
- **Wall 2 - the encryptor.** `Invoke-F46EncryptFile` did
  `[IO.File]::ReadAllBytes($Path)` + `New-Object byte[] $plain.Length` for the
  ciphertext + a `List[byte]` container + `ToArray()`: four whole-file
  allocations (~4x the file size), so a multi-GB file died at `phase=encrypt`
  before it ever reached wall 1.

### 11.2 The transport now (F50 §1)

`HttpClient` + `MultipartFormDataContent` + `StreamContent(FileStream)`,
constructed by `New-F50HttpClient` / used by `Send-F46GofileUpload`:

- The file is opened `[IO.File]::Open(Read, FileShare::ReadWrite)` and handed to
  `StreamContent` with a 64 KiB buffer (`$script:F50StreamBufferBytes`). Nothing
  is ever buffered in one blob; `HttpWebRequest` is retired module-wide (the
  fleet `/servers` lookup and the read-only probe now ride the same client).
- **The part headers are pinned, not left to the runtime.** .NET Framework
  (Windows PowerShell 5.1 - the production runner) quotes `name="file"`, .NET 8
  (pwsh - the hosted lab lane) does not, so `New-F46UploadRequestSpec` exposes
  the exact `partDisposition` / `partContentType` strings and the uploader writes
  them with `TryAddWithoutValidation`. The lab asserts the wire bytes equal the
  spec at every size, so the contract cannot drift between lanes.
- Requests stay **length-based** (`Content-Length` from the exact `FileStream`
  length), which is what the pinned guest endpoint expects. Chunked transfer
  encoding is used only when no length can be determined at all, and only if
  `$script:F50AllowChunkedTransfer` is true (it is false for the pinned host).
- `Expect: 100-continue` is requested, so a host that will refuse (413/415/403)
  can say so **before** a multi-GB body is pushed at it.
- [F48/F49] The client carries `Accept` only. There is no credential plumbing to
  remove: no auth header, no host-token header, no session state toward the host,
  nothing in a URL, no proxy/user-agent/rotation manipulation. The handler is
  created per attempt and disposed with it, so no host-supplied session state can
  ride into the next attempt.
- A runner that cannot bind `System.Net.Http` gets a labeled terminal
  `phase=parse` reason - never a silent downgrade to a buffering transport.

### 11.3 Size-aware timeout floor (F50 §1)

`HttpClient.Timeout` covers the **whole** request, body included - unlike the
retired `HttpWebRequest.ReadWriteTimeout`, which was per-write. Keeping the old
120 s setting would have made every multi-GB upload fail with a timeout, so the
configured per-host `timeoutSec` is now a **floor**, not a cap
(`Get-F50UploadTimeoutSec`): `max(configured, ceil(size / 2 MiB per second))`,
capped at 6 h.

| File size | `timeoutSec` in config | Timeout actually used |
| --- | --- | --- |
| 100 MiB | 120 | 120 s (floor 50 s loses) |
| 1 GiB | 120 | 512 s |
| 3 GiB | 120 | 1536 s |
| 6 GiB | 120 | **3072 s** |
| 1 TiB | 120 | 21600 s (capped) |

### 11.4 AES-256 containers by size (F50 §2)

| File size | Container | `alg` | `mode` | Working set |
| --- | --- | --- | --- | --- |
| <= 1 GiB and `AesGcm` usable | `GHRDPMIR` + ver + alg + nonce(12) + tag(16) + ct | `AES-256-GCM` | `one-shot` | ~4x file (bounded by the cap) |
| > 1 GiB (`$script:F50GcmOneShotMaxBytes`), or no `AesGcm` | salt(16) + iv(16) + AES-256-CBC(PBKDF2-SHA256) | `AES-256-CBC-PBKDF2` | `streamed` | O(64 KiB) |

- The streamed container is **byte-identical to the legacy `.ghenc` form**, so
  `docs/decrypt.html` and `payloads/web-index-template.html` still open it in the
  browser. That is why the size crossover uses CBC rather than a new chunked-GCM
  container: a new format would not be browser-decryptable.
- Decryption is streamed for the CBC container at any size. A GCM container is
  still one-shot (.NET's `AesGcm` API has no streaming form), so it is bounded by
  `$script:F50GcmDecryptMaxBytes` (2 GiB - 2) and **refuses honestly** above it
  (`mode=refused-too-large`, naming the cap) instead of dying with
  `Stream was too long.`. Only a pre-F50 build could have produced such a
  container.
- A wrong key never leaves a half-decrypted file behind: the partial output is
  removed when the padding/auth check fails.
- Plaintext is still never uploaded: a missing key or unavailable encryptor is
  the same terminal `phase=encrypt` refusal as before.

### 11.5 What did NOT change

The F44 attempt policy is byte-for-byte identical on the new transport:
fail-fast `401/403/413/415` = exactly ONE attempt; only `dns/tcp/tls/http` are
retried (5 total); jittered exponential backoff `min(8000, 500 * 2^n)` with a
100 ms floor; `Retry-After` honoured as a **floor** clamped to 120 s; preflight
`phase=size|type` refusals with **zero** network tries; complete, untruncated
host messages; mirror **default-OFF**; token-less guest ladder only. Transport
exceptions are mapped to the same phase vocabulary by `Get-F50TransportPhase`
(walking the inner chain, because `HttpClient` wraps socket/TLS causes).

### 11.6 How the lab proves multi-GB sizes on a hosted runner

`tests/f50-mirror-largefile.ps1` never contacts a real host and never allocates
a multi-GB array:

- **Sparse sources.** `fsutil sparse setflag` + `FileStream.SetLength` give a
  file whose logical length is the real 100 MB / 1 GB / 3 GB / 6 GB value while
  the allocation stays near zero (cell `C1` proves the mechanism, and reports the
  measured allocation delta, before any cell depends on it).
- **Discarding listener.** A loopback `HttpListener` counts every byte and keeps
  only the first 8 KiB (for the part-header contract), so a 6 GiB upload costs no
  disk. The encrypted round-trip cell is the only one that writes real bytes
  (~1 GiB ciphertext + ~1 GiB plaintext) and it checks free space first.
- **Memory ceiling, measured not guessed.** Cell `C2` records the peak working
  set of a process that only dot-sources the module; every size cell then
  requires the uploader's `PeakWorkingSet64` to stay under
  `baseline + max(128 MiB, size/8)`. A whole-file blob would exceed that at
  1 GiB and would throw at 6 GiB, so the assertion discriminates at every scale.
- **Deterministic retries.** The `Sleeper` is injected and the jitter is fixed
  (`-Rand01 0.5`), so the backoff sequence is asserted exactly:
  `300,550,1050,2050` ms, and `1000,1000,1050,2050` ms when the host sends
  `Retry-After: 1` (the floor wins over the jitter).

### 11.7 Operator verification (F50)

1. Mirror stays **default-OFF**; enable it per run (dispatch `mirror_enable=true`,
   or the one-click runtime opt-in in §10). Add `mirror_encrypt=true` to exercise
   the streamed container.
2. Queue ONE benign large file (the size class you actually mirror) and click
   **Upload everything now**.
3. Expect a `[mirror] encrypted <name> -> <bytes> bytes alg=AES-256-CBC-PBKDF2
   mime=application/x-ghrdp-mirror key=redacted(32B, config mirrorKey)` line for
   a file above the 1 GiB cap (or `alg=AES-256-GCM` below it), then attempt rows
   ending in a success row with a link - or exactly one labeled reason.
4. `Stream was too long.` may never appear again. If an upload still fails, paste
   the `[mirror] attempt …` lines: they now carry the phase, the status and the
   complete host message, including the size-aware timeout that was applied.
