# F59 prebuilt binaries (aria2c + qBittorrent) - sources, pins, update procedure

Why: `main.yml` used to install aria2c/qBittorrent with Chocolatey on every
dispatch (3-5 min on the critical path, plus Chocolatey repo/network variance,
and `qbittorrent-nox` does not exist as a Windows package). F59 removes
Chocolatey from the transport lane entirely: the binaries are built/published
**once** by `.github/workflows/f59-prebuilt-binaries.yml` as release assets and
downloaded by `main.yml` with a **SHA-256 pin** that is verified fail-closed
before anything is staged or executed.

## Official sources (ONLY these)

| asset (release `prebuilt-binaries`) | official source URL | method |
| --- | --- | --- |
| `aria2c-1.36.0-win-x64.exe` | `https://github.com/aria2/aria2/releases/download/release-1.36.0/aria2-1.36.0-win-64bit-build1.zip` | official aria2 GitHub release; `aria2c.exe` extracted from the win-64bit build zip |
| `qbittorrent-4.6.5-win-x64.zip` | `https://downloads.sourceforge.net/project/qbittorrent/qbittorrent-win32/qbittorrent-4.6.5/qbittorrent_4.6.5_x64_setup.exe` | official qBittorrent Windows release (SourceForge project `qbittorrent`, linked from `qbittorrent.org/download.php`); the installer is 7-Zip-extracted (no install) and the application folder is republished as a zip |

Upstream pin for the qBittorrent installer:
`50DE6E913A6F0A2A5C8356E56E9CC23B1921F067B55E2A97C75BBFFE345682FD`
(as published in the Chocolatey `qbittorrent` 4.6.5 package `VERIFICATION.txt`);
the fetch workflow asserts it before extracting anything.

**NOTE on `-nox`:** qBittorrent does *not* publish a `qbittorrent-nox` binary for
Windows. The official Windows binary is `qbittorrent.exe` - the same application
with the GUI shell. The shipped lane already resolves it
(`payloads/ghrdp-qbt.ps1` reports `nox=false`; a GUI binary is never silently
promoted to a headless claim). If the project ever publishes a Windows `-nox`
binary, add it as a new pinned asset and switch the resolver's preference - the
rest of the pipeline is unchanged.

## Pin file

`payloads/f59-prebuilt-pins.json` is the single source of truth:

* `assets.<name>.source` - the official URL above (documentation; the fetch
  workflow downloads exactly this).
* `assets.<name>.sha256` - the **pin** of the published artifact.
  * non-empty + matching -> run continues (`::notice::` + checksums.txt);
  * non-empty + different -> the fetch workflow **fails closed**;
  * empty -> documented **bootstrap** state: the fetch workflow records the
    observed digest in the run log (`::notice title=F59 pin bootstrap::`) and in
    the release `checksums.txt`, and the digest is then committed here. `main.yml`
    refuses to stage an asset whose pin is empty
    (`payloads/f59-prebuilt-verify.ps1` -> "EMPTY sha256 pin").
* `assets.qbittorrent.upstream_sha256` - the installer-level pin above.

## Release layout (`prebuilt-binaries`)

* `aria2c-1.36.0-win-x64.exe`, `qbittorrent-4.6.5-win-x64.zip`
* `checksums.txt` - sha256 + filename per artifact (required companion)
* `README.md` - provenance (source URLs, upstream pin, run link) - required companion

## How `main.yml` consumes them

1. The **F59 parallel pre-warm** step starts background jobs for the Tailscale MSI
   download, this asset download, the PowerShell server pre-parse and the cert-bind
   pre-warm, then `Wait-Job`s before any consumer runs. Assets restored from the
   `f59-prebuilt-<pins-hash>` actions cache are re-verified (pin + checksums.txt)
   before staging - a cached byte is never trusted blindly.
2. The aria2c step re-verifies `C:\ghrdp\bin\aria2c.exe` against the pin at use
   time; the qBittorrent step stages the verified zip into
   `%ProgramFiles%\qBittorrent` (a root the shipped resolver searches).
3. There is **no Chocolatey fallback and no warn-and-continue path**: a missing or
   unverifiable asset stops the step.

## Updating a binary

1. Edit `payloads/f59-prebuilt-pins.json`: set the new `source` (official URL
   only) and empty the artifact `sha256` (bootstrap).
2. Push - `f59-prebuilt-binaries.yml` runs, verifies the upstream, publishes, and
   prints the new digest as a `::notice::F59 pin bootstrap` line.
3. Commit that digest into `sha256` and push again; the workflow now asserts it,
   and `main.yml` verifies the same value at dispatch time.

## F60 note (out of scope here)

The <5 min target in F59 is a **GitHub-hosted floor**: the cold `windows-latest`
VM boot + Tailscale bring-up + cert fetch remain. Going below it is the F60
self-hosted-runner question (a warm runner), which this phase does **not** add:
no self-hosted runner is introduced, and the gates fail if `runs-on: self-hosted`
appears in `main.yml`.
