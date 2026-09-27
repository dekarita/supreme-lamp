# [F44 §3] REAL-HOST READ-ONLY PROBE (lab only; NO content upload): one GET
# per configured host API root from the ephemeral runner. A 403 here is a
# POLICY outcome and is documented as such - evasion (IP rotation, UA spoof,
# proxy chains) is refused by design and grep-gated in launch-gates.
$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent $PSScriptRoot
. (Join-Path $repo 'payloads/ghrdp-mirror-diag.ps1')

$rows = New-Object System.Collections.ArrayList
$allPolicyBlock = $true
foreach ($cap in @($global:GhrdpMirrorHostCaps)) {
    $code = 0
    $out = & curl.exe -s -o NUL -w '%{http_code}' --max-time 20 -A 'ghrdp-mirror-diag/1.0' ([string]$cap.apiRoot) 2>$null
    if ($LASTEXITCODE -eq 0) { try { $code = [int](([string]($out -join '')).Trim()) } catch { $code = 0 } }
    $note = ''
    if ($code -ge 200 -and $code -lt 400) { $note = 'reachable'; $allPolicyBlock = $false }
    elseif ($code -eq 401 -or $code -eq 403) { $note = 'POLICY outcome: host blocks runner egress - mirror cannot use this host from ephemeral runners'; }
    elseif ($code -eq 405 -or $code -eq 404) { $note = 'reachable (api root wants POST)'; $allPolicyBlock = $false }
    elseif ($code -eq 429) { $note = 'rate-limited from runner egress'; $allPolicyBlock = $false }
    elseif ($code -ge 500) { $note = 'host-side error (transient)'; $allPolicyBlock = $false }
    else { $note = 'unreachable from runner (dns/tcp)'; $allPolicyBlock = $false }
    [void]$rows.Add(@{ host = [string]$cap.name; status = $code; note = $note })
    Write-Host ('F44PROBE | ' + [string]$cap.name + ' | ' + $code + ' | ' + $note)
}
if ($env:GITHUB_STEP_SUMMARY) {
    '### F44 real-host read-only probe (one GET per api root; no content upload)' | Add-Content -Path $env:GITHUB_STEP_SUMMARY
    '| host | status | note |' | Add-Content -Path $env:GITHUB_STEP_SUMMARY
    '| --- | ---: | --- |' | Add-Content -Path $env:GITHUB_STEP_SUMMARY
    foreach ($r in @($rows)) { ('| ' + $r.host + ' | ' + $r.status + ' | ' + $r.note + ' |') | Add-Content -Path $env:GITHUB_STEP_SUMMARY }
}
if ($allPolicyBlock -and @($rows).Count -gt 0) {
    Write-Host 'F44 POLICY DEAD END: every configured host refuses runner egress - documented (no evasion per F44 §3/§7)'
    if ($env:GITHUB_STEP_SUMMARY) { '> POLICY DEAD END: all hosts refuse runner egress. Documented; evasion refused by design.' | Add-Content -Path $env:GITHUB_STEP_SUMMARY }
}
exit 0
