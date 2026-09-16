param(
    [int]$Port = 7331,
    [string]$Bind = '0.0.0.0',
    [string]$Root = 'C:\ghrdp',
    [int]$LimitMinutes = 350
)
$ErrorActionPreference = 'Continue'
$script:CfgPath = Join-Path $Root 'config.json'
$script:ProgPath = Join-Path $Root 'progress.json'
$script:UiPath = Join-Path $Root 'ui.html'
$script:InstPath = Join-Path $Root 'ghrdp-install.ps1'
$script:OkFile = Join-Path $Root 'server-ok.txt'
$script:FlushFlag = Join-Path $Root 'flush.flag'
$script:NoBom = New-Object System.Text.UTF8Encoding($false)
$script:WebDeskHtml = @'
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>GHRDP Web Desktop</title>
<style>
*{box-sizing:border-box}html,body{margin:0;padding:0;height:100%;background:#05070d;color:#e6eef6;font-family:-apple-system,"SF Pro Text","Segoe UI",system-ui,sans-serif;overflow:hidden}
.stage{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#000}
.wrap{position:relative;width:100%;height:100%;overflow:auto;display:flex;align-items:center;justify-content:center}
#view{display:block;background:#000;user-select:none;-webkit-user-select:none;image-rendering:auto;touch-action:none}
.blob{position:fixed;inset:-20%;z-index:-1;pointer-events:none;filter:blur(90px);opacity:.35}
.blob b{position:absolute;display:block;border-radius:50%;mix-blend-mode:screen}
.blob b.a{width:55vw;height:55vw;left:-10vw;top:-10vh;background:radial-gradient(circle,#22d3ee 0,transparent 60%);animation:d1 60s ease-in-out infinite alternate}
.blob b.b{width:50vw;height:50vw;right:-15vw;bottom:-15vh;background:radial-gradient(circle,#a78bfa 0,transparent 60%);animation:d2 74s ease-in-out infinite alternate}
@keyframes d1{to{transform:translate3d(6vw,4vh,0) scale(1.1)}}
@keyframes d2{to{transform:translate3d(-6vw,-4vh,0) scale(1.08)}}
.hint{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);color:#93a3b8;font-size:14px;text-align:center;z-index:5;background:rgba(0,0,0,.4);padding:12px 20px;border-radius:14px}
.hint.hidden{display:none}
.toolbar{position:fixed;left:50%;bottom:calc(16px + env(safe-area-inset-bottom));transform:translateX(-50%);z-index:20;
 display:flex;gap:8px;padding:8px 12px;border-radius:16px;
 background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.14);
 box-shadow:inset 0 1px 0 rgba(255,255,255,.12),0 20px 60px rgba(0,0,0,.55);
 backdrop-filter:blur(18px) saturate(1.6);-webkit-backdrop-filter:blur(18px) saturate(1.6);
 color:#eef2f7;font-size:12px;align-items:center;max-width:calc(100vw - 32px);flex-wrap:wrap}
@supports (backdrop-filter: url(#lg-refract)){.toolbar{backdrop-filter:url(#lg-refract) blur(18px) saturate(1.6);-webkit-backdrop-filter:blur(18px) saturate(1.6)}}
@supports not (backdrop-filter: blur(1px)){.toolbar{background:rgba(20,22,28,.92)}}
@media (prefers-reduced-transparency: reduce){.toolbar{background:rgba(20,22,28,.92);backdrop-filter:none;-webkit-backdrop-filter:none}}
@media (prefers-reduced-motion: reduce){.blob b{animation:none!important}}
.toolbar button,.toolbar .badge{appearance:none;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.14);color:#eef2f7;font:600 12px/1 -apple-system,system-ui;padding:8px 12px;border-radius:999px;cursor:pointer;transition:transform .12s cubic-bezier(.32,.72,0,1),background .18s}
.toolbar button:hover{background:rgba(255,255,255,.14)}
.toolbar button:active{transform:scale(.96)}
.toolbar button.on{background:linear-gradient(135deg,#22d3ee,#34d399);color:#05070d;border-color:transparent;font-weight:700}
.toolbar .badge{cursor:default;font-variant-numeric:tabular-nums;background:rgba(0,0,0,.35)}
.toolbar .sep{width:1px;height:22px;background:rgba(255,255,255,.14);margin:0 4px}
.toolbar :focus-visible{outline:none;box-shadow:0 0 0 2px rgba(34,211,238,.65)}
</style>
<svg width="0" height="0" style="position:absolute" aria-hidden="true">
 <filter id="lg-refract" x="0%" y="0%" width="100%" height="100%">
  <feTurbulence type="fractalNoise" baseFrequency="0.012 0.020" numOctaves="2" seed="7"/>
  <feDisplacementMap in="SourceGraphic" scale="14"/>
  <feSpecularLighting surfaceScale="2" specularConstant=".35" specularExponent="20" lighting-color="#ffffff" result="spec">
   <feDistantLight azimuth="235" elevation="55"/>
  </feSpecularLighting>
  <feComposite in="spec" in2="SourceGraphic" operator="in" result="specIn"/>
  <feColorMatrix in="specIn" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 .35 0"/>
 </filter>
</svg>
</head>
<body>
<div class="blob" aria-hidden="true"><b class="a"></b><b class="b"></b></div>
<div class="stage"><div class="wrap" id="wrap"><img id="view" alt="remote desktop" draggable="false"></div></div>
<div class="hint" id="hint">waiting for frames…</div>
<div class="toolbar" role="toolbar" aria-label="Web Desktop controls">
 <button id="mFit" class="on" title="Fit">Fit</button>
 <button id="mOne" title="1:1">1:1</button>
 <button id="mStretch" title="Stretch">Stretch</button>
 <span class="sep"></span>
 <button id="btnFs" title="Fullscreen">⛶ Fullscreen</button>
 <button id="btnCopy" title="Copy remote clipboard">Copy clip</button>
 <button id="btnPaste" title="Paste to remote clipboard">Paste clip</button>
 <span class="sep"></span>
 <span class="badge" id="fps">0 fps</span>
 <span class="badge" id="src">poll</span>
</div>
<script>
(function(){
 "use strict";
 var img = document.getElementById('view');
 var wrap = document.getElementById('wrap');
 var hint = document.getElementById('hint');
 var fpsEl = document.getElementById('fps');
 var srcEl = document.getElementById('src');
 var mode = 'fit';
 var natW = 0, natH = 0;
 var moveBuf = [];
 var lastFlush = 0;
 var frameCount = 0;
 var lastFpsAt = performance.now();
 var lastFrameAt = 0;
 var currentUrl = null;
 var wsFrameAt = 0;
 var polling = true;

 function setMode(m){ mode = m;
  ['mFit','mOne','mStretch'].forEach(function(id){document.getElementById(id).classList.remove('on');});
  document.getElementById(m==='fit'?'mFit':m==='one'?'mOne':'mStretch').classList.add('on');
  layout();
 }
 document.getElementById('mFit').onclick = function(){ setMode('fit'); };
 document.getElementById('mOne').onclick = function(){ setMode('one'); };
 document.getElementById('mStretch').onclick = function(){ setMode('stretch'); };
 document.getElementById('btnFs').onclick = function(){ if(document.fullscreenElement){document.exitFullscreen();}else{document.documentElement.requestFullscreen();} };

 function layout(){
  if(!natW||!natH) return;
  var wrapW = wrap.clientWidth, wrapH = wrap.clientHeight;
  if(mode==='one'){ img.style.width = natW+'px'; img.style.height = natH+'px'; }
  else if(mode==='stretch'){ img.style.width = wrapW+'px'; img.style.height = wrapH+'px'; }
  else { var s = Math.min(wrapW/natW, wrapH/natH); img.style.width = Math.floor(natW*s)+'px'; img.style.height = Math.floor(natH*s)+'px'; }
 }
 window.addEventListener('resize', layout);

 img.onload = function(){
  natW = img.naturalWidth; natH = img.naturalHeight;
  layout();
  if(hint.classList) hint.classList.add('hidden');
  frameCount++;
  var now = performance.now();
  lastFrameAt = now;
  if(now - lastFpsAt >= 1000){ fpsEl.textContent = frameCount+' fps'; frameCount=0; lastFpsAt = now; }
  if(currentUrl){ URL.revokeObjectURL(currentUrl); currentUrl = null; }
 };

 async function pollFrame(){
  if(!polling) return;
  try{
   var r = await fetch('/webdesk-frame?t='+Date.now(), { cache:'no-store' });
   if(r.ok){
    var b = await r.blob();
    var u = URL.createObjectURL(b);
    if(currentUrl) URL.revokeObjectURL(currentUrl);
    currentUrl = u;
    img.src = u;
    srcEl.textContent = 'poll';
   }
  }catch(e){}
 }
 setInterval(pollFrame, 200);
 pollFrame();

 // WS optional; if no WS frame in 3s → stay on polling.
 var ws = null;
 try {
  var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  var host = location.hostname + ':7332';
  ws = new WebSocket(proto + '//' + host + '/webdesk-ws');
  ws.binaryType = 'arraybuffer';
  ws.onmessage = function(ev){
   var blob = null;
   if(typeof ev.data === 'string'){
    try{ var bin = atob(ev.data); var bytes = new Uint8Array(bin.length); for(var i=0;i<bin.length;i++){ bytes[i]=bin.charCodeAt(i); } blob = new Blob([bytes],{type:'image/jpeg'}); }catch(e){ return; }
   } else if(ev.data instanceof ArrayBuffer){ blob = new Blob([ev.data],{type:'image/jpeg'}); }
   if(!blob) return;
   var u = URL.createObjectURL(blob);
   if(currentUrl) URL.revokeObjectURL(currentUrl);
   currentUrl = u; img.src = u; wsFrameAt = performance.now(); srcEl.textContent = 'ws';
  };
  ws.onclose = function(){ srcEl.textContent = 'poll'; };
  ws.onerror = function(){};
 } catch(e){}
 setInterval(function(){ if(performance.now() - wsFrameAt > 3000){ srcEl.textContent = polling ? 'poll' : 'poll'; } }, 500);

 // Pointer mapping (getBoundingClientRect is source of truth)
 function toNorm(ev){
  var r = img.getBoundingClientRect();
  if(r.width===0||r.height===0) return null;
  var nx = (ev.clientX - r.left) / r.width;
  var ny = (ev.clientY - r.top) / r.height;
  if(nx<0||nx>1||ny<0||ny>1) return null;
  return {nx:nx, ny:ny};
 }
 function pushEv(o){ moveBuf.push(o); }
 function flush(){
  if(!moveBuf.length) return;
  var body = moveBuf.map(function(e){return JSON.stringify(e);}).join('\n');
  moveBuf = [];
  fetch('/webdesk-input', { method:'POST', headers:{'Content-Type':'application/x-ndjson'}, body:body, keepalive:true }).catch(function(){});
 }
 setInterval(flush, 16);

 img.addEventListener('pointermove', function(ev){ var p = toNorm(ev); if(p) pushEv({t:'m', nx:p.nx, ny:p.ny}); }, {passive:true});
 img.addEventListener('pointerdown', function(ev){ var p = toNorm(ev); if(p) pushEv({t:'m', nx:p.nx, ny:p.ny}); if(ev.button===0) pushEv({t:'ld'}); else if(ev.button===2) pushEv({t:'rd'}); flush(); });
 img.addEventListener('pointerup',   function(ev){ if(ev.button===0) pushEv({t:'lu'}); else if(ev.button===2) pushEv({t:'ru'}); flush(); });
 img.addEventListener('contextmenu', function(ev){ ev.preventDefault(); });
 img.addEventListener('wheel', function(ev){ ev.preventDefault(); pushEv({t:'w', d: ev.deltaY < 0 ? 1 : -1}); flush(); }, {passive:false});

 var SPECIAL = {Enter:13,Backspace:8,Tab:9,Escape:27,ArrowLeft:37,ArrowUp:38,ArrowRight:39,ArrowDown:40,Delete:46,Home:36,End:35,PageUp:33,PageDown:34,Shift:16,Control:17,Alt:18,Meta:91};
 window.addEventListener('keydown', function(ev){
  if(SPECIAL[ev.key] !== undefined){ pushEv({t:'kd', vk: SPECIAL[ev.key]}); ev.preventDefault(); return; }
  if(ev.key.length===1){ pushEv({t:'k', ch: ev.key}); ev.preventDefault(); }
 });
 window.addEventListener('keyup', function(ev){
  if(SPECIAL[ev.key] !== undefined){ pushEv({t:'ku', vk: SPECIAL[ev.key]}); ev.preventDefault(); }
 });

 document.getElementById('btnCopy').onclick = async function(){
  try{ var r = await fetch('/webdesk-clip', {cache:'no-store'}); var j = await r.json(); if(j && typeof j.text === 'string'){ await navigator.clipboard.writeText(j.text); alert('Copied '+j.text.length+' chars to local clipboard'); } }catch(e){ alert('Copy failed: '+e.message); }
 };
 document.getElementById('btnPaste').onclick = async function(){
  try{ var t = await navigator.clipboard.readText(); await fetch('/webdesk-clip', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({text:t})}); alert('Sent '+t.length+' chars to remote clipboard'); }catch(e){ alert('Paste failed: '+e.message); }
 };

 setMode('fit');
})();
</script>
</body>
</html>
'@
try { $script:TerminalPage = [System.IO.File]::ReadAllText('C:\ghrdp\terminal-ui.html', [System.Text.Encoding]::UTF8) } catch { $script:TerminalPage = '<!doctype html><html><body><h3>terminal-ui.html not found</h3></body></html>' }
$script:Token = ''
try {
    $tp = Join-Path $Root 'dash-token.txt'
    if (Test-Path -LiteralPath $tp) { $script:Token = ([System.IO.File]::ReadAllText($tp)).Trim() }
} catch { }

function Read-JsonFile {
    param([string]$Path)
    for ($a = 1; $a -le 3; $a++) {
        try {
            if (-not (Test-Path -LiteralPath $Path)) { return $null }
            $fs = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
            $ms = New-Object System.IO.MemoryStream
            $fs.CopyTo($ms)
            $fs.Dispose()
            $b = $ms.ToArray()
            $ms.Dispose()
            if ($b.Length -eq 0) { return $null }
            if ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF) { $b = $b[3..($b.Length - 1)] }
            $t = [System.Text.Encoding]::UTF8.GetString($b).TrimStart([char]0xFEFF)
            return ($t | ConvertFrom-Json)
        } catch { Start-Sleep -Milliseconds 40 }
    }
    return $null
}
function Get-RequestParts {
    param([string]$Raw)
    $headers = @{}
    $query = @{}
    $lines = @($Raw -split "`r`n")
    $path = '/'
    if ($lines.Count -gt 0 -and $lines[0]) {
        $first = $lines[0].Trim()
        $sp = $first.IndexOf(' ')
        if ($sp -gt 0) {
            $rest = $first.Substring($sp + 1).Trim()
            $target = (@($rest -split ' '))[0]
            $qAt = $target.IndexOf('?')
            if ($qAt -ge 0) {
                $path = $target.Substring(0, $qAt)
                foreach ($kv in ($target.Substring($qAt + 1) -split '&')) {
                    $eq = $kv.IndexOf('=')
                    if ($eq -gt 0) {
                        $k = [uri]::UnescapeDataString($kv.Substring(0, $eq)).ToLower()
                        $v = [uri]::UnescapeDataString($kv.Substring($eq + 1))
                        $query[$k] = $v
                    }
                }
            } else {
                $path = $target
            }
        }
    }
    for ($i = 1; $i -lt $lines.Count; $i++) {
        $l = $lines[$i]
        $ix = $l.IndexOf(':')
        if ($ix -gt 0) { $headers[$l.Substring(0, $ix).Trim().ToLower()] = $l.Substring($ix + 1).Trim() }
    }
    $method = 'GET'
    if ($lines.Count -gt 0 -and $lines[0]) { $tok0 = ($lines[0].Trim() -split ' ')[0]; if ($tok0) { $method = $tok0.ToUpper() } }
    return @{ path = $path; headers = $headers; query = $query; method = $method }
}
function Test-ClientAllowed {
    param($Client, $Query, $Token)
    try {
        $ip = $Client.Client.RemoteEndPoint.Address
        if ($ip.IsLoopback) { return $true }
        $oct = $ip.GetAddressBytes()
        if ($oct.Length -eq 4 -and $oct[0] -eq 100 -and $oct[1] -ge 64 -and $oct[1] -le 127) { return $true }
    } catch { }
    if ([string]::IsNullOrEmpty($Token)) { return $true }
    if ($Query -and $Query.ContainsKey('key') -and ([string]$Query['key'] -eq [string]$Token)) { return $true }
    return $false
}
function Read-ClientRequest {
param($Stream)
$acc = New-Object System.Text.StringBuilder
$buf = New-Object byte[] 4096
try { $Stream.ReadTimeout = 5000 } catch { }
$headerDone = $false
$idx = -1
$cl = 0
$bodyBytes = New-Object System.Collections.Generic.List[byte]
while ($true) {
$n = 0
try { $n = $Stream.Read($buf, 0, $buf.Length) } catch { break }
if ($n -le 0) { break }
if (-not $headerDone) {
[void]$acc.Append([System.Text.Encoding]::ASCII.GetString($buf, 0, $n))
$txt = $acc.ToString()
$idx = $txt.IndexOf("`r`n`r`n")
if ($idx -ge 0) {
$headerDone = $true
$m = [regex]::Match($txt, '(?im)^Content-Length:\s*(\d+)')
if ($m.Success) { $cl = [int]$m.Groups[1].Value }
$priorLen = $acc.Length - $n
$bodyStart = ($idx + 4) - $priorLen
if ($bodyStart -lt 0) { $bodyStart = 0 }
if ($bodyStart -lt $n) { $bodyBytes.AddRange([byte[]]$buf[$bodyStart..($n - 1)]) }
if ($bodyBytes.Count -ge $cl) { break }
}
if ($acc.Length -gt 65536) { break }
} else {
$bodyBytes.AddRange([byte[]]$buf[0..($n - 1)])
if ($bodyBytes.Count -ge $cl) { break }
}
}
$head = $acc.ToString()
if ($idx -ge 0) { $head = $head.Substring(0, $idx + 4) }
return @{ head = $head; body = $bodyBytes.ToArray() }
}
function Send-ClientResponse {
    param($Stream, [int]$Code, [string]$CType, [byte[]]$Body)
    $status = 'OK'
    if ($Code -eq 401) { $status = 'Unauthorized' }
    if ($Code -eq 404) { $status = 'Not Found' }
    if ($Code -eq 500) { $status = 'Server Error' }
    $hdr = "HTTP/1.1 $Code $status`r`nContent-Type: $CType`r`nContent-Length: $($Body.Length)`r`nConnection: close`r`nCache-Control: no-store`r`nAccess-Control-Allow-Origin: *`r`nAccess-Control-Allow-Headers: Content-Type`r`nAccess-Control-Allow-Methods: GET,POST,OPTIONS`r`n`r`n"
    $hb = [System.Text.Encoding]::ASCII.GetBytes($hdr)
    $Stream.Write($hb, 0, $hb.Length)
    if ($Body.Length -gt 0) { $Stream.Write($Body, 0, $Body.Length) }
    $Stream.Flush()
}
function To-IsoUtc {
    param([string]$S)
    if (-not $S) { return '' }
    $s2 = $S.Trim()
    if ($s2 -match 'Z$' -or $s2 -match '[+-]\d{2}:\d{2}$') { return $s2 }
    $dt = [datetime]::MinValue
    if ([datetime]::TryParse($s2, [ref]$dt)) { return $dt.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ') }
    return $s2
}
function ConvertTo-JsonBytes {
    param($Obj)
    return [System.Text.Encoding]::UTF8.GetBytes(($Obj | ConvertTo-Json -Depth 10 -Compress))
}
function Invoke-ClientRequest {
    param($Client, $Token)
    $stream = $null
    try {
        $stream = $Client.GetStream()
        $rr = Read-ClientRequest -Stream $stream
        if (-not $rr -or -not $rr.head) { return }
        $parts = Get-RequestParts -Raw ([string]$rr.head)
        $parts['body'] = [byte[]]$rr.body
        $path = [string]$parts.path
        if (-not $path) { $path = '/' }
        if (-not (Test-ClientAllowed -Client $Client -Query $parts.query -Token $Token)) {
            Send-ClientResponse -Stream $stream -Code 401 -CType 'text/plain' -Body ([System.Text.Encoding]::UTF8.GetBytes('unauthorized'))
            return
        }
        $cfg = Read-JsonFile -Path $script:CfgPath
        if ($path -eq '/rentrydiag') {
            $editCode = [string]$cfg.rentryEditCode
            $pageCode = ([string]$cfg.legacyIndexUrl -replace '^https://rentry\.co/', '')
            if (-not $pageCode) { $pageCode = 'myurl0' }
            $apply = ($parts.query.ContainsKey('apply') -and ([string]$parts.query['apply'] -eq '1'))
            $jar = Join-Path $env:TEMP ('ghrdp-diag-' + [guid]::NewGuid().ToString('N') + '.txt')
            $ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
            $patterns = @(
                @{ name = 'edit/<edit_code>';  url = ('https://rentry.co/edit/' + [uri]::EscapeDataString($editCode)) },
                @{ name = 'edit/<page_code>';  url = ('https://rentry.co/edit/' + $pageCode) },
                @{ name = '<page_code>/edit';  url = ('https://rentry.co/' + $pageCode + '/edit') }
            )
            $results = New-Object System.Collections.ArrayList
            $workUrl = $null; $workCsrf = $null; $workCurrent = $null
            foreach ($pt in $patterns) {
                $html = (& curl.exe -sL -b $jar -c $jar --max-time 15 -A $ua $pt.url 2>$null) -join "`n"
                $csrf = ''; $cur = ''; $isErr = ($html -match '<title>Error</title>')
                if ($html -match 'name="csrfmiddlewaretoken"\s+value="([^"]+)"') { $csrf = $Matches[1] }
                if ($html -match '(?s)<textarea[^>]*name="text"[^>]*>(.*?)</textarea>') { $cur = [System.Net.WebUtility]::HtmlDecode($Matches[1]) }
                [void]$results.Add(@{ pattern = $pt.name; url = $pt.url; errorPage = $isErr; csrfFound = ([bool]$csrf); textareaFound = ([bool]$cur) })
                if ($csrf -and $cur -and (-not $workUrl)) { $workUrl = $pt.url; $workCsrf = $csrf; $workCurrent = $cur }
            }
            $applied = $false; $applyMsg = 'not applied'
            if ($apply -and $workUrl) {
                $body = $workCurrent
                $idxJson = $null
                try { $idxJson = Read-JsonFile -Path (Join-Path $script:Root 'mirror-index.json') } catch { }
                if ($idxJson) {
                    $body += "`r`n`r`nCURRENT RUN FILES:`r`n"
                    $i = 1
                    foreach ($it in @($idxJson)) {
                        $body += ('{0}. {1} ({2} bytes) {3} {4}' -f $i, [string]$it.name, [string]$it.size, [string]$it.time, [string]$it.link) + "`r`n"
                        $i++
                    }
                    if ([string]$cfg.mirrorKey) { $body += ("`r`nCurrent decrypt key: " + [string]$cfg.mirrorKey) }
                }
                $bf = Join-Path $env:TEMP ('ghrdp-apply-' + [guid]::NewGuid().ToString('N') + '.txt')
                [System.IO.File]::WriteAllText($bf, $body, $script:NoBom)
                $po = (& curl.exe -s -b $jar -A $ua -e $workUrl -X POST $workUrl --data-urlencode ('csrfmiddlewaretoken=' + $workCsrf) --data-urlencode ('edit_code=' + $editCode) --data-urlencode ('text@' + $bf) 2>$null) -join "`n"
                $applied = ($po -notmatch '<title>Error</title>')
                $applyMsg = if ($applied) { 'myurl0 append SUCCEEDED via ' + ($results | Where-Object { $_.csrfFound -and $_.textareaFound } | Select-Object -First 1).pattern } else { 'append still failed (rentry rejected POST)' }
                Remove-Item -LiteralPath $bf -Force -ErrorAction SilentlyContinue
            }
            Remove-Item -LiteralPath $jar -Force -ErrorAction SilentlyContinue
            $out = [ordered]@{ editCode = $editCode; pageCode = $pageCode; patterns = $results; workingPattern = $workUrl; applied = $applied; applyMsg = $applyMsg }
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json' -Body (ConvertTo-JsonBytes $out)
            return
        }
        if ($path -eq '/flush') {
            $note = 'flush flag set - the watcher will upload everything on its next pass'
            try { [System.IO.File]::WriteAllText($script:FlushFlag, (Get-Date -Format o), $script:NoBom) } catch { $note = 'flush flag write failed: ' + $_.Exception.Message }
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json' -Body (ConvertTo-JsonBytes @{ ok = $true; message = $note })
            return
        }
        if ($path -eq '/launch') {
            $msg = 'watcher task start requested'
            try { Start-ScheduledTask -TaskName 'GhrdpWatcher' -ErrorAction Stop } catch { $msg = 'could not start watcher task (log in via RDP first): ' + $_.Exception.Message }
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json' -Body (ConvertTo-JsonBytes @{ ok = $true; message = $msg })
            return
        }
        if ($path -eq '/diag') {
            $prog = Read-JsonFile -Path $script:ProgPath
            $listen7332 = $false
            try { $listen7332 = [bool](Get-NetTCPConnection -LocalPort 7332 -State Listen -ErrorAction SilentlyContinue) } catch { }
            $watcherState = 'not found'
            try { $wt = Get-ScheduledTask -TaskName 'GhrdpWatcher' -ErrorAction SilentlyContinue; if ($wt) { $watcherState = [string]$wt.State } } catch { }
            $progAge = $null
            try { if ($prog -and $prog.ts) { $progAge = [int]((Get-Date) - [datetime]$prog.ts).TotalSeconds } } catch { }
            $d = [ordered]@{
                serverTs = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
                port = $Port
                pid = $PID
                rust7332Listening = $listen7332
                watcherTask = $watcherState
                progressAgeSeconds = $progAge
                watcherAlive = [bool]$prog.alive
                note = 'ps server 7331 (fallback); rust realtime dashboard 7332 when available'
            }
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json' -Body (ConvertTo-JsonBytes $d)
            return
        }
        if ($path -eq '/install.bat') {
            $ipForBat = '127.0.0.1'
            try { $cfgBat = Read-JsonFile -Path $script:CfgPath; if ($cfgBat -and $cfgBat.rdpIp) { $ipForBat = [string]$cfgBat.rdpIp } } catch { }
            $bat = "@echo off`r`ntitle GHRDP installer`r`npowershell -NoProfile -ExecutionPolicy Bypass -Command `"irm http://" + $ipForBat + ":7331/install.ps1 | iex`"`r`necho.`r`necho If nothing happened above, copy the printed command and run it manually.`r`npause`r`n"
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/octet-stream' -Body ([System.Text.Encoding]::ASCII.GetBytes($bat))
            return
        }
        if ($path -eq '/connect-now.bat') {
            $cip = [string]$cfg.rdpIp; $cu = [string]$cfg.rdpUser; $cpBat = ([string]$cfg.rdpPass) -replace '\^', '^^'
            $bat = '@echo off' + "`r`n" + 'title GHRDP auto-connect' + "`r`n" + 'cmdkey /generic:TERMSRV/' + $cip + ' /user:' + $cu + ' /pass:' + $cpBat + ' >nul 2>&1' + "`r`n" + 'start "" mstsc /v:' + $cip + "`r`n" + 'timeout /t 15 >nul' + "`r`n" + 'cmdkey /delete:TERMSRV/' + $cip + ' >nul 2>&1' + "`r`n" + 'exit /b 0' + "`r`n"
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/octet-stream' -Body ([System.Text.Encoding]::ASCII.GetBytes($bat))
            return
        }
        if ($path -eq '/webdesk-boot') {
            $outB = @{ ok = $false; message = '' }
            try {
                try { . 'C:\ghrdp\ghrdp-lib.ps1' } catch { }
                $cfgB = Read-JsonFile -Path $script:CfgPath
                $made = Start-GhrdpLoopbackSession -User ([string]$cfgB.rdpUser) -Pass ([string]$cfgB.rdpPass)
                $outB.ok = $true; $outB.message = ('loopback bootstrap ran; session row=' + $made + '; diag=C:\ghrdp\webdesk\boot-diag.txt')
            } catch { $outB.message = $_.Exception.Message }
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json' -Body ([System.Text.Encoding]::UTF8.GetBytes(($outB | ConvertTo-Json -Compress)))
            return
        }
        if ($path -eq '/webdesk-probe') {
            $wPs = Test-Path -LiteralPath 'C:\ghrdp\ghrdp-pub2.ps1'
            $bPs = Test-Path -LiteralPath 'C:\ghrdp\ghrdp-bootstrap-session.ps1'
            $task = $false
            try { $task = [bool](Get-ScheduledTask -TaskName 'GhrdpWebDesk' -ErrorAction SilentlyContinue) } catch { }
            $sess = $false
            try { $q = (& quser.exe 2>$null) -join "`n"; $LASTEXITCODE = 0; $cfgP = Read-JsonFile -Path $script:CfgPath; if (($q -match [regex]::Escape([string]$cfgP.rdpUser)) -or ($q -match 'runneradmin')) { $sess = $true } } catch { }
            $sessState = 'no-session'
            try { $ql2 = @(& quser.exe 2>$null); $LASTEXITCODE = 0; foreach ($qr2 in $ql2) { if ((($qr2 -match [regex]::Escape([string]$cfgP.rdpUser)) -or ($qr2 -match 'runneradmin')) -and ($qr2 -match '\bActive\b')) { $sessState = 'Active'; break } }; if ($sessState -eq 'no-session') { foreach ($qr2 in $ql2) { if ((($qr2 -match [regex]::Escape([string]$cfgP.rdpUser)) -or ($qr2 -match 'runneradmin'))) { $sessState = 'Disc'; break } } } } catch { $sessState = 'error' }
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json' -Body ([System.Text.Encoding]::UTF8.GetBytes((@{ webdeskPs = $wPs; bootstrapPs = $bPs; task = $task; session = $sess; diag = $(try { [System.IO.File]::ReadAllText('C:\ghrdp\webdesk\boot-diag.txt') } catch { '' }); wdErr = $(try { [System.IO.File]::ReadAllText('C:\ghrdp\webdesk\webdesk-error.txt') } catch { '' }); mstscDiag = $(try { [System.IO.File]::ReadAllText('C:\ghrdp\webdesk\mstsc-exit-diag.txt') } catch { '' }); tsPath = $(try { [System.IO.File]::ReadAllText('C:\ghrdp\webdesk\ts-path.txt') } catch { '' }); aliveAgeMs = $(try { [int]((Get-Date) - [datetime][System.IO.File]::ReadAllText('C:\ghrdp\webdesk\webdesk-alive.txt')).TotalMilliseconds } catch { -1 }); capFail = $(try { $cfi = Get-Item 'C:\ghrdp\webdesk\webdesk-capture-fail.txt' -ErrorAction Stop; if (((Get-Date) - $cfi.LastWriteTime).TotalSeconds -lt 60) { [System.IO.File]::ReadAllText($cfi.FullName) } else { '' } } catch { '' }); version = $(try { [System.IO.File]::ReadAllText('C:\ghrdp\webdesk\webdesk-version.txt') } catch { '' }); manualDiag = $(try { [System.IO.File]::ReadAllText('C:\ghrdp\webdesk\diag-manual.txt') } catch { '' }); displayCount = $(try { [System.IO.File]::ReadAllText('C:\ghrdp\webdesk\display-count.txt') } catch { '' }); frameExists = $(Test-Path 'C:\ghrdp\webdesk\frame.jpg' -ErrorAction SilentlyContinue); frameSize = $(try { (Get-Item 'C:\ghrdp\webdesk\frame.jpg' -ErrorAction Stop).Length } catch { -1 }); startAgeMs = $(try { [int]((Get-Date) - [datetime][System.IO.File]::ReadAllText('C:\ghrdp\webdesk\webdesk-start.txt')).TotalMilliseconds } catch { -1 }); initResult = $(try { [System.IO.File]::ReadAllText('C:\ghrdp\webdesk\webdesk-init.txt') } catch { '' }); captureProcAlive = $(try { $m = [System.Threading.Mutex]::OpenExisting('Global\GhrdpWebDeskSingle'); $h = $m.WaitOne(0); if (-not $h) { 'RUNNING (mutex held)' } else { $m.ReleaseMutex(); 'NOT RUNNING' } } catch { 'NOT RUNNING' }); pidFile = $(try { [System.IO.File]::ReadAllText('C:\ghrdp\webdesk\webdesk.pid') } catch { '' }); errFile = $(try { [System.IO.File]::ReadAllText('C:\ghrdp\webdesk\webdesk-error.txt') } catch { '' }); trace = $(try { [System.IO.File]::ReadAllText('C:\ghrdp\webdesk\webdesk-trace.txt') } catch { '' }); captureProcs = $(try { [System.IO.File]::ReadAllText('C:\ghrdp\webdesk\procs.txt') } catch { '' }); sessionState = $sessState; taskState = $(try { $t = Get-ScheduledTask -TaskName 'GhrdpWebDesk' -ErrorAction SilentlyContinue; if ($t) { $t.State.ToString() } else { 'not-registered' } } catch { 'error' }); taskLastRun = $(try { $i = Get-ScheduledTaskInfo -TaskName 'GhrdpWebDesk' -ErrorAction SilentlyContinue; if ($i) { $i.LastRunTime.ToString() + ' result=' + $i.LastTaskResult } else { 'never' } } catch { 'error' }) } | ConvertTo-Json -Compress)))
            return
        }
        if ($path -eq '/webdesk-status') {
            $ageMs = -1
            try { $tsTxt = [System.IO.File]::ReadAllText('C:\ghrdp\webdesk\frame-ts.txt'); $ageMs = [int]((Get-Date) - [datetime]$tsTxt).TotalMilliseconds } catch { }
            $outJ = @{ ok = ($ageMs -ge 0 -and $ageMs -lt 15000); frameAgeMs = $ageMs } | ConvertTo-Json -Compress
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json' -Body ([System.Text.Encoding]::UTF8.GetBytes($outJ))
            return
        }
        if ($path -eq '/webdesk-frame') {
            try { $b = [System.IO.File]::ReadAllBytes('C:\ghrdp\webdesk\frame.jpg'); Send-ClientResponse -Stream $stream -Code 200 -CType 'image/jpeg' -Body $b } catch { Send-ClientResponse -Stream $stream -Code 404 -CType 'text/plain' -Body ([System.Text.Encoding]::UTF8.GetBytes('no frame yet')) }
            return
        }
        if ($path -eq '/webdesk-input') {
            try {
                $btxt = ([System.Text.Encoding]::UTF8.GetString([byte[]]$parts.body))
                $bj = $btxt | ConvertFrom-Json
                $linesOut = @()
                if ($bj -is [System.Collections.IEnumerable] -and $bj -isnot [string]) { foreach ($e1 in $bj) { $linesOut += ($e1 | ConvertTo-Json -Compress) } } else { $linesOut += $btxt }
                [System.IO.File]::AppendAllText('C:\ghrdp\webdesk\input.ndjson', (($linesOut -join "`n") + "`n"))
            } catch { }
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json' -Body ([System.Text.Encoding]::UTF8.GetBytes('{"ok":true}'))
            return
        }
        if ($path -eq '/webdesk-clip') {
            if ([string]$parts.method -eq 'POST') {
                try { [System.IO.File]::WriteAllText('C:\ghrdp\webdesk\clip-set.json', ([System.Text.Encoding]::UTF8.GetString([byte[]]$parts.body))) } catch { }
                Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json' -Body ([System.Text.Encoding]::UTF8.GetBytes('{"ok":true}'))
                return
            }
            try { [System.IO.File]::WriteAllText('C:\ghrdp\webdesk\clip-get.flag', (Get-Date).ToUniversalTime().ToString('o')) } catch { }
            $txt = $null
            try { if (Test-Path 'C:\ghrdp\webdesk\clip.txt') { $txt = [System.IO.File]::ReadAllText('C:\ghrdp\webdesk\clip.txt') } } catch { }
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json' -Body ([System.Text.Encoding]::UTF8.GetBytes((@{ text = $txt } | ConvertTo-Json -Compress)))
            return
        }
        if ($path -eq '/webdesk-ctl') {
            try { [System.IO.File]::WriteAllText('C:\ghrdp\webdesk\ctl.json', ([System.Text.Encoding]::UTF8.GetString([byte[]]$parts.body))) } catch { }
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json' -Body ([System.Text.Encoding]::UTF8.GetBytes('{"ok":true}'))
            return
        }
        if ($path -eq '/terminal') {
            $termPage = @'
<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GHRDP Terminal</title>
<style>
:root{--glass:rgba(255,255,255,.08);--stroke:rgba(255,255,255,.16);--txt:#f5f5f7;--dim:rgba(245,245,247,.6)}
*{box-sizing:border-box}
body{margin:0;height:100vh;color:var(--txt);font:14px/1.45 -apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',Roboto,sans-serif;background:#0b0e14;overflow:hidden}
body::before{content:'';position:fixed;inset:-20%;background:radial-gradient(40% 35% at 20% 20%,rgba(64,120,255,.35),transparent 60%),radial-gradient(35% 30% at 80% 25%,rgba(255,80,160,.28),transparent 60%),radial-gradient(45% 40% at 50% 85%,rgba(60,220,180,.22),transparent 60%);filter:blur(40px) saturate(160%);animation:drift 18s ease-in-out infinite alternate;z-index:0}
@keyframes drift{from{transform:translate3d(-2%,-1%,0) scale(1)}to{transform:translate3d(2%,2%,0) scale(1.06)}}
.glass{position:relative;z-index:1;background:var(--glass);border:1px solid var(--stroke);border-radius:18px;backdrop-filter:saturate(180%) blur(22px);-webkit-backdrop-filter:saturate(180%) blur(22px);box-shadow:0 8px 32px rgba(0,0,0,.35),inset 0 1px 0 rgba(255,255,255,.12)}
#app{position:relative;z-index:1;display:flex;flex-direction:column;gap:12px;height:100vh;padding:14px}
#bar{display:flex;gap:8px;align-items:center;padding:10px 12px;flex-wrap:wrap}
#bar input,#bar select{background:rgba(255,255,255,.06);border:1px solid var(--stroke);color:var(--txt);border-radius:10px;padding:7px 10px;font:inherit;outline:none}
#bar input:focus{border-color:rgba(120,170,255,.7);box-shadow:0 0 0 3px rgba(90,140,255,.25)}
button{background:linear-gradient(180deg,rgba(255,255,255,.22),rgba(255,255,255,.08));border:1px solid var(--stroke);color:var(--txt);border-radius:10px;padding:7px 12px;font:inherit;cursor:pointer;backdrop-filter:blur(8px)}
button:hover{background:linear-gradient(180deg,rgba(255,255,255,.3),rgba(255,255,255,.14))}
button.primary{background:linear-gradient(180deg,#4f8cff,#2f6bff);border-color:rgba(255,255,255,.35)}
#code{flex:0 0 26vh;background:rgba(0,0,0,.35);border:1px solid var(--stroke);border-radius:16px;color:#e8f0ff;padding:10px;font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;resize:none;outline:none;backdrop-filter:blur(14px)}
#out{flex:1;overflow:auto;background:rgba(0,0,0,.45);border:1px solid var(--stroke);border-radius:16px;padding:10px;font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre-wrap;backdrop-filter:blur(14px)}
.meta{color:#7ee787}.err{color:#ff7b72}.dim{color:var(--dim)}
#chip{margin-left:auto;font-size:12px;color:var(--dim)}
</style></head><body>
<div id="app">
 <div id="bar" class="glass">
  <input id="cmd" size="52" placeholder="one-line command (inline mode)">
  <button id="bCmd" class="primary">Run Cmd</button>
  <input id="fpath" size="34" placeholder="C:\path\script.ps1 (file mode)">
  <button id="bFile">Run File</button>
  <select id="sess"><option value="system">SYSTEM (s0)</option><option value="interactive">INTERACTIVE (user session)</option></select>
  <input id="tmo" size="6" value="60000">
  <button id="bPaste">Run Paste</button>
  <button id="bCopy">Copy Out</button>
  <span id="chip">GHRDP Terminal · liquid glass</span>
 </div>
 <textarea id="code" class="glass" placeholder="paste long .ps1 here → Run Paste (upload mode, base64-safe)"></textarea>
 <div id="out" class="glass"><span class="dim">ready.</span></div>
</div>
<script>
var tok=new URLSearchParams(location.search).get('token')||'';
var out=document.getElementById('out');
function show(j){out.innerHTML='';var m=document.createElement('div');m.className='meta';m.textContent='exit='+j.exitCode+' timedOut='+j.timedOut+' ms='+j.durationMs+' session='+j.session+' file='+j.scriptPath;out.appendChild(m);var o=document.createElement('div');o.textContent=j.output||'(no stdout)';out.appendChild(o);if(j.error){var e=document.createElement('div');e.className='err';e.textContent='STDERR:\n'+j.error;out.appendChild(e);}}
function run(body){out.innerHTML='<span class="dim">running…</span>';fetch('/terminal-exec',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+tok},body:JSON.stringify(body)}).then(function(r){return r.json();}).then(show).catch(function(e){out.textContent='FETCH ERROR: '+e;});}
document.getElementById('bCmd').onclick=function(){run({mode:'inline',cmd:document.getElementById('cmd').value,session:document.getElementById('sess').value,timeout:+document.getElementById('tmo').value});};
document.getElementById('bFile').onclick=function(){run({mode:'file',file:document.getElementById('fpath').value,session:document.getElementById('sess').value,timeout:+document.getElementById('tmo').value});};
document.getElementById('bPaste').onclick=function(){var t=document.getElementById('code').value;run({mode:'upload',script_b64:btoa(unescape(encodeURIComponent(t))),session:document.getElementById('sess').value,timeout:+document.getElementById('tmo').value});};
document.getElementById('bCopy').onclick=function(){navigator.clipboard.writeText(out.innerText);};
</script></body></html>
'@
            $qt = ''; if ($parts.query.ContainsKey('token')) { $qt = [string]$parts.query['token'] }
            $cfgAuth = Read-JsonFile -Path $script:CfgPath
            if (-not $qt -or $qt -ne ('ghrdp-term-' + [string]$cfgAuth.rdpUser)) { Send-ClientResponse -Stream $stream -Code 401 -CType 'text/plain' -Body ([System.Text.Encoding]::UTF8.GetBytes('401 Unauthorized')); return }
            Send-ClientResponse -Stream $stream -Code 200 -CType 'text/html; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes($script:TerminalPage))
            return
        }
                if ($path -eq '/terminal-exec') {
            $authH = ''; if ($parts.headers.ContainsKey('authorization')) { $authH = [string]$parts.headers['authorization'] }
            $cfgAuth2 = Read-JsonFile -Path $script:CfgPath
            $expTok = 'ghrdp-term-' + [string]$cfgAuth2.rdpUser
            if ($authH -ne ('Bearer ' + $expTok)) { Send-ClientResponse -Stream $stream -Code 401 -CType 'application/json' -Body ([System.Text.Encoding]::UTF8.GetBytes('{"error":"401 Unauthorized"}')); return }
            $tmode = 'inline'
            $tsess = 'system'
            $timeoutMs = 60000
            try {
                $req = ([System.Text.Encoding]::UTF8.GetString([byte[]]$parts.body)) | ConvertFrom-Json
                $tmode = if ($req.mode) { [string]$req.mode } else { 'inline' }
                if ($req.timeout) { $timeoutMs = [int]$req.timeout }
                if ($timeoutMs -gt 300000) { $timeoutMs = 300000 }
                if ($timeoutMs -lt 1000) { $timeoutMs = 1000 }
                $tout = [int]($timeoutMs / 1000)
                if ($req.session -eq 'interactive') { $tsess = 'interactive' }
                $workDir = 'C:\ghrdp\webdesk\term'
                New-Item -ItemType Directory -Path $workDir -Force -ErrorAction SilentlyContinue | Out-Null
                $tid = [guid]::NewGuid().ToString('N').Substring(0, 8)
                $tscript = Join-Path $workDir ('run-' + $tid + '.ps1')
                $toutF = Join-Path $workDir ('out-' + $tid + '.txt')
                $terrF = Join-Path $workDir ('err-' + $tid + '.txt')
                $ownScript = $true
                if ($tmode -eq 'upload') {
                    if (-not [string]$req.script_b64) { throw 'missing script_b64' }
                    [System.IO.File]::WriteAllText($tscript, ([System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([string]$req.script_b64))))
                } elseif ($tmode -eq 'file') {
                    if (-not (Test-Path -LiteralPath ([string]$req.file))) { throw ('file not found: ' + [string]$req.file) }
                    $tscript = [string]$req.file
                    $ownScript = $false
                } else {
                    if (-not [string]$req.cmd) { throw 'empty cmd' }
                    [System.IO.File]::WriteAllText($tscript, ([string]$req.cmd))
                }
                try { [System.IO.File]::AppendAllText('C:\ghrdp\webdesk\terminal-audit.log', ((Get-Date).ToUniversalTime().ToString('o') + ' mode=' + $tmode + ' session=' + $tsess + ' file=' + $tscript + "`n")) } catch { }
                $resultFile = Join-Path $workDir ('result-' + $tid + '.json')
                $cfgJ = @{ scriptPath=$tscript; timeoutMs=$timeoutMs; workDir=$workDir; outFile=$toutF; errFile=$terrF; resultFile=$resultFile; session=$tsess; tid=$tid; rdpUser=[string]$cfgAuth2.rdpUser; auditLog='C:\ghrdp\webdesk\terminal-audit.log'; ownScript=$ownScript } | ConvertTo-Json -Compress
                $cfgFile = Join-Path $workDir ('cfg-' + $tid + '.json')
                [System.IO.File]::WriteAllText($cfgFile, $cfgJ)
                Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $Root 'term-runner.ps1'),'-CfgPath',$cfgFile) -WindowStyle Hidden
            } catch {
                Send-ClientResponse -Stream $stream -Code 500 -CType 'application/json' -Body ([System.Text.Encoding]::UTF8.GetBytes(('{"error":' + (('ERROR: ' + $_.Exception.Message) | ConvertTo-Json) + '}')))
                return
            }
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json' -Body ([System.Text.Encoding]::UTF8.GetBytes(('{"runId":"' + $tid + '"}')))
            return
        }
        if ($path -eq '/terminal-result') {
            $qrid = ''; if ($parts.query.ContainsKey('id')) { $qrid = [string]$parts.query['id'] }
            if (-not $qrid -or $qrid -notmatch '^[a-f0-9]{8}$') { Send-ClientResponse -Stream $stream -Code 400 -CType 'application/json' -Body ([System.Text.Encoding]::UTF8.GetBytes('{"error":"missing or invalid id"}')); return }
            $resPath = Join-Path 'C:\ghrdp\webdesk\term' ('result-' + $qrid + '.json')
            if (Test-Path -LiteralPath $resPath) {
                $resBody = [System.IO.File]::ReadAllText($resPath)
                try { Remove-Item -LiteralPath $resPath -Force -ErrorAction SilentlyContinue } catch { }
                Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json' -Body ([System.Text.Encoding]::UTF8.GetBytes($resBody))
            } else {
                Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json' -Body ([System.Text.Encoding]::UTF8.GetBytes('{"done":false}'))
            }
            return
        }
        if ($path -eq '/remote-exec') {
            $timeout = 30000
            $out = ''
            try {
                $rj = ([System.Text.Encoding]::UTF8.GetString([byte[]]$parts.body)) | ConvertFrom-Json
                $sb64 = [string]$rj.script_b64
                if (-not $sb64) { throw 'missing script_b64' }
                if ($rj.timeout) { $timeout = [int]$rj.timeout }
                $scriptContent = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($sb64))
                try { [System.IO.File]::AppendAllText('C:\ghrdp\webdesk\remote-exec-audit.log', ((Get-Date).ToUniversalTime().ToString('o') + ' REMOTE-EXEC len=' + $scriptContent.Length + ' head=' + $scriptContent.Substring(0, [Math]::Min(200, $scriptContent.Length)) + "`n")) } catch { }
                $tmpScript = Join-Path $env:TEMP ('ghrdp-remote-' + [guid]::NewGuid().ToString('N') + '.ps1')
                [System.IO.File]::WriteAllText($tmpScript, $scriptContent)
                $job = Start-Job -ScriptBlock { param($s) powershell -NoProfile -ExecutionPolicy Bypass -File $s } -ArgumentList $tmpScript
                $job | Wait-Job -Timeout ($timeout / 1000) | Out-Null
                if ($job.State -eq 'Running') { $job | Stop-Job -Force; $out = 'TIMEOUT after ' + ($timeout / 1000) + 's' }
                else { $out = ($job | Receive-Job | Out-String); if (-not $out) { $out = '(no output)' } }
                try { $job | Remove-Job -Force } catch { }
                try { Remove-Item -LiteralPath $tmpScript -Force -ErrorAction SilentlyContinue } catch { }
            } catch { $out = 'ERROR: ' + $_.Exception.Message }
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json' -Body ([System.Text.Encoding]::UTF8.GetBytes(('{"output":' + ([string]$out | ConvertTo-Json) + '}')))
            return
        }
        if ($path -eq '/webdesk') {
            $pg = @'
<!doctype html><html><head><meta charset="utf-8"><title>GHRDP Web Desktop</title>
<style>html,body{margin:0;height:100%;background:#000;overflow:hidden}#bar{position:fixed;top:0;left:0;right:0;height:36px;background:#161b22;display:flex;gap:6px;align-items:center;padding:0 8px;z-index:9;color:#e6edf3;font:12px system-ui}#bar button{background:#21262d;color:#e6edf3;border:1px solid #30363d;border-radius:6px;padding:4px 8px;cursor:pointer}#wrap{position:absolute;top:36px;bottom:0;left:0;right:0;display:flex;align-items:center;justify-content:center}#fr{cursor:none;display:none}#bar button.on{background:linear-gradient(180deg,#3fb950,#2ea043);border-color:rgba(255,255,255,.35)}#st{color:#8b949e}</style></head><body>
<div id="bar"><b>GHRDP Web Desktop</b><span id="st">connecting...</span><button id="fit" class="on">Fit</button><button id="one">1:1</button><button id="str">Stretch</button><button id="fs">Fullscreen</button><button id="cp">Copy clip</button><button id="ps">Paste clip</button></div>
<div id="wrap"><img id="fr" alt=""></div>
<script>
var fr=document.getElementById('fr'),st=document.getElementById('st'),fc=0,fl=performance.now();
function send(arr){fetch('/webdesk-input',{method:'POST',headers:{'Content-Type':'application/json'},body:arr.map(function(x){return JSON.stringify(x);}).join('\n')}).catch(function(){});}
function poll(){fetch('/webdesk-frame?'+Date.now(),{cache:'no-store'}).then(function(r){if(!r.ok)throw 0;return r.blob();}).then(function(b){fr.src=URL.createObjectURL(b);fr.style.display='block';fc++;st.textContent='live';}).catch(function(){fr.style.display='none';st.textContent='waiting for frames...';});}
setInterval(function(){st.textContent='live fps~'+fc;fc=0;},1000);
var wrap=document.getElementById('wrap'),mode='fit';
function layout(){var w=wrap.clientWidth,h=wrap.clientHeight,nw=fr.naturalWidth,nh=fr.naturalHeight;if(!nw||!nh)return;if(mode==='fit'){var s=Math.min(w/nw,h/nh);fr.style.width=(nw*s)+'px';fr.style.height=(nh*s)+'px';}else if(mode==='one'){fr.style.width=nw+'px';fr.style.height=nh+'px';}else{fr.style.width=w+'px';fr.style.height=h+'px';}}
function setm(m){mode=m;document.getElementById('fit').className=(m==='fit'?'on':'');document.getElementById('one').className=(m==='one'?'on':'');document.getElementById('str').className=(m==='str'?'on':'');layout();}
document.getElementById('fit').onclick=function(){setm('fit');};
document.getElementById('one').onclick=function(){setm('one');};
document.getElementById('str').onclick=function(){setm('str');};
addEventListener('resize',layout);
fr.addEventListener('load',layout);
setInterval(poll,200);poll();
function norm(e){var r=fr.getBoundingClientRect();return{nx:Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)),ny:Math.max(0,Math.min(1,(e.clientY-r.top)/r.height))};}
var pend=[],mt=null;
fr.addEventListener('mousemove',function(e){var p=norm(e);pend.push({t:'m',nx:p.nx,ny:p.ny});if(!mt)mt=setInterval(function(){if(pend.length){send(pend);pend=[];}},16);});
['mousedown','mouseup'].forEach(function(ev){fr.addEventListener(ev,function(e){var p=norm(e);send([{t:(ev==='mousedown'?(e.button===2?'rd':'ld'):(e.button===2?'ru':'lu')),nx:p.nx,ny:p.ny}]);});});
fr.addEventListener('wheel',function(e){var p=norm(e);send([{t:'w',nx:p.nx,ny:p.ny,d:Math.sign(e.deltaY)}]);e.preventDefault();},{passive:false});
var SPEC={Enter:13,Backspace:8,Tab:9,Escape:27,ArrowLeft:37,ArrowUp:38,ArrowRight:39,ArrowDown:40,Delete:46};
addEventListener('keydown',function(e){if(e.key.length===1){send([{t:'k',ch:e.key}]);}else if(SPEC[e.key]){send([{t:'kd',vk:SPEC[e.key]}]);}else{return;}e.preventDefault();});
addEventListener('keyup',function(e){if(SPEC[e.key]){send([{t:'ku',vk:SPEC[e.key]}]);}e.preventDefault();});
document.getElementById('fs').onclick=function(){if(document.fullscreenElement){document.exitFullscreen();}else{document.documentElement.requestFullscreen();}};
document.getElementById('cp').onclick=function(){fetch('/webdesk-clip?want=1').then(function(r){return r.json();}).then(function(j){if(j.text!=null&&navigator.clipboard)navigator.clipboard.writeText(j.text);});};
document.getElementById('ps').onclick=function(){if(navigator.clipboard)navigator.clipboard.readText().then(function(t){return fetch('/webdesk-clip',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:t})});});};
</script></body></html>
'@
            Send-ClientResponse -Stream $stream -Code 200 -CType 'text/html; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes($pg))
            return
        }
        if ($path -eq '/novnc') {
            $htmlN = @'
<!doctype html><html><head><meta charset="utf-8"><title>GHRDP Web Desktop</title>
<style>html,body{margin:0;height:100%;background:#101418;overflow:hidden}#screen{width:100%;height:100%}#bar{position:fixed;top:0;left:0;right:0;padding:8px 12px;font:13px system-ui;color:#e8eef3;background:#1b2530;display:flex;gap:12px;align-items:center;z-index:9}#bar .st{color:#8aa0ad}#bar button{background:#153e5c;color:#e8eef3;border:0;border-radius:6px;padding:6px 10px;cursor:pointer}</style>
</head><body>
<div id="bar"><b>GHRDP Web Desktop</b><span class="st" id="st">checking backend...</span><button id="re">Retry</button></div>
<div id="screen"></div>
<script type="module">
const st=document.getElementById('st');
const WS='ws://'+location.hostname+':7333/';
function wsProbe(url){return new Promise((res,rej)=>{let w;try{w=new WebSocket(url);}catch(e){rej(e);return;}const t=setTimeout(()=>{try{w.close();}catch(e){}rej(new Error('timeout - bridge not answering'));},5000);w.onopen=()=>{clearTimeout(t);try{w.close();}catch(e){}res(true);};w.onerror=()=>{clearTimeout(t);rej(new Error('websocket refused/blocked - firewall 7333 or websockify down'));};});}
let rfb=null;
async function boot(){
  st.textContent='checking backend...';
  try{
    const r=await fetch('/vncstatus',{cache:'no-store'});
    const j=await r.json();
    if(!j.ok){ st.textContent='backend down: vnc5900='+j.vnc+' bridge7333='+j.bridge+' - keep-alive self-heals every 2 min; click Retry'; return; }
  }catch(e){ st.textContent='cannot reach /vncstatus: '+e; return; }
  st.textContent='probing websocket '+WS+' ...';
  try{ await wsProbe(WS); }catch(e){ st.textContent='WS probe failed: '+e.message; return; }
  st.textContent='loading noVNC + connecting...';
  try{
    const mod=await import('https://cdn.jsdelivr.net/npm/@novnc/novnc@1.4.0/core/rfb.js');
    if(rfb){ try{rfb.disconnect();}catch(e){} }
    rfb=new mod.default(document.getElementById('screen'),WS,{});
    rfb.scaleViewport=true; rfb.clipboardCapable=true;
    rfb.addEventListener('connect',()=>{st.textContent='connected - clipboard active';});
    rfb.addEventListener('securityfailure',e=>{st.textContent='VNC security rejected: '+e.detail.reason+' (type '+e.detail.status+')';});
    rfb.addEventListener('disconnect',e=>{st.textContent='disconnected code='+((e.detail&&e.detail.code)||'none')+' reason='+((e.detail&&e.detail.reason)||'none')+' clean='+((e.detail&&e.detail.clean)||false)+' - Retry';});
    rfb.addEventListener('credentialsrequired',()=>{st.textContent='server demands a password but auth should be NONE - run PATCH 1 on the runner';});
  }catch(e){ st.textContent='noVNC load failed: '+e; }
}
document.getElementById('re').onclick=boot;
boot();
</script></body></html>
'@
            Send-ClientResponse -Stream $stream -Code 200 -CType 'text/html; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes($htmlN))
            return
        }
        if ($path -eq '/vncstatus') {
            $vncUp = $false; $brUp = $false
            try { $vncUp = [bool](Get-NetTCPConnection -LocalPort 5900 -State Listen -ErrorAction SilentlyContinue) } catch { }
            try { $brUp = [bool](Get-NetTCPConnection -LocalPort 7333 -State Listen -ErrorAction SilentlyContinue) } catch { }
            $outJ = @{ ok = ($vncUp -and $brUp); vnc = $vncUp; bridge = $brUp } | ConvertTo-Json -Compress
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json' -Body ([System.Text.Encoding]::UTF8.GetBytes($outJ))
            return
        }
        if ($path -eq '/install.ps1') {
            if (Test-Path -LiteralPath $script:InstPath) {
                Send-ClientResponse -Stream $stream -Code 200 -CType 'text/plain; charset=utf-8' -Body ([System.IO.File]::ReadAllBytes($script:InstPath))
            } else {
                Send-ClientResponse -Stream $stream -Code 404 -CType 'text/plain' -Body ([System.Text.Encoding]::UTF8.GetBytes('installer missing'))
            }
            return
        }
        if ($path -eq '/config') {
            if (Test-Path -LiteralPath $script:CfgPath) {
                $bytes = $null
                try {
                    $fs = [System.IO.File]::Open($script:CfgPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
                    $ms = New-Object System.IO.MemoryStream
                    $fs.CopyTo($ms)
                    $fs.Dispose()
                    $bytes = $ms.ToArray()
                    $ms.Dispose()
                } catch { }
                if ($bytes) {
                    Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json; charset=utf-8' -Body $bytes
                } else {
                    Send-ClientResponse -Stream $stream -Code 500 -CType 'text/plain' -Body ([System.Text.Encoding]::UTF8.GetBytes('config read failed'))
                }
            } else {
                Send-ClientResponse -Stream $stream -Code 404 -CType 'text/plain' -Body ([System.Text.Encoding]::UTF8.GetBytes('config missing'))
            }
            return
        }
        if ($path -eq '/progress' -or $path -eq '/api/progress') {
            $prog = Read-JsonFile -Path $script:ProgPath
            $wireNow = Read-JsonFile -Path (Join-Path $script:Root 'wire-probe.json')
            if (-not $prog) {
                $prog = [ordered]@{
                    ts = ''
                    alive = $false
                    active = [ordered]@{ name = ''; phase = 'idle'; pct = 0 }
                    agg = [ordered]@{ total = 0; done = 0; failed = 0; active = 0; bytesDone = 0; bytesTotal = 0; overallPct = 0; speedBps = 0 }
                    telemetry = [ordered]@{ scans = 0; lastScan = ''; seen = 0; skippedJunk = 0; skippedSmall = 0; locked = 0; queued = 0; roots = @() }
                    archives = @()
                    files = @()
                    log = @()
                    speedHistory = @()
                }
            }
            $ip = ''; $us = ''; $pw = ''; $mk = ''; $tg = ''; $sv = ''; $fu = ''; $sa = ''; $rsa = ''; $ssa = ''; $em = 'none'; $lu = ''; $lk = ''; $rn = ''; $eg = ''
            $mirrorFlag = $false
            if ($cfg) {
                $ip = [string]$cfg.rdpIp; $us = [string]$cfg.rdpUser; $pw = [string]$cfg.rdpPass; $tg = [string]$cfg.mirrorIndexUrl
                $sv = [string]$cfg.serveUrl; $fu = [string]$cfg.funnelUrl; $sa = [string]$cfg.startedAt
                $rsa = [string]$cfg.runStartedAt; $ssa = [string]$cfg.sessionStartedAt
                $em = if ([string]$cfg.encryptMode) { [string]$cfg.encryptMode } else { 'none' }
                $lu = [string]$cfg.legacyIndexUrl; $lk = [string]$cfg.legacyDecryptKey; $rn = [string]$cfg.rentryNewUrl; $eg = [string]$cfg.runnerEgressIp
                $mirrorFlag = [bool]$cfg.mirror
                if ($mirrorFlag) { $mk = [string]$cfg.mirrorKey }
            }
            $sessionEnd = $null; $cands = @()
            foreach ($k in @('githubDeadline','keepAliveDeadline','watcherDeadline')) { $v = [string]$cfg.$k; if ($v) { try { $cands += [datetime]$v } catch { } } }
            if ($cands.Count) { $sessionEnd = ($cands | Measure-Object -Minimum).Minimum }
            $obj = [ordered]@{
                serverTs = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
                mirror = $mirrorFlag
                encryptMode = $em
                mirrorKey = $mk
                ghrdp = [string]$cfg.ghrdp
                mirrorIndexUrl = $tg
                serveUrl = $sv
                funnelUrl = $fu
                startedAt = (To-IsoUtc $sa)
                runStartedAt = (To-IsoUtc $rsa)
                sessionStartedAt = (To-IsoUtc $ssa)
                sessionEnd = $(if ($sessionEnd) { $sessionEnd.ToString('o') } else { '' })
                legacyIndexUrl = $lu
                legacyDecryptKey = $lk
                rentryNewUrl = $rn
                runnerEgressIp = $eg
                keepAliveDeadline = [string]$cfg.keepAliveDeadline
                keepAlivePhase = [string]$cfg.keepAlivePhase
                pagesBase = [string]$cfg.pagesBase
                creds = [ordered]@{ ip = $ip; user = $us; pass = $pw }
                ts = $prog.ts
                alive = [bool]$prog.alive
                active = $prog.active
                agg = $prog.agg
                telemetry = $prog.telemetry
                archives = $prog.archives
                files = $prog.files
                log = $prog.log
                progress = $prog
                conn = $null
                wire = $wireNow
            }
            try { $cp = Join-Path $Root 'conn-probe.json'; if (Test-Path -LiteralPath $cp) { $conn = (Get-Content -LiteralPath $cp -Raw | ConvertFrom-Json) } } catch { }
            $obj.conn = $conn
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json' -Body (ConvertTo-JsonBytes $obj)
            return
        }
        if (($path -eq '/') -or ($path -eq '/index.html')) {
            $html = '<h1>Mission Control UI file missing</h1>'
            try { $html = [System.IO.File]::ReadAllText($script:UiPath, [System.Text.Encoding]::UTF8) } catch { }
            $ip = ''; $us = ''; $pw = ''; $mk = ''; $tg = ''
            if ($cfg) {
                $ip = [string]$cfg.rdpIp; $us = [string]$cfg.rdpUser; $pw = [string]$cfg.rdpPass
                $tg = [string]$cfg.mirrorIndexUrl
                if ([bool]$cfg.mirror) { $mk = [string]$cfg.mirrorKey }
            }
            $html = $html.Replace('__IP__', $ip).Replace('__USER__', $us).Replace('__PASS__', $pw).Replace('__MIRRORKEY__', $mk).Replace('__TELEGRAPH__', $tg)
            Send-ClientResponse -Stream $stream -Code 200 -CType 'text/html; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes($html))
            return
        }
        if ($path -eq '/rdp') {
            $rdpIp2 = ''; $rdpUser2 = ''
            if ($cfg) { $rdpIp2 = [string]$cfg.rdpIp; $rdpUser2 = [string]$cfg.rdpUser }
            $lines = @(
                'screen mode id:i:2',
                'desktopwidth:i:1920',
                'desktopheight:i:1080',
                'session bpp:i:32',
                'compression:i:1',
                'keyboardhook:i:2',
                'audiocapturemode:i:0',
                'videoplaybackmode:i:0',
                'connection type:i:3',
                'networkautodetect:i:0',
                'bandwidthautodetect:i:0',
                'disable wallpaper:i:1',
                'disable full window drag:i:1',
                'disable menu anims:i:1',
                'disable themes:i:0',
                'disable cursor setting:i:1',
                'bitmapcachepersist:i:1',
                'smart sizing:i:0',
                'redirectclipboard:i:1',
                'redirectprinters:i:0',
                'redirectcomports:i:0',
                'redirectsmartcards:i:0',
                'redirectdrives:i:0',
                'autoreconnection enabled:i:1',
                'prompt credential once:i:0',
                'enableworkspacereconnect:i:0',
                'use multimon:i:0',
                'enablerdpudp:i:1',
                ('full address:s:' + $rdpIp2),
                ('username:s:' + $rdpUser2),
                'prompt for credentials:i:1',
                'negotiate security layer:i:1'
            )
            $rdpTxt = ($lines -join "`r`n")
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/x-rdp-file; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes($rdpTxt))
            return
        }
        if ($path -eq '/ping') {
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json' -Body (ConvertTo-JsonBytes @{ ok = $true; ts = (Get-Date -Format o); wire = $script:Wire })
            return
        }
        if ($path -eq '/health') {
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json' -Body (ConvertTo-JsonBytes @{ ok = $true; ws = $false; port = $Port; pid = $PID; ts = (Get-Date -Format o) })
            return
        }
        if ($path -eq '/api/config') {
            if (Test-Path -LiteralPath $script:CfgPath) {
                $bytes = $null
                try {
                    $fs = [System.IO.File]::Open($script:CfgPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
                    $ms = New-Object System.IO.MemoryStream
                    $fs.CopyTo($ms); $fs.Dispose(); $bytes = $ms.ToArray(); $ms.Dispose()
                } catch { }
                if ($bytes) { Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json; charset=utf-8' -Body $bytes } else { Send-ClientResponse -Stream $stream -Code 500 -CType 'text/plain' -Body ([System.Text.Encoding]::UTF8.GetBytes('config read failed')) }
            } else {
                Send-ClientResponse -Stream $stream -Code 404 -CType 'text/plain' -Body ([System.Text.Encoding]::UTF8.GetBytes('config missing'))
            }
            return
        }
        if ($path -eq '/api/progress' -or $path -eq '/api/stats') {
            $prog2 = Read-JsonFile -Path $script:ProgPath
            $wireNow = Read-JsonFile -Path (Join-Path $script:Root 'wire-probe.json')
            if (-not $prog2) { $prog2 = [ordered]@{ ts=''; alive=$false; active=[ordered]@{name='';phase='idle';pct=0}; agg=[ordered]@{total=0;done=0;failed=0;active=0;bytesDone=0;bytesTotal=0;overallPct=0;speedBps=0}; telemetry=[ordered]@{scans=0;lastScan=''}; files=@(); log=@() } }
            $cfg2 = Read-JsonFile -Path $script:CfgPath
            $obj2 = [ordered]@{
                serverTs = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
                kind = 'snapshot'
                mirror = [bool]$cfg2.mirror
                encryptMode = [string]$cfg2.encryptMode
                mirrorKey = [string]$cfg2.mirrorKey
                mirrorIndexUrl = [string]$cfg2.mirrorIndexUrl
                rentryNewUrl = [string]$cfg2.rentryNewUrl
                legacyIndexUrl = [string]$cfg2.legacyIndexUrl
                legacyDecryptKey = [string]$cfg2.legacyDecryptKey
                runnerEgressIp = [string]$cfg2.runnerEgressIp
                keepAliveDeadline = [string]$cfg2.keepAliveDeadline
                keepAlivePhase = [string]$cfg2.keepAlivePhase
                pagesBase = [string]$cfg2.pagesBase
                startedAt = (To-IsoUtc ([string]$cfg2.startedAt))
                runStartedAt = (To-IsoUtc ([string]$cfg2.runStartedAt))
                sessionStartedAt = (To-IsoUtc ([string]$cfg2.sessionStartedAt))
                creds = [ordered]@{ ip = [string]$cfg2.rdpIp; user = [string]$cfg2.rdpUser; pass = [string]$cfg2.rdpPass }
                progress = $prog2
                conn = $null
                wire = $wireNow
            }
            try { $cp = Join-Path $Root 'conn-probe.json'; if (Test-Path -LiteralPath $cp) { $conn = (Get-Content -LiteralPath $cp -Raw | ConvertFrom-Json) } } catch { }
            $obj2.conn = $conn
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json' -Body (ConvertTo-JsonBytes $obj2)
            return
        }
        if ($path -eq '/parsec-push') {
            $j = $null
            try { $j = ([System.Text.Encoding]::UTF8.GetString([byte[]]$parts.body)) | ConvertFrom-Json } catch { }
            if (-not $j -or (-not $j.binB64)) {
                Send-ClientResponse -Stream $stream -Code 400 -CType 'application/json' -Body ([System.Text.Encoding]::UTF8.GetBytes('{"ok":false,"message":"missing binB64"}'))
                return
            }
            $ru = [string]$cfg.rdpUser
            $prof = $null
            try {
                $keys = Get-ChildItem 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList' -ErrorAction SilentlyContinue
                foreach ($k in $keys) {
                    $img = (Get-ItemProperty -Path $k.PSPath -Name ProfileImagePath -ErrorAction SilentlyContinue).ProfileImagePath
                    if ($img -and ((Split-Path -Leaf ([string]$img)) -ieq $ru)) { $prof = [string]$img; break }
                }
            } catch { }
            if (-not $prof) { $prof = 'C:\Users\' + $ru }
            $dest = Join-Path $prof 'AppData\Roaming\Parsec'
            try {
                New-Item -ItemType Directory -Path $dest -Force -ErrorAction Stop | Out-Null
                $cfgName = if ($j.cfgName) { [string]$j.cfgName } else { 'config.txt' }
                if ($j.cfgB64) { [System.IO.File]::WriteAllBytes((Join-Path $dest $cfgName), [Convert]::FromBase64String([string]$j.cfgB64)) }
                [System.IO.File]::WriteAllBytes((Join-Path $dest 'user.bin'), [Convert]::FromBase64String([string]$j.binB64))
                if ($j.hkB64) { [System.IO.File]::WriteAllBytes((Join-Path $dest 'hotkey.json'), [Convert]::FromBase64String([string]$j.hkB64)) }
                [System.IO.File]::WriteAllText((Join-Path $dest 'ghrdp-push.ok'), (Get-Date -Format o), $script:NoBom)
                $parsecExe = $null
                foreach ($cand in @('C:\Program Files\Parsec\parsecd.exe', 'C:\Program Files\Parsec\parsec.exe')) { if (Test-Path -LiteralPath $cand) { $parsecExe = $cand; break } }
                if ($parsecExe -and $ru) {
                    try { Get-Process -Name parsecd,parsec -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue } catch { }
                    try {
                        $ruPass = [string]$cfg.rdpPass
                        & schtasks.exe /Create /F /SC ONLOGON /TN 'GhrdpParsecStart' /TR ('"' + $parsecExe + '"') /RU $ru /RP $ruPass /IT 2>$null | Out-Null
                        $LASTEXITCODE = 0
                        & schtasks.exe /Run /TN 'GhrdpParsecStart' 2>$null | Out-Null
                        $LASTEXITCODE = 0
                    } catch { }
                }
                $out = @{ ok = $true; dest = $dest; cfg = $cfgName; src = ([string]$j.src) } | ConvertTo-Json -Compress
                Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json' -Body ([System.Text.Encoding]::UTF8.GetBytes($out))
            } catch {
                $out = @{ ok = $false; error = ($_.Exception.Message) } | ConvertTo-Json -Compress
                Send-ClientResponse -Stream $stream -Code 500 -CType 'application/json' -Body ([System.Text.Encoding]::UTF8.GetBytes($out))
            }
            return
        }
        Send-ClientResponse -Stream $stream -Code 404 -CType 'text/plain' -Body ([System.Text.Encoding]::UTF8.GetBytes('not found'))
    } catch {
        try { Send-ClientResponse -Stream $stream -Code 500 -CType 'application/json' -Body (ConvertTo-JsonBytes @{ serverTs = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'); handlerError = $_.Exception.Message }) } catch { }
    } finally {
        try { if ($stream) { $stream.Dispose() } } catch { }
        try { $Client.Close() } catch { }
    }
}
$script:Wire = $null
$lastWirePing = [datetime]::MinValue
$tsExe = 'C:\Program Files\Tailscale\tailscale.exe'
$wireProbeScript = @'
$ErrorActionPreference = 'Continue'
$ts = 'C:\Program Files\Tailscale\tailscale.exe'
$out = 'C:\ghrdp\wire-probe.json'
$hist = New-Object System.Collections.ArrayList
while ($true) {
  $obj = @{ ts = (Get-Date).ToUniversalTime().ToString('o'); rtt = $null; via = 'unknown'; direct = $false; peerIp = ''; peerName = ''; jit = $null; hist = @() }
  try {
    $j = (& $ts status --json 2>$null) | ConvertFrom-Json
    $peer = $null
    if ($j -and $j.Peer) { foreach ($p in $j.Peer.PSObject.Properties) { if ($p.Value.Online) { $peer = $p.Value; break } } }
    if ($peer) {
      $obj.peerIp = @($peer.TailscaleIPs)[0]
      $obj.peerName = [string]$peer.HostName
      $o = (& $ts ping -c 1 --timeout 5s $obj.peerIp 2>$null) -join ' '
      if ($o -match 'in ([0-9]+)ms') { $obj.rtt = [int]$Matches[1] }
      if ($o -match 'via DERP\(([a-z0-9]+)\)') { $obj.via = 'DERP(' + $Matches[1] + ')'; $obj.direct = $false }
      elseif ($o -match 'via ([0-9][0-9.:]+)') { $obj.via = 'DIRECT ' + $Matches[1]; $obj.direct = $true }
      if ($null -ne $obj.rtt) { [void]$hist.Add([int]$obj.rtt); if ($hist.Count -gt 20) { $hist.RemoveAt(0) } }
      if ($hist.Count -ge 3) { $d = 0; for ($i = 1; $i -lt $hist.Count; $i++) { $d += [math]::Abs([int]$hist[$i] - [int]$hist[$i-1]) }; $obj.jit = [math]::Round($d / ($hist.Count - 1), 1) }
      $obj.hist = @($hist)
    }
  } catch { }
  try { [System.IO.File]::WriteAllText($out, ($obj | ConvertTo-Json -Compress)) } catch { }
  Start-Sleep -Seconds 4
}
'@
[System.IO.File]::WriteAllText((Join-Path $Root 'wire-probe.ps1'), $wireProbeScript, $script:NoBom)
try { Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',(Join-Path $Root 'wire-probe.ps1') -WindowStyle Hidden } catch { }
$listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Parse($Bind), $Port)
try { $listener.Start() } catch {
    try { [System.IO.File]::WriteAllText($script:OkFile, 'LISTEN_FAIL: ' + $_.Exception.Message, $script:NoBom) } catch { }
    exit 1
}
[System.IO.File]::WriteAllText($script:OkFile, ('LISTENING pid={0} bind={1} port={2} at={3}' -f $PID, $Bind, $Port, (Get-Date -Format o)), $script:NoBom)
$probeScript = @'
$ErrorActionPreference='Continue'
$ts='C:\Program Files\Tailscale\tailscale.exe'
$out='C:\ghrdp\conn-probe.json'
while($true){
  $obj=@{ts=(Get-Date).ToString('o'); rtt=$null; via='unknown'; direct=$false; peer=''}
  try{
    $j=(& $ts status --json 2>$null)|ConvertFrom-Json
    if($j -and $j.Peer){
      foreach($p in $j.Peer.PSObject.Properties){
        $peer=$p.Value
        if($peer.Online){
          $obj.peer=@($peer.TailscaleIPs)[0]
          break
        }
      }
    }
    if($obj.peer){
      $o=(& $ts ping -c 1 --timeout 2s $obj.peer 2>$null) -join ' '
      if($o -match 'via (DERP[A-Za-z0-9]*|[Dd]irect[A-Za-z0-9]*)'){ $obj.via=$Matches[1]; $obj.direct=($Matches[1] -like 'irect*' -or $Matches[1] -like 'D*irect*') }
      if($o -match 'in ([0-9.]+)\s*ms'){ $obj.rtt=[double]$Matches[1] }
    }
  }catch{}
  try{ [System.IO.File]::WriteAllText($out,($obj|ConvertTo-Json -Compress)) }catch{}
  Start-Sleep -Seconds 4
}
'@
$probePath = Join-Path $Root 'conn-probe.ps1'
[System.IO.File]::WriteAllText($probePath, $probeScript, $script:NoBom)
try { Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',$probePath -WindowStyle Hidden } catch { }
$start = Get-Date
$limit = New-TimeSpan -Minutes $LimitMinutes
$lastHeal = Get-Date
while (((Get-Date) - $start) -lt $limit) {
    while ($listener.Pending()) {
        $client = $null
        try { $client = $listener.AcceptTcpClient() } catch { }
        if ($client) { Invoke-ClientRequest -Client $client -Token $script:Token }
    }
    if (((Get-Date) - $lastHeal).TotalSeconds -ge 60) {
        $lastHeal = Get-Date
        try { Start-ScheduledTask -TaskName 'GhrdpWatcher' -ErrorAction SilentlyContinue } catch { }
    }
    Start-Sleep -Milliseconds 50
}
try { $listener.Stop() } catch { }
