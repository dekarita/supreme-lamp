# F27 mechanical proof only. Synthetic socket identities are NOT live tailnet/NLA proof.
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$Root = Join-Path ([IO.Path]::GetTempPath()) ('f27-' + [guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $Root
$script:NoBom = New-Object Text.UTF8Encoding($false)
$script:CfgPath = Join-Path $Root 'config.json'
$script:RdpTokens = @{}
$script:TicketAudit = [ordered]@{ issued=0; redeemed=0; rejected=0 }
$script:HandlerChain = @()
$stage = 'initialization'
function Assert-F27([bool]$Condition, [string]$Label) { if (-not $Condition) { throw ('F27 assertion: ' + $Label) } }
function Assert-F28([bool]$Condition, [string]$Label) { if (-not $Condition) { throw ('F28 assertion: ' + $Label) } }
function Import-Functions([string]$Text, [string[]]$Names) {
    $tokens = $null; $errors = $null
    $ast = [Management.Automation.Language.Parser]::ParseInput($Text, [ref]$tokens, [ref]$errors)
    Assert-F27 ($errors.Count -eq 0) 'PowerShell syntax'
    foreach ($name in $Names) {
        $fn = $ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name}, $true)
        Assert-F27 ($null -ne $fn) ('function exists: ' + $name)
        # Import function into the caller scope, not this helper's scope.
        $definition = $fn.Extent.Text -replace '^function\s+([\w-]+)', 'function script:$1'
        . ([scriptblock]::Create($definition))
    }
}
function Request-F27([string]$Path, [string]$Method, [string]$Source, [string]$Body='', [string]$Auth='') {
    $raw = "$Method $Path HTTP/1.1`r`nHost: fixture.ts.net`r`nAuthorization: $Auth`r`nContent-Type: application/json`r`nContent-Length: $([Text.Encoding]::UTF8.GetByteCount($Body))`r`n`r`n$Body"
    $inputBytes = [Text.Encoding]::UTF8.GetBytes($raw)
    $mem = New-Object IO.MemoryStream
    $mem.Write($inputBytes,0,$inputBytes.Length); $mem.Position=0
    $client = [pscustomobject]@{ Stream=$mem; Client=[pscustomobject]@{ RemoteEndPoint=[pscustomobject]@{Address=[Net.IPAddress]::Parse($Source)} } }
    $client | Add-Member ScriptMethod GetStream { return $this.Stream }
    $client | Add-Member ScriptMethod Close { }
    Invoke-ClientRequest -Client $client -Token 'fixture-dashboard-bearer'
    $all = $mem.ToArray()
    $response = [Text.Encoding]::UTF8.GetString($all,$inputBytes.Length,$all.Length-$inputBytes.Length)
    $match = [regex]::Match($response, '^HTTP/1.1 (\d+)')
    Assert-F27 $match.Success 'route produced HTTP response'
    $bodyText = ($response -split "`r`n`r`n",2)[1]
    return [pscustomobject]@{ Code=[int]$match.Groups[1].Value; Body=$bodyText }
}
try {
    $stage = 'server route extraction'
    $source = [IO.File]::ReadAllText((Join-Path $repo 'payloads/ghrdp-server.ps1'))
    Import-Functions $source @('Read-JsonFile','Get-RequestParts','Test-IsLoopbackAddr','Test-ClientAllowed','Test-CredsAllowed','Test-TicketBearer','Test-TicketSource','Write-TicketAudit','Use-RdpTicket','Read-ClientRequest','Send-ClientResponse','ConvertTo-JsonBytes','Invoke-ClientRequest')
    $fixture = 'F27!' + [guid]::NewGuid().ToString('N')
    $config = @{dnsName='fixture.tail.ts.net';rdpUser='fixture-user';rdpPass=$fixture;hostKind='ephemeral'}
    [IO.File]::WriteAllText($script:CfgPath,($config | ConvertTo-Json),$script:NoBom)
    $stage = 'ticket issue authorization'
    Assert-F27 ((Request-F27 '/api/rdp-token' 'POST' '100.64.0.7').Code -eq 401) 'missing bearer rejected'
    Assert-F27 ((Request-F27 '/api/rdp-token' 'POST' '100.64.0.7' '' 'Bearer wrong').Code -eq 401) 'wrong bearer rejected'
    Assert-F27 ((Request-F27 '/api/rdp-token' 'POST' '127.0.0.1' '' 'Bearer fixture-dashboard-bearer').Code -eq 403) 'loopback issue rejected'
    function Issue-F27 {
        $r = Request-F27 '/api/rdp-token' 'POST' '100.64.0.7' '' 'Bearer fixture-dashboard-bearer'
        Assert-F27 ($r.Code -eq 200) 'ephemeral issue succeeds'
        $j = $r.Body | ConvertFrom-Json
        Assert-F27 ($j.ttl -eq 60 -and $j.rid -cmatch '^[0-9a-f]{32}$') 'ticket format and ttl'
        return [string]$j.rid
    }
    $ticket = Issue-F27
    $body = @{token=$ticket} | ConvertTo-Json -Compress
    $stage = 'wrong source, one use, expiry'
    Assert-F27 ((Request-F27 '/api/rdp-creds' 'POST' '100.64.0.8' $body).Code -eq 401) 'other tailnet peer rejected'
    Assert-F27 ((Request-F27 '/api/rdp-creds' 'POST' '127.0.0.1' $body).Code -eq 403) 'loopback redeem rejected'
    Assert-F27 ((Request-F27 '/api/rdp-creds?key=fixture-dashboard-bearer' 'POST' '203.0.113.1' $body).Code -eq 403) 'bearer cannot authorize public redemption'
    Assert-F27 ((Request-F27 '/api/rdp-creds' 'GET' '100.64.0.7').Code -eq 403) 'GET rejected'
    Assert-F27 ((Request-F27 '/api/rdp-creds' 'POST' '100.64.0.7' '{}').Code -eq 401) 'no ticket rejected'
    $redeem = Request-F27 '/api/rdp-creds' 'POST' '100.64.0.7' $body
    Assert-F27 ($redeem.Code -eq 200) 'redeem succeeds'
    $j = $redeem.Body | ConvertFrom-Json
    Assert-F27 ($j.fqdn -ceq $config.dnsName -and $j.user -ceq $config.rdpUser -and $j.pass -ceq $fixture) 'exact in-memory reply'
    Assert-F27 ((Request-F27 '/api/rdp-creds' 'POST' '100.64.0.7' $body).Code -eq 401) 'replay rejected'
    $expired = Issue-F27
    $script:RdpTokens[$expired].created = [datetime]::UtcNow.AddSeconds(-60)
    Assert-F27 ((Request-F27 '/api/rdp-creds' 'POST' '100.64.0.7' (@{token=$expired}|ConvertTo-Json)).Code -eq 401) 'expiry rejected'
    foreach ($ip in @('100.64.0.1','100.127.255.255','fd7a:115c:a1e0::1','::ffff:100.64.0.1')) { Assert-F27 (Test-TicketSource ([Net.IPAddress]::Parse($ip))) 'tailnet accepted' }
    foreach ($ip in @('127.0.0.1','::1','100.63.255.255','100.128.0.1','192.168.1.1','fd7a:115c:a1e1::1')) { Assert-F27 (-not (Test-TicketSource ([Net.IPAddress]::Parse($ip)))) 'non-tailnet rejected' }
    $audit = [IO.File]::ReadAllText((Join-Path $Root 'rdp-token-audit.log'))
    Assert-F27 (-not $audit.Contains($ticket) -and -not $audit.Contains($fixture)) 'audit has no ticket or password'
    foreach ($line in ($audit.Trim() -split "`n")) {
        $row = $line | ConvertFrom-Json
        Assert-F27 ((($row.PSObject.Properties.Name | Sort-Object) -join ',') -eq 'counts,source,ts') 'audit schema allowlist'
    }
    Write-Host 'F27 PASS: shipped HTTP routes, bearer, source binding, replay, expiry, audit schema (synthetic socket peers)'

    $stage = 'collector mapping'
    $wf = [IO.File]::ReadAllText((Join-Path $repo '.github/workflows/main.yml'))
    $a = $wf.IndexOf('collector-begin]'); $a = $wf.LastIndexOf('# ', $a)
    $b = $wf.IndexOf('collector-end]', $a); $b = $wf.LastIndexOf('# ', $b)
    $col = ($wf.Substring($a,$b-$a) -split "`r?`n" | ForEach-Object { $_ -replace '^          ','' }) -join "`n"
    Import-Functions $col @('Get-RdpAuthEventFields','Get-RdpAuthCodeMeaning','Get-RdpAuthEventSummary')
    function Event-F27($Id,$Type,$Time) {
        return Get-RdpAuthEventFields ([xml]"<Event><System><EventID>$Id</EventID><TimeCreated SystemTime='$Time'/></System><EventData><Data Name='LogonType'>$Type</Data><Data Name='SubStatus'>0xC000006A</Data><Data Name='FailureReason'>%%2313</Data><Data Name='TargetUserName'>fixture-user</Data><Data Name='SubjectUserName'>must-not-leak</Data></EventData></Event>")
    }
    $events = @((Event-F27 4624 10 '2026-09-26T12:03:00Z'),(Event-F27 4625 3 '2026-09-26T12:02:00Z'),(Event-F27 4624 3 '2026-09-26T12:04:00Z'),(Event-F27 4625 3 '2026-09-26T12:01:00Z'))
    $summary = Get-RdpAuthEventSummary $events
    Assert-F27 ($summary.count4624 -eq 1 -and $summary.count4625 -eq 2) 'only type 10 successes'
    Assert-F27 ($summary.last4624At -eq '2026-09-26T12:03:00Z' -and $summary.last4625At -eq '2026-09-26T12:02:00Z') 'newest event timestamps independent of input ordering'
    Assert-F27 ($summary.lastSubStatus -eq '0XC000006A' -and $summary.failures[0].targetUserName -eq 'fixture-user' -and $summary.failures[0].failureReason -eq '%%2313') 'failure mapping'
    Assert-F27 (-not ($summary|ConvertTo-Json -Depth 6).Contains('must-not-leak')) 'no subject identity'
    Write-Host 'F27 PASS: shipped 4624 type-10 and 4625 collector mapping'

    $stage = 'framework compile'
    $csc = Join-Path $env:SystemRoot 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
    $exe = Join-Path $Root 'launcher.exe'
    & $csc /nologo /target:winexe /out:$exe /r:System.dll /r:System.Windows.Forms.dll /r:System.Web.Extensions.dll (Join-Path $repo 'payloads/ghrdp-rdp-launcher.cs')
    Assert-F27 ($LASTEXITCODE -eq 0) 'C#5 compile'
    $type = [Reflection.Assembly]::LoadFrom($exe).GetType('GhrdpRdpLauncher')
    $flags = [Reflection.BindingFlags]'Static,NonPublic'
    function Call-F27([string]$Name, [object[]]$Arguments) { return $type.GetMethod($Name,$flags).Invoke($null,$Arguments) }
    $stage = 'CredWrite overwrite and exact target'
    # Domain-password blobs are opaque to ordinary CredRead callers. Verify
    # overwrite via changed username + exact target/type/persist, not blob export.
    # Only the user's live 4624 can prove the stored password authenticates.
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class F27Read {
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
 public struct C { public uint Flags,Type; public string Target,Comment; public System.Runtime.InteropServices.ComTypes.FILETIME Time; public uint Size; public IntPtr Blob; public uint Persist,Count; public IntPtr Attr; public string Alias,User; }
 [DllImport("advapi32.dll",EntryPoint="CredReadW",CharSet=CharSet.Unicode,SetLastError=true)] public static extern bool Read(string t,uint type,uint f,out IntPtr p);
 [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr p);
 [DllImport("advapi32.dll",EntryPoint="CredDeleteW",CharSet=CharSet.Unicode)] public static extern bool Delete(string t,uint type,uint f);
 [DllImport("advapi32.dll",EntryPoint="CredWriteW",CharSet=CharSet.Unicode,SetLastError=true)] public static extern bool Write(ref C c,uint flags);
 public static bool SeedGeneric(string target) { string fixture="synthetic-stale"; IntPtr p=Marshal.StringToCoTaskMemUni(fixture); try { C c=new C(); c.Type=1; c.Target=target; c.User="fixture-old-user"; c.Persist=2; c.Size=(uint)(fixture.Length*2); c.Blob=p; return Write(ref c,0); } finally { Marshal.ZeroFreeCoTaskMemUnicode(p); } }
 public static bool Matches(string target,string user,uint type) { IntPtr p; if(!Read(target,type,0,out p))return false; try { C c=(C)Marshal.PtrToStructure(p,typeof(C)); return c.Target==target && c.User==user && c.Type==type && c.Persist==2; } finally { CredFree(p); } }
}
'@
    $fqdn = 'f27-' + [guid]::NewGuid().ToString('N') + '.tail.ts.net'
    $target = 'TERMSRV/' + $fqdn
    try {
        Assert-F27 ([F27Read]::SeedGeneric($target)) 'legacy generic entry seeded'
        $null = Call-F27 'WriteCredential' @($fqdn,'fixture-old-user','poisoned-fixture')
        Assert-F27 ([F27Read]::Matches($target,'fixture-old-user',2)) 'initial entry exists'
        $null = Call-F27 'WriteCredential' @($fqdn,'fixture-user',$fixture)
        Assert-F27 ([F27Read]::Matches($target,'fixture-user',2)) 'CredWrite overwrites exact domain target'
        Assert-F27 ([F27Read]::Matches($target,'fixture-user',1)) 'legacy generic entry also refreshed'
        $lines = Call-F27 'RdpLines' @($fqdn,'fixture-user')
        Assert-F27 ($lines -contains ('full address:s:' + $target.Substring(8))) 'RDP full address exactly matches credential target suffix'
        Assert-F27 (($lines -contains 'screen mode id:i:2') -and -not (($lines -join "`n") -match 'password|credential|authentication level')) 'options only, no weakening'
    } finally { $null = [F27Read]::Delete($target,2,0); $null = [F27Read]::Delete($target,1,0) }
    $reason = Call-F27 'RedeemAndStore' @('ghrdp://rdp?server=fixture.tail.ts.net','fixture.tail.ts.net','fixture-user','',7331)
    Assert-F27 ($reason -eq 'ticket-missing') 'missing ticket fallback'
    Assert-F27 ((Call-F27 'FallbackBeacon' @($reason)) -eq 'fallback-cmdkey reason=ticket-missing') 'fallback beacon reason'
    # URL context is intentional: the real logger never logs raw URI input.
    $redacted = Call-F27 'Redact' @('?t=' + $ticket + '&password=' + $fixture)
    Assert-F27 (-not $redacted.Contains($ticket) -and -not $redacted.Contains($fixture)) 'redaction'
    # [F28 §1] The SHIPPED server-side logon scanner (extracted verbatim from
    # payloads/ghrdp-server.ps1) driven with synthetic 4624/4625 events: the
    # logon RESULT (not just counts), the wrong-password sub-status and the
    # always-present scanTs the dashboard's LAST RDP LOGON row renders.
    $stage = 'F28 logon scanner (synthetic events)'
    $srvText = [IO.File]::ReadAllText((Join-Path $repo 'payloads/ghrdp-server.ps1'))
    $sa = $srvText.IndexOf('# [F28 §1 scanner-begin]')
    $sb = $srvText.IndexOf('# [F28 §1 scanner-end]', [Math]::Max($sa, 0))
    Assert-F28 ($sa -gt 0 -and $sb -gt $sa) 'the F28 scanner markers are missing in ghrdp-server.ps1'
    . ([scriptblock]::Create($srvText.Substring($sa, $sb - $sa)))
    Assert-F28 ($null -ne (Get-Command Get-RdpLogonAuthLast -ErrorAction SilentlyContinue)) 'the extracted block did not define the scanner'
    $startF28 = (Get-Date).ToUniversalTime()
    function New-F28Event([int]$Id, [string]$TimeUtc, [string]$LogonType, [string]$Status, [string]$SubStatus) {
        $tpl = '<Event xmlns="http://schemas.microsoft.com/win/2004/08/events/event"><System><EventID>{ID}</EventID><TimeCreated SystemTime="{T}"/></System><EventData><Data Name="LogonType">{LT}</Data><Data Name="Status">{ST}</Data><Data Name="SubStatus">{SUB}</Data><Data Name="FailureReason">%%2313</Data><Data Name="TargetUserName">f28-decoy</Data><Data Name="SubjectUserName">must-not-leak</Data></EventData></Event>'
        $xml = $tpl.Replace('{ID}', [string]$Id).Replace('{T}', $TimeUtc).Replace('{LT}', $LogonType).Replace('{ST}', $Status).Replace('{SUB}', $SubStatus)
        return (Get-RdpLogonEventFields -Xml ([xml]$xml))
    }
    $iso28 = { param([int]$d) $startF28.AddSeconds($d).ToString('o') }
    $failEv = New-F28Event 4625 (& $iso28 -30) '3' '0xC000006D' '0xC000006A'
    $okEv = New-F28Event 4624 (& $iso28 -10) '10' '' ''
    $consoleEv = New-F28Event 4624 (& $iso28 -5) '3' '' ''
    $staleEv = New-F28Event 4625 (& $iso28 -4000) '3' '0xC000006D' '0xC000006A'
    $r1 = Get-RdpLogonAuthLast -Items @($failEv) -ScanStartedUtc $startF28
    Assert-F28 ($r1.result -eq 'failed') ('a rejected password must stamp failed, got ' + $r1.result)
    Assert-F28 ($r1.sub -eq '0XC000006A' -and $r1.subMeaning -eq 'wrong-password') 'the wrong-password sub-status mapping'
    Assert-F28 (([string]$r1.scanTs).Length -gt 0 -and ([string]$r1.eventTs).Length -gt 0) 'scanTs/eventTs are always stamped'
    $r2 = Get-RdpLogonAuthLast -Items @($failEv, $okEv) -ScanStartedUtc $startF28
    Assert-F28 ($r2.result -eq 'success') 'a newer type-10 logon must supersede the failure'
    $r3 = Get-RdpLogonAuthLast -Items @() -ScanStartedUtc $startF28
    Assert-F28 ($r3.result -eq 'none' -and ([string]$r3.scanTs).Length -gt 0) 'an empty window still stamps scanTs'
    $r5 = Get-RdpLogonAuthLast -Items @($consoleEv) -ScanStartedUtc $startF28
    Assert-F28 ($r5.result -eq 'none') 'a type-3 console logon is never an RDP success'
    $r6 = Get-RdpLogonAuthLast -Items @($staleEv) -ScanStartedUtc $startF28
    Assert-F28 ($r6.result -eq 'none') 'a pre-window failure leaked into the verdict'
    Assert-F28 (-not (($r1 | ConvertTo-Json -Depth 5).Contains('must-not-leak'))) 'the verdict carries a subject identity'
    Write-Host 'F28 PASS: shipped logon scanner - failed(0xC000006A)/success/empty verdicts, scanTs on every path, no identity fields'

    # [F28 §3] The shipped C# decision function (reflection on the compiled exe)
    # plus the real --fallback-selftest harness: stored=false can only ever end
    # in the native-prompt path with its beacon - never a silent mstsc launch.
    $stage = 'F28 fallback-gap decision (shipped C#)'
    Assert-F28 ((Call-F27 'CredentialFallbackDecision' @($false, $false, $false)) -eq 'mstsc') 'a stored credential must launch normally'
    Assert-F28 ((Call-F27 'CredentialFallbackDecision' @($true, $true, $true)) -eq 'mstsc') 'a successful retry redemption launches normally'
    Assert-F28 ((Call-F27 'CredentialFallbackDecision' @($true, $true, $false)) -eq 'native-prompt') 'a failed retry must use the native credential prompt'
    Assert-F28 ((Call-F27 'CredentialFallbackDecision' @($true, $false, $false)) -eq 'native-prompt') 'a ticket-less miss must use the native credential prompt'
    $csText = [IO.File]::ReadAllText((Join-Path $repo 'payloads/ghrdp-rdp-launcher.cs'))
    $ms0 = $csText.IndexOf('private static int MstscStep'); $ms1 = $csText.IndexOf('private static int DoWork')
    Assert-F28 ($ms0 -gt 0 -and $ms1 -gt $ms0) 'the MstscStep region could not be extracted'
    $msText = $csText.Substring($ms0, $ms1 - $ms0)
    $beaconAt = $msText.IndexOf('fallback-mstsc-native-prompt'); $launchAt = $msText.IndexOf('new ProcessStartInfo("mstsc.exe"')
    Assert-F28 ($beaconAt -gt 0 -and $launchAt -gt $beaconAt) 'the native-prompt beacon must precede the mstsc launch'
    Assert-F28 ($csText.Contains('"recred-redeemed"')) 'the recred redemption beacon is missing'
    $fbOut = Join-Path $Root 'f28-fallback.txt'
    $env:GHRDP_LAB_OUT = $fbOut
    $env:GHRDP_LAB_NOMSG = '1'
    $fp = Start-Process -FilePath $exe -ArgumentList '--fallback-selftest' -PassThru
    $fp.WaitForExit()
    Assert-F28 ($fp.ExitCode -eq 0) ('--fallback-selftest exit ' + $fp.ExitCode)
    Assert-F28 (Test-Path -LiteralPath $fbOut) '--fallback-selftest wrote no matrix file'
    $fbTxt = [IO.File]::ReadAllText($fbOut)
    Assert-F28 ($fbTxt.Contains('storeMissing=true ticketPresent=true retryRedeemOk=false decision=native-prompt expected=native-prompt nativePrompt=true beacon=fallback-mstsc-native-prompt verdict=pass')) 'the closed-gap case is not in the matrix'
    Assert-F28 ($fbTxt.Contains('storeMissing=true ticketPresent=false retryRedeemOk=false decision=native-prompt expected=native-prompt nativePrompt=true beacon=fallback-mstsc-native-prompt verdict=pass')) 'the ticket-less case is not in the matrix'
    Assert-F28 (-not ($fbTxt -like '*verdict=FAIL*')) 'a fallback matrix case reported FAIL'
    Assert-F28 ($fbTxt.Contains('mstscLaunched=0 cmdkeyCalled=0')) 'the fallback selftest touched mstsc/cmdkey'
    Write-Host 'F28 PASS: shipped fallback-gap decision (4/4) + native-prompt beacon ordering; stored=false never reaches a silent mstsc'
} catch {
    # Never print exception messages/bodies/fixtures; stage alone maps failures.
    Write-Host ('::error::F27 mechanical proof failed at stage=' + $stage + ' type=' + $_.Exception.GetType().Name + ' line=' + $_.InvocationInfo.ScriptLineNumber)
    if ($_.Exception.Message -like 'F27 assertion:*') { Write-Host $_.Exception.Message }
    exit 1
} finally {
    Remove-Item -LiteralPath $Root -Recurse -Force -ErrorAction SilentlyContinue
}
