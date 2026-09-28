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
- Encryption requested but unavailable, no host credential and "no enabled host"
  are all terminal, single-attempt, labeled reasons - failures are never silent
  and never blind-retried.

## 3. Documented gofile API contract (F46 §3)

Fetched from <https://gofile.io/api> on 2026-09-28 and pinned in
`payloads/ghrdp-mirror.ps1` (`$script:F46GofileContract`):

- **`POST https://api.gofile.io/accounts`**, JSON body `{}` -> a guest account
  whose token is `data.token` (`{status:"ok",data:{id, rootFolder, tier:"guest",
  token}}`). The token is the only way back into a guest account - store it, never
  log it. Off by default (`mirrorHosts[].autoAccount=false`): the worker does not
  mint accounts silently, it holds the job with `phase=auth`.
- **`GET https://api.gofile.io/servers`** -> `data.servers[].name`, the documented
  two-step upload flow (host config `uploadHostMode='fleet'`).
- **Upload** - multipart/form-data, field name **`file`**, optional `folderId`,
  token in the `Authorization: Bearer <token>` header (the docs' query-string
  token form is GET-only; this worker never puts a credential in a URL):
  - current reference (default, `uploadHostMode='auto'`):
    `POST https://upload.gofile.io/uploadfile`. Uploads do not go to
    `api.gofile.io`; the fleet routes the file to the closest store. The
    regional hosts (`upload-eu-par`, `upload-na-phx`, `upload-na-nyc`,
    `upload-ap-sgp`, `upload-ap-hkg`, `upload-ap-tyo`, `upload-ap-syd`,
    `upload-sa-sao`) pin a region by hostname and are an operator config choice,
    never something the worker switches between;
  - fleet form (`uploadHostMode='fleet'`):
    `POST https://<server>.gofile.io/contents/uploadfile`.
- Uploading **without** a token makes gofile create a guest account on the fly
  and the response carries `guestToken` + `parentFolder`. This worker never
  relies on that implicit path: no credential means the job is held with
  `phase=auth` unless the operator set `autoAccount=true` (docs: "Create **one**
  account and reuse its token - do not mint an account per upload").
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
    `AesGcm`. Container: salt(16) + iv(16) + AES-256-CBC over
    PBKDF2-SHA256(key, salt, 100000) - byte-identical to the legacy `.ghenc`
    form, so `docs/decrypt.html` and the web index decrypt it in the browser.
  - Which algorithm ran is recorded per file (`encAlg`) and printed in the
    attempt table; a 32-byte key length is asserted, a shorter key is refused.
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
  artifact or URL. The gofile **token** is a different secret and never touches
  config.json at all - see §9.

## 5. Read-only host probe (F46 §5)

`Invoke-F46HostProbe` performs a read-only `GET` of the API root
(`/servers`) per configured host - no credential, no upload, no body parsing -
and yields a `{host, status, note}` matrix rendered by `Format-F46ProbeTable`:

| host | status | note |
| --- | --- | --- |
| `gofile` | `200` | read-only GET /servers reachable; upload flow is documented + enabled=False |
| `gofile` | `403` | runner egress rejected (403) - policy/endpoint level rejection; operator option: operator-owned VPS egress (no evasion) |
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
      "autoAccount": false,
      "maxFileBytes": 0,
      "blockedExtensions": [],
      "tokenConfigKey": "gofileToken",
      "timeoutSec": 120
    }
  ]
}
```

`enabled=false` is the shipped default (mirror OFF, unchanged CI gate); the token
comes from `gofileToken` or `gofile-token.txt` in the runner root. `maxFileBytes`
0 means "no cap", `blockedExtensions` empty means "no blocked types" - both are
operator policy knobs, not invented defaults.

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
  (MSW) models the same documented flow for the client lane:
  `POST /accounts` -> `data.token`, `GET /servers` -> `data.servers[].name`,
  the documented upload paths (`upload.gofile.io/uploadfile` and
  `<server>/contents/uploadfile`) with `id` + `downloadPage`, the legacy
  `fileId`/`directLink` alias, and the policy matrix
  (403/413/415/429/500/502 plus `tls-reset` as a transport rejection).
  `src/tests/smoke/fx-gofile-mock.test.ts` exercises all of it; no real call.
- `src/tests/smoke/f46-mirror-truth.test.tsx` renders the shipped Mirror card
  against worker payloads and asserts the untruncated reason column and the
  title/`encrypted` parity.

## 8. Operator verification

1. Set the repository secret `GOFILE_TOKEN` once (Settings > Secrets and
   variables > Actions) - see §9.
2. Dispatch `main.yml` with `mirror_enable=true` (+ `mirror_encrypt=true` if you
   want AES-256); read the `F46 mirror host probe` matrix in the step summary.
3. Open the Mirror page: the **Mirror host matrix** card renders the same
   `{host,status,note}` rows live from `/diag` (`mirrorHosts`), and the Diagnose
   drawer carries them plus the worker's attempt table (`mirrorAttempts`).
4. Click **Upload everything now** once and upload ONE small benign `.txt`.
5. Expect either a success row with a `downloadPage` link, or ONE labeled reason
   (`phase=… status=… msg=…`) - never "failed after 5 tries" without a cause.

## 9. F47 per-run opt-in and token plumbing

Mirror default-OFF is a locked gate: the shipped `Get-F46DefaultHost` keeps
`enabled=false` and the CI gate that forbids a default-ON mirror is unchanged.
Enabling the mirror is **operator intent expressed per dispatch**:

| Input | Default | Effect |
| --- | --- | --- |
| `mirror_enable` | `false` | `true` writes `mirrorHosts[0].enabled=true` into `config.json` **for this run only** (enabled flag + host id, nothing else). |
| `mirror_encrypt` | `false` | `true` sets `encryptMode=all` and generates the per-run 32-byte `mirrorKey` (§4). |

**Token plumbing (process env only).** `main.yml` reads the optional repository
secret `GOFILE_TOKEN` into step env and publishes it as `GHRDP_GOFILE_TOKEN` in
the RDP user's process environment (user scope, so the `ONLOGON` watcher process
inherits it as its own process env). `Get-F46HostToken` reads that env var
FIRST; the `gofileToken` config key and `gofile-token.txt` rungs remain for a
manual/lab runner only and the stage step writes neither. The token is therefore
never in `config.json`, never in a file the workflow writes, never in a URL, log
line, artifact or UI field, and the cleanup step clears the env var on the way
out.

**Fail-closed.** `mirror_enable=true` with no `GOFILE_TOKEN` halts the stage
step loudly (`::error::` + a step-summary card + `throw`) with a direct link to
the repository Secrets settings. There is no workaround, no plaintext fallback
and no silent guest-account fallback (`autoAccount` stays `false`), so the run
can never degrade into an unexplained `phase=policy` row.

**Where the truth is rendered.** The dispatch step summary prints the probe
matrix plus `mirror opt-in for THIS run: enabled=… encryptMode=…`; the Mirror
page renders the same rows from `/diag`; the `mirror-diag` artifact keeps both
tables after a halt.

**If every probe row is blocked from the runner egress (403)**, that is a policy
dead-end with exactly two honest options - run the upload from an operator-owned
VPS egress you configure yourself, or accept the mirror as unavailable from
ephemeral runners and leave `mirror_enable=false`. Nothing in this repository
attempts to work around a host policy.
