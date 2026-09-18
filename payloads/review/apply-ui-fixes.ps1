[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Ui,
    [string]$Panel = (Join-Path $PSScriptRoot 'rdp-panel.html')
)
$ErrorActionPreference = 'Stop'
$path = (Resolve-Path -LiteralPath $Ui).Path
$script:html = [IO.File]::ReadAllText($path).Replace("`r`n", "`n")
if ($script:html.Contains('id="ghrdpControl"')) { throw 'UI already patched; refusing a second transformation.' }
function Replace-One([string]$old, [string]$new) {
    $i = $script:html.IndexOf($old, [StringComparison]::Ordinal)
    if ($i -lt 0 -or $script:html.IndexOf($old, $i + $old.Length, [StringComparison]::Ordinal) -ge 0) { throw ('UI patch anchor missing or ambiguous: ' + $old) }
    $script:html = $script:html.Substring(0,$i) + $new + $script:html.Substring($i+$old.Length)
}
function Remove-Block([string]$begin, [string]$end) {
    $i = $script:html.IndexOf($begin, [StringComparison]::Ordinal)
    if ($i -lt 0) { throw ('Missing UI block: ' + $begin) }
    $j = $script:html.IndexOf($end, $i + $begin.Length, [StringComparison]::Ordinal)
    if ($j -lt 0) { throw ('Missing UI block end: ' + $end) }
    Replace-One ($script:html.Substring($i, $j + $end.Length - $i)) ''
}
foreach ($marker in @('function showSetupOverlay(ip)', "sessionStorage.getItem('ghrdpOrch')", 'SESSION LIVE - WEB DESKTOP buttons active', 'function b64buf(buf)', 'ghrdp-term-')) {
    $matches = @([regex]::Matches($script:html, '<script\b[^>]*>[\s\S]*?</script>') | Where-Object { $_.Value.Contains($marker) })
    if ($matches.Count -ne 1) { throw ('Expected one legacy script containing: ' + $marker) }
    Replace-One $matches[0].Value ''
}
Remove-Block '<div class="row"><span class="k">RDP password</span>' '</div>'
Remove-Block '<div class="row"><span class="k">One-click RDP</span>' '</div>'
Remove-Block '<div class="row"><span class="k">Parsec auto-login</span>' '</div>'
Remove-Block '<section class="glass" id="installPanel"' '</section>'
Remove-Block '<div id="termRow"' '</div>'
$old = @'
  if(c.pass)$('credPass').textContent=c.pass;
'@
Replace-One $old ''
$start = $script:html.IndexOf('  if(c.ip&&c.user){')
$end = $script:html.IndexOf('  if(d.runnerEgressIp){', $start + 1)
if ($start -lt 0 -or $end -lt $start) { throw 'Missing legacy credential URL builder.' }
Replace-One ($script:html.Substring($start, $end-$start)) ''
$old = @'
var ic=$('instCmd');if(ic)ic.textContent='irm http://'+c.ip+':7331/install.ps1 | iex';
'@
Replace-One $old ''
$old = @'
  var rn=$('rentryNew');
  if(d.rentryNewUrl){rn.textContent=d.rentryNewUrl;rn.href=d.rentryNewUrl;}else{rn.textContent='(not created yet)';rn.href='javascript:void(0)';}
'@
$new = @'
  var rn=$('rentryNew');
  if(rn){if(d.rentryNewUrl){rn.textContent=d.rentryNewUrl;rn.href=d.rentryNewUrl;}else{rn.textContent='(not created yet)';rn.href='javascript:void(0)';}}
'@
Replace-One $old $new
Replace-One 'var lastData=null,lostCount=0,ws=null,wsTimer=null,wsAlive=false,pollTimer=null;' 'var lastData=null,lostCount=0,ws=null,wsTimer=null,wsAlive=false,pollTimer=null,wsLive=false;'
$old = @'
async function getJson(url){try{var r=await fetch(url,{cache:'no-store'});if(!r.ok)return null;return await r.json()}catch(e){return null}}
'@
$new = @'
function keyedPath(path){var u=new URL(path,location.origin);if(u.origin!==location.origin)throw new Error('Cross-origin API rejected');var key=new URLSearchParams(location.search).get('key');if(key)u.searchParams.set('key',key);return u.href;}
async function getJson(url){try{var r=await fetch(keyedPath(url),{cache:'no-store',referrerPolicy:'no-referrer'});if(!r.ok)return null;return await r.json()}catch(e){return null}}
'@
Replace-One $old $new
foreach ($route in @('/api/progress','/health','/ping')) {
    $script:html = $script:html.Replace(('fetch(''' + $route + ''','), ('fetch(keyedPath(''' + $route + '''),'))
}
$script:html = [regex]::Replace($script:html, '<link[^>]+href="https://fonts\.(googleapis|gstatic)\.com[^"]*"[^>]*>\s*', '')
Replace-One '<meta charset="utf-8">' '<meta charset="utf-8"><meta name="referrer" content="no-referrer">'
$panelText = [IO.File]::ReadAllText((Resolve-Path -LiteralPath $Panel).Path)
Replace-One '</body>' ($panelText + "`n</body>")
if ($script:html -match '__PASS__|credPass|ghrdp-term-|b64u\(c\.pass|mode=parsec-push|ghrdpOrch') { throw 'Retired credential/handler code remains; original not overwritten.' }
$tmp = $path + '.patch-new'
[IO.File]::WriteAllText($tmp, $script:html, (New-Object Text.UTF8Encoding($false)))
[IO.File]::Replace($tmp, $path, ($path + '.pre-review.bak'), $true)
Write-Host ('UI PATCH WRITTEN sha256=' + (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() + ' size=' + (Get-Item -LiteralPath $path).Length)
Write-Host 'Run JavaScript syntax/DOM checks on the resulting full UI; browser/uBlock checks remain required.'
