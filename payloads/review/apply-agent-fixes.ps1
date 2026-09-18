[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Agent,
    [string]$Replacements = (Join-Path $PSScriptRoot 'ghrdp-agent-replacements.ps1')
)
$ErrorActionPreference = 'Stop'
function Parse-Source([string]$source) {
    $errors = $null
    [void][System.Management.Automation.PSParser]::Tokenize($source, [ref]$errors)
    if (@($errors).Count -gt 0) { throw 'PSParser rejected source; original not overwritten.' }
    $tokens = $null
    $astErrors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$astErrors)
    if (@($astErrors).Count -gt 0) { throw 'AST parser rejected source; original not overwritten.' }
    return $ast
}
function Replace-Once([string]$from, [string]$to) {
    $first = $script:text.IndexOf($from, [StringComparison]::Ordinal)
    if ($first -lt 0 -or $script:text.IndexOf($from, $first + $from.Length, [StringComparison]::Ordinal) -ge 0) { throw ('Expected exactly one patch anchor: ' + $from) }
    $script:text = $script:text.Substring(0, $first) + $to + $script:text.Substring($first + $from.Length)
}
$path = (Resolve-Path -LiteralPath $Agent).Path
$script:text = [IO.File]::ReadAllText($path).Replace("`r`n", "`n")
if ($script:text.Contains("'3.0.1-review'")) { throw 'Already patched; refusing an unreviewed second transformation.' }
[void](Parse-Source $script:text)
$replacementText = [IO.File]::ReadAllText((Resolve-Path -LiteralPath $Replacements).Path).Replace("`r`n", "`n")
$replacementAst = Parse-Source $replacementText
$functions = @($replacementAst.FindAll({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst]}, $false))
foreach ($function in $functions) {
    $name = $function.Name
    $ast = Parse-Source $script:text
    $matches = @($ast.FindAll({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name}, $false))
    if ($matches.Count -gt 1) { throw ('Duplicate function: ' + $name) }
    if ($matches.Count -eq 0) {
        Replace-Once '# ---- Entrypoint dispatch' ($function.Extent.Text + "`n`n" + '# ---- Entrypoint dispatch')
    } else {
        $replacement = $function.Extent.Text
        if ($name -eq 'Poll-Loop') {
            $core = $matches[0].Extent.Text.Replace('function Poll-Loop {', 'function Poll-LoopCore {')
            $replacement = $core + "`n`n" + $replacement
        }
        Replace-Once $matches[0].Extent.Text $replacement
    }
}
Replace-Once "`$script:Build       = '3.0.0'" "`$script:Build       = '3.0.1-review'"
Replace-Once "' Dispatch=' + `$Dispatch +" "' DispatchPresent=' + [bool]`$Dispatch +"
Replace-Once "`$ErrorActionPreference = 'Continue'" "`$ErrorActionPreference = 'Stop'"
Replace-Once "        ('redirectdrives:i:'    + [int][bool]`$opts.drives)," "        ('drivestoredirect:s:' + (`$(@('', '*')[[int][bool]`$opts.drives]))),"
$begin = $script:text.IndexOf('    # Gated agent.ps1 refresh (bug #58:')
$end = $script:text.IndexOf('    # Stable dev-key', $begin + 1)
if ($begin -lt 0 -or $end -lt $begin) { throw 'Enrollment refresh anchors missing.' }
$script:text = $script:text.Substring(0,$begin) + '    if (-not (Test-PsSyntax $script:AgentPath)) { throw ''installed-agent-unparseable'' }' + "`n`n" + $script:text.Substring($end)
Replace-Once "if (-not `$runner) { Log 'ENROLL FATAL: no runner discovered' 'ERR'; exit 0 }" "if (-not `$runner) { Log 'ENROLL FATAL: no runner discovered' 'ERR'; exit 1 }"
Replace-Once "if (-not `$resp -or -not `$resp.deviceToken) { Log 'ENROLL FATAL: no deviceToken in response' 'ERR'; exit 0 }" "if (-not `$resp -or -not `$resp.deviceToken -or -not `$resp.deviceId) { Log 'ENROLL FATAL: invalid enrollment response' 'ERR'; exit 1 }"
Replace-Once "    if (-not `$dev.deviceId) { `$dev.deviceId = [guid]::NewGuid().ToString('N') }" "    if (-not `$dev.deviceId) { throw 'missing-server-device-id' }"
Replace-Once "        try {`n            `$runner = Discover-Runner `$dev" "        try {`n            `$freshDevice = Load-Device`n            if (`$freshDevice -and `$freshDevice.deviceToken) { `$dev = `$freshDevice }`n            `$runner = Discover-Runner `$dev"
Replace-Once '            Consume-Pending $runner $dev' "            `$script:CommandRan = `$false`n            Consume-Pending `$runner `$dev`n            if (`$script:CommandRan) { `$tickHb = [DateTime]::UtcNow }"
Replace-Once "                Ladder-Connect `$runner `$dev `$cmd`n            }" "                Ladder-Connect `$runner `$dev `$cmd`n                `$tickHb = [DateTime]::UtcNow`n            }"
Replace-Once "    Log ('TOP-LEVEL EXCEPTION ' + `$_.Exception.Message) 'ERR'`n    exit 0" "    Log 'TOP-LEVEL EXCEPTION (details withheld to protect credentials)' 'ERR'`n    exit 1"
$script:text = $script:text.Replace([string][char]0x2014, '-').Replace([string][char]0x2013, '-')
if ($script:text -match '[^\x00-\x7F]') { throw 'Non-ASCII source remains; original not overwritten.' }
$finalAst = Parse-Source $script:text
$formatOps = @($finalAst.FindAll({param($n) $n -is [System.Management.Automation.Language.BinaryExpressionAst] -and $n.Operator -eq [System.Management.Automation.Language.TokenKind]::Format}, $true))
if ($formatOps.Count -gt 0) { throw 'Format operator remains; original not overwritten.' }
$tmp = $path + '.patch-new'
[IO.File]::WriteAllText($tmp, $script:text, (New-Object Text.UTF8Encoding($false)))
[void](Parse-Source ([IO.File]::ReadAllText($tmp)))
[IO.File]::Replace($tmp, $path, ($path + '.pre-review.bak'), $true)
Write-Host ('PATCH WRITTEN sha256=' + (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() + ' size=' + (Get-Item -LiteralPath $path).Length)
Write-Host 'NOT an acceptance PASS: run D0 and D1-D3. Runner logon proof remains unavailable.'
