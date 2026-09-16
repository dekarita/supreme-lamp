# verify-terminal.ps1 — GHRDP Terminal acceptance tests A-L
$ErrorActionPreference='Continue'
Add-Type -AssemblyName System.Web
$cfg = [System.IO.File]::ReadAllText('C:\ghrdp\config.json') | ConvertFrom-Json
$rdpUser = [string]$cfg.rdpUser
if (-not $rdpUser) { throw 'config.rdpUser empty' }
$token = 'ghrdp-term-' + $rdpUser
$base  = 'http://127.0.0.1:7331'
$auth  = @{ Authorization = 'Bearer ' + $token; 'Content-Type' = 'application/json' }
$results = @()
function Do-Post([string]$path, [hashtable]$body, [int]$timeoutSec=90) {
  $json = $body | ConvertTo-Json -Depth 6 -Compress
  try { $r = Invoke-WebRequest -Uri ($base+$path) -Method POST -Headers $auth -Body $json -TimeoutSec $timeoutSec -UseBasicParsing -ErrorAction Stop
    return @{ status = [int]$r.StatusCode; body = ($r.Content | ConvertFrom-Json) } }
  catch { return @{ status = -1; body = @{ error = $_.Exception.Message } } }
}
function Add-Result([string]$id, [string]$name, [bool]$pass, [string]$note='') {
  $script:results += [pscustomobject]@{ id=$id; name=$name; pass=$pass; note=$note }
  $tag = if ($pass) { 'PASS' } else { 'FAIL' }
  Write-Host ('[' + $tag + '] ' + $id + '  ' + $name + '  ' + $note)
}

# A. GET /terminal renders (auth by token in query)
try {
  $r = Invoke-WebRequest -Uri ($base+'/terminal?token='+$token) -UseBasicParsing -TimeoutSec 10 -ErrorAction Stop
  Add-Result 'A' 'GET /terminal HTML' ($r.StatusCode -eq 200 -and $r.Content -match '<title>GHRDP Terminal</title>') ('status=' + $r.StatusCode)
} catch { Add-Result 'A' 'GET /terminal HTML' $false $_.Exception.Message }

# B. Inline whoami SYSTEM
$b = Do-Post '/terminal-exec' @{ mode='inline'; session='system'; cmd='whoami'; timeout=15000 }
Add-Result 'B' 'inline whoami SYSTEM' ($b.status -eq 200 -and $b.body.exitCode -eq 0 -and ($b.body.output -match 'nt authority.system')) ('exit=' + $b.body.exitCode + ' out="' + $b.body.output.Trim() + '"')

# C. File mode
$c = Do-Post '/terminal-exec' @{ mode='file'; session='system'; file='C:\ghrdp\ghrdp-pub2.ps1'; timeout=10000 }
Add-Result 'C' 'file mode ghrdp-pub2.ps1' ($c.status -eq 200) ('exit=' + $c.body.exitCode + ' timedOut=' + $c.body.timedOut)

# D. Upload mode: 50-line script
$sb = New-Object System.Text.StringBuilder; 1..50 | ForEach-Object { [void]$sb.AppendLine("Write-Output 'line-$_'") }
$bytes = [System.Text.Encoding]::UTF8.GetBytes($sb.ToString()); $b64 = [Convert]::ToBase64String($bytes)
$d = Do-Post '/terminal-exec' @{ mode='upload'; session='system'; script_b64=$b64; timeout=20000 }
Add-Result 'D' 'upload 50-line script' ($d.status -eq 200 -and $d.body.exitCode -eq 0 -and ($d.body.output -match 'line-50')) ('exit=' + $d.body.exitCode + ' outLen=' + $d.body.output.Length)

# E. INTERACTIVE mode
$e = Do-Post '/terminal-exec' @{ mode='inline'; session='interactive'; cmd='whoami; [Console]::Out.Flush()'; timeout=30000 }
Add-Result 'E' 'interactive whoami' ($e.status -eq 200 -and $e.body.session -eq 'interactive') ('exit=' + $e.body.exitCode + ' out="' + ($e.body.output.Trim()) + '"')

# F. Long script, sufficient timeout
$f = Do-Post '/terminal-exec' @{ mode='inline'; session='system'; cmd='Start-Sleep -Seconds 3; "ok"'; timeout=30000 } 45
Add-Result 'F' 'long script within timeout' ($f.status -eq 200 -and $f.body.exitCode -eq 0 -and -not $f.body.timedOut) ('exit=' + $f.body.exitCode)

# G. Long script, timeout
$g = Do-Post '/terminal-exec' @{ mode='inline'; session='system'; cmd='Start-Sleep -Seconds 60; "wontprint"'; timeout=5000 } 30
Add-Result 'G' 'timeout kills process' ($g.status -eq 200 -and $g.body.timedOut -eq $true) ('timedOut=' + $g.body.timedOut + ' exit=' + $g.body.exitCode)

# H. Audit log grew
$auditBefore = 0; if (Test-Path 'C:\ghrdp\webdesk\terminal-audit.log') { $auditBefore = (Get-Item 'C:\ghrdp\webdesk\terminal-audit.log').Length }
$h = Do-Post '/terminal-exec' @{ mode='inline'; session='system'; cmd='"audit-probe"'; timeout=5000 }
Start-Sleep -Milliseconds 400
$auditAfter = 0; if (Test-Path 'C:\ghrdp\webdesk\terminal-audit.log') { $auditAfter = (Get-Item 'C:\ghrdp\webdesk\terminal-audit.log').Length }
Add-Result 'H' 'audit log grows' ($auditAfter -gt $auditBefore) ('before=' + $auditBefore + ' after=' + $auditAfter)

# I. Rapid sequential (file-lock race)
$iOk = $true; $iErr = ''
for ($i=1; $i -le 6; $i++) {
  $r = Do-Post '/terminal-exec' @{ mode='inline'; session='system'; cmd=('"loop-' + $i + '"'); timeout=5000 }
  if ($r.status -ne 200 -or $r.body.exitCode -ne 0) { $iOk = $false; $iErr = ('#' + $i + ' status=' + $r.status + ' exit=' + $r.body.exitCode); break }
}
Add-Result 'I' 'rapid sequential no file-lock' $iOk $iErr

# J. Reduced-transparency (page-level; manual visual, but auto-check CSS is present)
try { $j = Invoke-WebRequest -Uri ($base+'/terminal?token='+$token) -UseBasicParsing -TimeoutSec 10
  Add-Result 'J' 'reduced-transparency fallback CSS present' ($j.Content -match 'prefers-reduced-transparency') '' }
catch { Add-Result 'J' 'reduced-transparency fallback CSS present' $false $_.Exception.Message }

# K. Non-Chromium fallback CSS present
try { Add-Result 'K' 'backdrop-filter @supports fallback present' ($j.Content -match '@supports not \(backdrop-filter') '' }
catch { Add-Result 'K' 'backdrop-filter @supports fallback present' $false 'no fetch' }

# L. Unauthorized token → 401
try { $r = Invoke-WebRequest -Uri ($base+'/terminal-exec') -Method POST -Headers @{ Authorization='Bearer wrong-token'; 'Content-Type'='application/json' } -Body '{}' -TimeoutSec 10 -UseBasicParsing -ErrorAction Stop
  Add-Result 'L' '401 on bad token' $false ('unexpected status=' + $r.StatusCode) }
catch {
  $sc = 0; try { $sc = [int]$_.Exception.Response.StatusCode.value__ } catch { }
  Add-Result 'L' '401 on bad token' ($sc -eq 401) ('status=' + $sc)
}

# Summary
$pass = ($results | Where-Object { $_.pass }).Count
$fail = ($results | Where-Object { -not $_.pass }).Count
Write-Host ''
Write-Host '=================================================='
Write-Host ('SUMMARY: ' + $pass + ' passed, ' + $fail + ' failed of ' + $results.Count)
Write-Host '=================================================='
$results | Format-Table id,pass,name,note -AutoSize | Out-String | Write-Host
exit ([int]($fail -gt 0))
