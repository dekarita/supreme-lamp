# F31 — private-key persistence and listener proof

Evidence supplied by the operator: two System/Schannel 36870 events at the
2026-09-26 19:43Z mstsc attempts, 0x8009030D/state 10001, TermService.
These establish credential private-key access failure, not its unique cause.
The starting workflow ALREADY used PersistKeySet,MachineKeySet,Exportable.
Its ACL implementation only tried RSA, looked in the CSP directory for a CNG
UniqueName, and silently skipped failures. This change fails closed instead.

.NET has no `Persistable` flag: the actual member is `PersistKeySet`.
RDP requires TPKT/X.224 negotiation before TLS. The loopback probe offers
SSL/HYBRID/HYBRID_EX, validates the negotiation response, and checks the remote
thumbprint after TLS. Its permissive validation callback is loopback-only;
it neither changes client trust nor proves CredSSP/logon/fullscreen success.
No credentials are submitted. NLA remains enabled.

The autologin-lab F31 job uses real TermService with RSA and ECDSA certificates.
Import and probe run in separate processes. It requires default-import failure
with observed 36870, persistent-machine import success, and ACL-denied failure
with observed 36870 and an SDDL dump. Default flags are provider-dependent;
if the presumed reproduction does not occur, the matrix FAILS rather than
manufacturing the requested evidence. This is a hypothesis test, not a claim
that every default import loses its key. No private material is uploaded.

Landing is blocked until that matrix is green. Local static gates are not
Windows proof. After merge: dispatch main.yml, require listener-handshake-ok,
then ask the user to click WINDOWS AUTO-LOGIN. Check 4624 type 10, usage, and
request fullscreen confirmation within 60 seconds. At most two mapped loops;
36870 -> container/ACL inspection, 36871 -> cipher investigation (mapping is a
triage hint, not unique causal proof), 12018 -> credential investigation.
Do not report PRIVATE-KEY LIVE without user confirmation.

## F32 landing / diagnostics

The F32 session integrates 94d95fa without rewriting its history. The cert
step exports a true handshake flag only after the thumbprint-matched TLS
probe returns; F17 writes it into rdpListener only if the bound thumbprint
still matches. The card requires the boolean true (absent/string/false fail).
The original F17 synthetic lab does not execute the cert step and must not be
required to invent a successful TLS probe. Its existing checks stay intact.

Every attempted Windows key cell prints CELL/EXPECT/OBSERVED/RESULT and a
failure annotation. Public metadata diagnostics go to the log, step summary,
and Checks notices (fallback when Actions blob log downloads fail):
HasPrivateKey, both candidate key directories, ACL SIDs/rights, probe inner
exception type/HRESULT/socket code, and the last three Schannel IDs. No raw
event messages, exported keys, passwords, or certificate bytes are emitted.

Run 36298111759: RSA/default observed handshake-failed;36870-count=0.
This is NOT evidence for an ACL or protocol fix without the inner exception.
Landing remains blocked on the real matrix; static tests are not Windows proof.

### Phase 4 — only if 36870 persists after merge

On the affected runner, use X509Store rather than the Cert: provider. Read-only
inspection, no trust install or ACL changes. In a constrained shell that blocks
these .NET methods, report the exact blocked method and stop; do not bypass the
shell policy. Copy only the public metadata below, never a PFX/PEM or config.json.

```powershell
$rdp = 'HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp'
$hash = (Get-ItemProperty $rdp).SSLCertificateSHA1Hash
$thumb = ($hash | ForEach-Object { $_.ToString('X2') }) -join ''
$store = New-Object System.Security.Cryptography.X509Certificates.X509Store('My','LocalMachine')
$store.Open('ReadOnly')
$c = $store.Certificates | Where-Object Thumbprint -EQ $thumb | Select-Object -First 1
try {
    'HasPrivateKey=' + $c.HasPrivateKey
    $k = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($c)
    if (-not $k) { $k = [System.Security.Cryptography.X509Certificates.ECDsaCertificateExtensions]::GetECDsaPrivateKey($c) }
    if ($k -is [System.Security.Cryptography.RSACryptoServiceProvider]) { $name = $k.CspKeyContainerInfo.UniqueKeyContainerName }
    else { $name = $k.Key.UniqueName }
    if (-not $name) { throw 'key-container-name-unavailable' }
    foreach ($dir in @('Microsoft\Crypto\Keys','Microsoft\Crypto\RSA\MachineKeys')) {
        $path = Join-Path (Join-Path $env:ProgramData $dir) $name
        'key-path=' + $path
        if (Test-Path -LiteralPath $path) { icacls.exe $path }
        else { 'key-file=absent' }
    }
} finally {
    if ($k) { $k.Dispose() }; if ($c) { $c.Dispose() }; $store.Close()
}
Get-WinEvent -FilterHashtable @{LogName='System';ProviderName='Schannel'} -MaxEvents 3 |
    Select-Object Id, TimeCreated
```

Map NETWORK SERVICE (S-1-5-20) Read, SYSTEM (S-1-5-18) FullControl and
applicable deny entries on the actual file. One evidence-mapped fix per loop,
maximum two post-merge loops. Never promote manual-password or trust workarounds.
