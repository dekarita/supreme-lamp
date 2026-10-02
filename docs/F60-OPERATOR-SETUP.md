# F60 operator setup - the 10-minute path (provisioning workflow)

**Status:** this document is the operator-facing half of F60. The code half is
`.github/workflows/provision-warm-runner.yml` (provisioning),
`scripts/f60-bootstrap.ps1` (what runs on the VM),
`.github/workflows/warm-dispatch.yml` + `scripts/f60-stage-and-start.ps1` +
`scripts/f60-health.ps1` (the runtime lane), and
`.github/workflows/f60-warm-pins-bootstrap.yml` (one-time SHA-256 pin recording).

**Why F60 exists:** F59 got a dispatch down to the GitHub-hosted floor (cold
`windows-latest` VM boot + Tailscale bring-up + certificate fetch). Those minutes
cannot be removed on a rented runner. A *warm* self-hosted runner - one VM that is
already joined to the tailnet, already holding the pinned binaries, already running
the four services - is the only way below that floor. F60 adds exactly that, and
nothing else: **`main.yml` is not touched**, no existing workflow gains a
`self-hosted` label, and the F59 lane stays the default.

---

## Step 0 (ONE TIME, ~3 min) - record the binary pins

The F60 lane refuses to install anything that is not pinned by SHA-256
("unpinned binary download = HALT"). Three of the four warm-VM artifacts come from
hosts this repository's agent sandbox cannot reach (`pkgs.tailscale.com`,
`nssm.cc`, `nodejs.org`), so their digests are recorded by a workflow that runs
where those hosts *are* reachable, and then committed - the same bootstrap pattern
F59 used for `prebuilt-binaries`.

1. Actions -> **F60 warm pins bootstrap (official-source SHA-256 digests)** ->
   *Run workflow* -> `mode=record`, `node_major=20`.
2. The run downloads the Tailscale MSI, the NSSM zip and the Node LTS win-x64 zip
   from their official sources, **cross-checks Node's digest against the published
   `SHASUMS256.txt`**, re-asserts the already-committed `actions/runner` digest
   against the official release notes, and publishes
   `f60-warm-pins.observed.json` + `checksums.txt` to the `warm-pins` release (and
   as the `warm-pins-bootstrap` artifact). The job summary contains the
   ready-to-commit JSON.
3. Commit that JSON over `payloads/f60-warm-pins.json` (a session can do this from
   the artifact, or you can paste the summary block).
4. Re-run the same workflow with `mode=assert` if you want proof that the committed
   file now matches the official sources byte-for-byte.

Until step 3 is done, `provision-warm-runner.yml` **halts at preflight** with
`f60 pin incomplete: <artifact>`. That is the intended fail-closed behaviour, not a
bug.

`actions/runner` is already pinned in the committed file
(`v2.337.0`, digest taken from the official release notes' *SHA-256 Checksums*
section). The other three start empty on purpose: an invented digest would be
worse than an empty one, because an empty pin is *refused* while a wrong pin
silently bricks the provision.

---

## Step 1 (~4 min) - the four repository secrets

Settings -> Secrets and variables -> Actions -> *New repository secret*:

| # | secret | how to get it | scope / hygiene |
| --- | --- | --- | --- |
| 1a | `AZURE_CREDENTIALS` | see the two commands below | Service principal **scoped to the resource group only**. A broader scope HALTS the workflow. |
| 1b | `TAILSCALE_AUTHKEY` | Tailscale admin console -> Settings -> Keys -> *Generate auth key* | **Tagged** `tag:ghrdp-warm`, **reusable**, expiry **disabled**. Masked in every log; handed to `tailscale up` as `file:<temp>` and the temp file is deleted. |
| 1c | `GHRDP_RELEASE_READONLY_TOKEN` | GitHub -> Settings -> Developer settings -> *Fine-grained personal access token* | **Repository access: only `dekarita/supreme-lamp`; Permissions: Contents = Read-only; expiry 7 days.** See "Why a fourth secret" below. |
| 1d | `VM_ADMIN_PASSWORD` | `openssl rand -base64 32` (or PowerShell: `[Convert]::ToBase64String((1..32 \| % {Get-Random -Max 256}))`) | Used **once** for the VM admin account; 3389 is denied from the Internet afterwards, so password logon is unreachable from outside the tailnet. Masked, never echoed. |

```bash
# 1a - on your local machine, logged in to the Azure CLI
az group create --name sl-warm-rg --location southeastasia

az ad sp create-for-rbac --name sl-warm-sp --role Contributor \
  --scopes /subscriptions/<SUB_ID>/resourceGroups/sl-warm-rg --sdk-auth \
  > sl-warm-sp.json
# paste the JSON content into the AZURE_CREDENTIALS secret, then delete the file:
shred -u sl-warm-sp.json   # or: Remove-Item sl-warm-sp.json -Force
```

> The resource group is created first **only so the scope exists**; the
> provisioning workflow re-creates/updates it idempotently. If you prefer, create
> the SP with `--scopes /subscriptions/<SUB_ID>` and the workflow will HALT - that
> is the guard doing its job.

### Why a fourth secret (`GHRDP_RELEASE_READONLY_TOKEN`)

`dekarita/supreme-lamp` is **private**. The warm VM has no `GITHUB_TOKEN` outside a
job, so at provision time it cannot fetch:

* the repository files it must stage (`payloads/ghrdp-server.ps1` and the ~25
  modules/pages it dot-sources and serves),
* the `prebuilt-binaries` release assets (aria2c, qBittorrent),
* the `ui-dist` release asset (the prebuilt dashboard bundle).

The alternatives were all worse: publishing the binaries somewhere public breaks
the locked "no public mirror of third-party content" rule; an Azure storage
account adds a second cloud resource and more cost; and deferring every asset to
dispatch time would make the "warm" VM cold again. So the bootstrap takes a
**least-privilege, short-lived, read-only** token, uses it only for those
downloads, masks it, and the provisioning workflow deletes the Azure Run Command
settings files that carried it (`scripts/f60-scrub-runcommand.ps1`) once the
bootstrap returns. Rotate it like any other secret (checklist: `docs/MIGRATION.md`
sec 1.8); when it expires, `action=verify` fails at preflight with the secret's
name and nothing else breaks.

## Step 2 (~1 min) - the runner registration token

Nothing to register by hand **if the workflow token may mint one**. The provisioning
workflow tries `POST /repos/<repo>/actions/runners/registration-token` with
`GITHUB_TOKEN` and passes the result straight to `config.cmd`.

That endpoint wants the **Administration** permission, and `administration` is *not*
one of the keys a workflow `permissions:` block may declare - writing it makes GitHub
reject the whole file (a 0-second "workflow file issue" run, and the workflow can
never be dispatched). So the workflow declares only `contents: read` + `actions:
write` and takes the token from the first of these that is non-empty:

1. the optional **`runner_token`** input of the dispatch form (nothing to set up in
   advance, valid for 1 hour);
2. the optional **`RUNNER_REGISTRATION_TOKEN`** repository secret (hands-off, for
   re-provisioning);
3. the API call above.

If none of the three yields a token the run **halts before touching Azure** and
prints both fallbacks. The 60-second version:

> Repo **Settings -> Actions -> Runners -> New self-hosted runner** -> copy the value
> after `--token` from the printed `config.cmd` line -> re-run the workflow with that
> value in `runner_token`.

The permanent version: a fine-grained PAT for **this repository only** with
"Administration: read and write", stored as `RUNNER_REGISTRATION_TOKEN`. It is
optional - it is not one of the four required secrets - and it is masked before use.

Also confirm **Settings -> Actions -> General -> Workflow permissions** lets the job
write (the declared permission block is what matters), and that
**Settings -> Actions -> General -> Actions permissions** allows the actions this
workflow uses: F60 uses **`actions/*` only** (checkout, upload/download-artifact), so
even the strictest "Allow actions created by GitHub" policy is satisfied.

## Step 3 (one click, ~20-30 min) - provision

Actions -> **F60 provision warm runner (Azure VM + Tailscale + self-hosted
runner)** -> *Run workflow*:

| input | value | notes |
| --- | --- | --- |
| `action` | `create` | `verify` = re-run the idempotent bootstrap + health probe; `teardown` = delete the resource group (and the runner registration). |
| `region` | `southeastasia` | or `centralindia`. |
| `vm_size` | `Standard_B2s` | 2 vCPU / 4 GiB burstable. `Standard_B2s_v2` if the burst credits prove too small. |
| `runner_token` | *(empty)* | Optional fallback only - see Step 2. Paste a registration token here if the workflow is not allowed to mint one. |

The run does, in order:

1. **Preflight** - all four secrets present (values never printed), the F59 + F60
   pin files complete (every digest 64-hex), `scripts/f60-bootstrap.ps1` under the
   Run Command size bound. Any miss = halt before Azure is touched.
2. **`az login --service-principal`** with the `AZURE_CREDENTIALS` service principal
   (the `az` CLI is preinstalled on `ubuntu-latest`, so F60 pulls in **no third-party
   action**; `az logout` runs at the end of the job whatever happened).
3. **SP scope guard (HALT)** - a subscription-wide role-assignment read that
   succeeds is inspected, and any assignment broader than
   `/subscriptions/<sub>/resourceGroups/sl-warm-rg` stops the run. A *denied*
   subscription-wide read is itself evidence of a correctly scoped SP, and the
   resource-group-scoped check then applies.
4. **Resource group + NSG** - `sl-warm-rg`, then `sl-warm-nsg` with
   `DenyRdpInternet` (priority 4000, TCP 3389) and `DenyAllInternetInbound`
   (priority 4090, all protocols/ports). The NSG exists **before** the VM does, so
   3389 is never open, not even for a minute. (The F60 plan ordered the lockdown
   after the bootstrap; doing it first shrinks the exposure window from ~20 min to
   zero, so the order was deliberately changed.)
5. **VM** - `MicrosoftWindowsServer:WindowsServer:2022-datacenter:latest`,
   `Standard_B2s`, 128 GB `StandardSSD_LRS` OS disk, **32 GB data disk** (the
   bootstrap formats it and mounts it as `D:` so the shipped storage roots
   `D:\RDP-Storage\Fetched` and the aria2 session directory exist as the shipped
   modules expect them), `--public-ip-sku Standard`, `--no-wait`, then
   `az vm wait --created`.
6. **Registration token** obtained from the `runner_token` input, the optional
   `RUNNER_REGISTRATION_TOKEN` secret, or the API - in that order - and masked
   (`::add-mask::` before it is written anywhere). If all three are empty the run
   halts here with the Step 2 instructions and **no Azure resource has been created
   by this step**.
7. **`az vm run-command invoke`** with `scripts/f60-bootstrap.ps1` and the
   parameters `TailscaleAuthKey`, `RunnerToken`, `RepoUrl`, `RepoRef`,
   `UiReleaseTag`, `UiBundleSha`, `RepoAccessToken`. The workflow fails closed
   unless the output contains `BOOTSTRAP_OK`, and fails closed with the reason if
   it contains `BOOTSTRAP_FAILED:`.
8. **Post-run scrub** - a second, parameter-free Run Command
   (`scripts/f60-scrub-runcommand.ps1`) deletes the settings files that carried the
   secrets.
9. **Runner poll** - `GET /repos/<repo>/actions/runners` until a runner with the
   `sl-warm` label reports `status=online`; 30 attempts x 10 s, then
   `F60 STOP: the sl-warm runner is not online after 30 polling attempts`.
10. **Job summary** - MagicDNS hostname, runner id, labels, resource group/VM, the
    temporary public IP (inbound-denied), and the NSG rules.

### What the bootstrap installs on the VM (`scripts/f60-bootstrap.ps1`)

Everything is **pinned and SHA-256 verified before it is executed**, using the
shipped F59 verifier (`payloads/f59-prebuilt-verify.ps1`, staged from the repo at
run time - one implementation, no copy):

| artifact | source | lands at |
| --- | --- | --- |
| Tailscale MSI (explicit version, never `-latest-`) | `pkgs.tailscale.com/stable` | `C:\Program Files\Tailscale`, then `tailscale up --auth-key=file:<temp> --advertise-tags=tag:ghrdp-warm --hostname=sl-warm --unattended` |
| NSSM 2.24 | `nssm.cc/release` | `C:\ghrdp\tools\nssm.exe` |
| Node LTS 20 win-x64 zip | `nodejs.org/dist` (digest cross-checked vs `SHASUMS256.txt`) | `C:\ghrdp\tools\node\` |
| aria2c 1.36.0 | `prebuilt-binaries` release (**F59 pin**) | `C:\ghrdp\bin\aria2c.exe` |
| qBittorrent 4.6.5 | `prebuilt-binaries` release (**F59 pin**) | `C:\Program Files\qBittorrent` |
| UI bundle | `ui-dist` release + `.sha256` sidecar, verified by `scripts/f59-verify-sha256.mjs` | `C:\ghrdp\ui\index.html` + `C:\ghrdp\ui-v2.html` |
| repo payloads | Contents API (`application/vnd.github.raw`) | `C:\ghrdp\*`, `C:\ghrdp\fonts\*`, `C:\ghrdp\tools\*` |
| actions/runner 2.337.0 win-x64 | official GitHub release (**digest from the release notes**) | `C:\actions-runner`, then `config.cmd --url <repo> --token <masked> --labels self-hosted,windows,sl-warm --name sl-warm --runasservice --unattended` |

Then four NSSM services (Automatic start, `LocalSystem`, logs in `C:\ghrdp\logs`,
which is **outside** the runner job tree so a job cleanup can never delete a
service's evidence):

| service | runs | listens |
| --- | --- | --- |
| `ghrdp-server-nssm` | `ghrdp-server.ps1` (Mission Control) | `0.0.0.0:7331` (tailnet; the Internet is NSG-denied) |
| `ghrdp-ui-nssm` | `node scripts/serve-dist.mjs C:\ghrdp\ui` | `0.0.0.0:4173` (the repo's own zero-dependency static server) |
| `aria2c-nssm` | `aria2c.exe --enable-rpc --rpc-listen-all=false --rpc-listen-port=6800 ...` | `127.0.0.1:6800` only |
| `qbittorrent-nssm` | `qbittorrent.exe --webui-port=8080 --no-splash --profile=C:\ghrdp\qbt` | the **CGNAT tailnet address only** (the shipped `Initialize-GhrdpQbt` bind ladder; never `0.0.0.0`, never `*`, never loopback) |

`Tailscale` (MSI-installed) is the fifth service the health probe requires.

**Idempotent by construction:** a service that exists is never re-created; a binary
already present at its pinned digest is never re-downloaded; the runner is never
re-configured when `.runner` + its service exist; the aria2c/qBittorrent secrets are
generated once and reused. `action=verify` is therefore always safe.

**Note on the qBittorrent bind:** if the tailnet CGNAT address is not resolvable at
provision time, `qbittorrent-nssm` is left **not started** and the bootstrap reports
`BOOTSTRAP_FAILED` with `service-qbittorrent-nssm=Stopped`. That is deliberate: the
alternative is a WebUI bound to a wildcard, which the Tailnet-only floor forbids.
Re-run `action=verify` once Tailscale is up (or just dispatch
`warm-dispatch.yml`, whose warm job heals the bind through the same shipped
module).

## Step 4 (~2 min) - prove the warm lane

Actions -> **F60 warm dispatch (sl-warm runner, <60s dashboard-reachable,
windows-latest fallback)** -> *Run workflow* with the defaults
(`force_fallback=false`, `budget_ms=60000`, `restart_services=false`).

The warm job:

1. runs on `[self-hosted, windows, sl-warm]`;
2. reports the runner-hygiene guard (`RUNNER_TRACKING_ID`, stale `_work` trees) with
   its remediation;
3. runs `scripts/f60-stage-and-start.ps1 -Mode warm`: refreshes the payloads from
   the checkout, downloads the **commit-matched** `ui-dist-<sha>.zip` (+ sidecar,
   fail-closed verify), restarts the two UI-facing services so the running code is
   the code under test, and heals the qBittorrent bind if needed;
4. runs `scripts/f60-health.ps1` (5 services, dashboard HTTP 200, bundle HTTP 200,
   a real `aria2.getVersion` JSON-RPC round-trip, `tailscale status` online +
   MagicDNS) and fails closed on `F60_HEALTH_FAILED`;
5. writes `dispatch-to-dashboard` into `C:\ghrdp\startup-timing-f60.jsonl` through
   the **shipped F59 timing helper** (`payloads/f59-timing.ps1`, redirected via
   `$env:GHRDP_F59_TIMING`, so the warm lane and the GitHub-hosted lane never
   overwrite each other), then gates it at **< 60000 ms**;
6. uploads `startup-timing-f60-warm` (timing JSONL + health JSON + bootstrap result
   + strike ledger).

**Three-strike STOP:** every over-budget run appends to
`C:\ghrdp\state\f60-warm-strikes.json`. On the third *consecutive* over-budget run
the workflow prints `F60 STOP: the warm lane exceeded the budget 3 consecutive
runs` - the answer at that point is "stay on `f59-windows-latest`", not another
retry.

**Fallback proof:** run it again with `force_fallback=true`. The warm job is
skipped and the `windows-latest` job runs the same script with `-Mode cold`,
labeled `f59-windows-latest`. It proves the fallback reaches the dashboard with the
same prebuilt bundle; its timing is reported **advisory** (the GitHub-hosted floor
is F59's number, not 60 s). It never dispatches `main.yml`. You can also produce
this run by stopping one warm service (`Stop-Service ghrdp-server-nssm` over
Tailscale) and dispatching normally - the health probe then fails and the fallback
runs.

The `report` job prints one honest table: which lane ran, both results, both
timings, the MagicDNS hostname, and - if both lanes are red - a **STOP** line
instead of a retry suggestion.

## Step 5 - cost, and turning the bill off

Estimates for `southeastasia`, 730 h/month, pay-as-you-go (confirm with the Azure
pricing calculator before committing; these are the shapes of the numbers, not
quotes):

| item | ~US$/month |
| --- | --- |
| `Standard_B2s` (2 vCPU / 4 GiB burstable) | 30 - 35 |
| 128 GB `StandardSSD_LRS` OS disk | 6 - 7 |
| 32 GB `StandardSSD_LRS` data disk (`D:`) | 1.5 - 2 |
| Standard public IP (inbound denied, outbound only) | 3.5 - 4 |
| egress (runner + tailnet traffic is small) | 0 - 2 |
| **total** | **~42 - 50** (the F60 plan's `~$46`) |

Cheapest safe idle mode: `az vm deallocate -g sl-warm-rg -n sl-warm` - the compute
charge stops (disks + IP keep billing, ~$12/month) and the runner shows offline.
`az vm start` brings it back in ~1-2 min and the services auto-start. Full stop:
`action=teardown`, which deletes the runner registration and then the whole group.

---

## HALT and STOP conditions (F60 §6)

The workflow enforces these at runtime; the launch gates pin them in the shipped
text.

| condition | where it fires |
| --- | --- |
| Service principal scope broader than the resource group | preflight guard, before any Azure resource is created |
| VM admin password / Tailscale auth key / registration token / repo token in a log | `::add-mask::` before use, redaction inside `f60-bootstrap.ps1`, auth key by `file:`, post-run settings scrub |
| Any unpinned binary download | `Test-F60PinShape` + the shipped `Test-F59AssetSha256` (empty pin = refuse, mismatch = refuse) |
| Any `main.yml` edit | F60 is additive; the F59 gate additionally fails if `self-hosted` appears in `main.yml`'s rdp job |
| ARC / Kubernetes / GitHub Larger Runners | not used anywhere in F60 |
| Provisioning runtime > 45 min | `timeout-minutes: 45` on the provision job |
| Runner not Idle/online after 30 polling attempts | `F60 STOP: the sl-warm runner is not online...` |
| Warm lane over budget three consecutive runs | `F60 STOP: the warm lane exceeded the budget 3 consecutive runs` |
| `windows-native` red after one fix attempt | stop and report the exact failing cell (the repo's standing rule) |
| `RUNNER_TRACKING_ID` unset / stale `_work` | advisory guard step with the exact remediation |

---

## Appendix A - manual 7-step setup (troubleshooting fallback ONLY)

Use this only if `provision-warm-runner.yml` cannot run (for example no Azure
service principal can be created, or Run Command is blocked by policy). It produces
the same warm VM by hand; every pin and every service definition above still
applies.

1. **VM**: `az group create --name sl-warm-rg --location southeastasia`, then
   `az vm create --resource-group sl-warm-rg --name sl-warm --image
   MicrosoftWindowsServer:WindowsServer:2022-datacenter:latest --size Standard_B2s
   --admin-username ghrdpadmin --admin-password '<from your password manager>'
   --storage-sku StandardSSD_LRS --os-disk-size-gb 128 --data-disk-sizes-gb 32
   --public-ip-sku Standard --nsg sl-warm-nsg`.
2. **Lock down**: `az network nsg rule create --nsg-name sl-warm-nsg -g sl-warm-rg
   --name DenyRdpInternet --priority 4000 --direction Inbound --access Deny
   --protocol Tcp --destination-port-ranges 3389 --source-address-prefixes
   Internet --destination-address-prefixes '*'`, then the same with
   `DenyAllInternetInbound --priority 4090 --protocol '*'
   --destination-port-ranges '*'`; delete `default-allow-rdp` if it exists.
3. **Join the tailnet**: RDP once over the public IP (before step 2 if you must),
   install the pinned Tailscale MSI, then `tailscale up
   --auth-key=file:<keyfile> --advertise-tags=tag:ghrdp-warm --hostname=sl-warm
   --unattended`; delete the key file. From here on, connect as
   `sl-warm.<your-tailnet>.ts.net`.
4. **Format the data disk as `D:`** (Disk Management, or the
   `Mount-F60DataDisk` function in `scripts/f60-bootstrap.ps1`).
5. **Stage the repo + pinned binaries**: clone the repository (or download the
   pinned artifacts by hand and verify each digest against
   `payloads/f60-warm-pins.json` + `payloads/f59-prebuilt-pins.json`), copy the
   `Get-F60PayloadList` set into `C:\ghrdp` and the `scripts/` set into
   `C:\ghrdp\tools`, then extract the `ui-dist-<sha>.zip` bundle into
   `C:\ghrdp\ui\index.html` + `C:\ghrdp\ui-v2.html`.
6. **Services + runner**: install NSSM, register the four services exactly as
   tabled above, then extract the pinned `actions-runner-win-x64-<ver>.zip` into
   `C:\actions-runner` and run `config.cmd --url
   https://github.com/dekarita/supreme-lamp --token <registration token from
   Settings -> Actions -> Runners> --labels self-hosted,windows,sl-warm --name
   sl-warm --runasservice --unattended`.
7. **Verify**: `pwsh scripts/f60-health.ps1` must print `F60_HEALTH_OK`; then run
   `warm-dispatch.yml` and check `dispatch-to-dashboard < 60000 ms`.

If you had to use this appendix, the provisioning workflow's failure output is the
thing to fix - please keep it, because the next operator should get the one-click
path.

## Appendix B - where this implementation differs from the F60 v6 plan (and why)

| plan | implementation | reason |
| --- | --- | --- |
| `UiReleaseTag=<from f59-ui-release-tag.txt>` | the tag is read from `payloads/f60-warm-pins.json` (`reused_f59_assets.ui_release_tag` = `ui-dist`), and the asset is `ui-dist-<commit-sha>.zip` | `f59-ui-release-tag.txt` does not exist in this repository; `build-ui.yml` publishes to the `ui-dist` release with a commit-sha asset name, so the pins file is the honest single source |
| health probe `curl 127.0.0.1:5173` | probes `127.0.0.1:7331` (the real dashboard, `ghrdp-server.ps1`) **and** `127.0.0.1:4173` (the prebuilt bundle via the repo's `scripts/serve-dist.mjs`) | 5173 is the Vite **dev** server; a warm VM serves the prebuilt single-file bundle, and 7331 is the port the whole shipped lane uses |
| three secrets | four (`GHRDP_RELEASE_READONLY_TOKEN`, read-only, 7-day) | the repository is private, so the VM cannot fetch repo files or release assets anonymously; see "Why a fourth secret" |
| NSG lockdown after the bootstrap | lockdown **before** the VM is created | the RDP exposure window goes from ~20 min to zero |
| 128 GB OS disk only | + 32 GB data disk mounted as `D:` | the shipped modules pin `D:\RDP-Storage\Fetched` (policy `savePath`, aria2 `--dir`, the trash tree); inventing a `C:` variant would mean editing shipped payloads |
| pins assumed present | one-time `f60-warm-pins-bootstrap.yml` run + commit | the sandbox cannot reach `pkgs.tailscale.com`, `nssm.cc` or `nodejs.org`, and an unpinned download is a HALT condition |
| `az vm run-command --parameters` carries the secrets (unchanged) | unchanged, **plus** `scripts/f60-scrub-runcommand.ps1` after the run | Azure writes run-command parameters into on-disk settings files; they are single-use, so they are deleted |
| `azure/login@v2` for the SP login | plain `az login --service-principal` (+ `az logout` at the end) | a mutable third-party tag is an unpinned dependency in a lane whose rule is "nothing unpinned runs", and a repo Actions policy of "Allow actions created by GitHub" makes GitHub reject the *whole file* (`Unable to resolve action`), which is exactly what the first push of this branch did |
| workflow declares `administration: write` and mints the token itself | `contents: read` + `actions: write` only; the token comes from the `runner_token` input, the optional `RUNNER_REGISTRATION_TOKEN` secret, or the API - and a missing token halts with instructions | `administration` is not a declarable workflow permission key, so declaring it invalidates the file; `GITHUB_TOKEN` is not guaranteed to be able to mint a registration token, so the lane needs a documented fallback rather than an assumption |

## Appendix C - what F60 does NOT change

* `main.yml` - untouched, byte for byte. The F59 lane, its dispatch defaults and
  its `windows-latest` runner are unchanged.
* No `self-hosted` label is added to any existing workflow. The warm runner is used
  only by `warm-dispatch.yml`.
* No ARC, no Kubernetes, no GitHub Larger Runners.
* No credential-UI automation, no NLA/CredSSP/certificate weakening, no MOTW
  stripping, no Defender change, no public exposure of any third-party binary, no
  password in a URL, log or artifact - the standing refusals all still apply, on the
  VM as much as in CI.
* Moving `main.yml`'s runtime onto the warm runner is **not** part of F60. That is
  a separate, operator-approvable change (it would need the per-run aria2c secret
  contract and the F59 gates re-anchored), and F60's own gate fails closed if
  `self-hosted` appears in `main.yml`'s rdp job.
