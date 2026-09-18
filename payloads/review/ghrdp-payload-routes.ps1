# Dot-source this file once from ghrdp-server.ps1, before its request loop.
# Call Send-GhrdpPayloadRoute ONLY after the server's existing authorization check.
function Send-GhrdpPayloadRoute {
    param([Parameter(Mandatory = $true)][System.Net.HttpListenerContext]$Context)
    $routes = @{
        '/api/enroll.ps1' = 'C:\ghrdp\ghrdp-enroll.ps1'
        '/api/diag.ps1' = 'C:\ghrdp\ghrdp-diag.ps1'
        '/api/acceptance.ps1' = 'C:\ghrdp\ghrdp-acceptance.ps1'
        '/api/accept.ps1' = 'C:\ghrdp\ghrdp-acceptance.ps1'
    }
    $path = $Context.Request.Url.AbsolutePath.ToLowerInvariant()
    if (-not $routes.ContainsKey($path)) { return $false }
    $r = $Context.Response
    $r.Headers['Cache-Control'] = 'no-store'
    $r.Headers['X-Content-Type-Options'] = 'nosniff'
    $r.Headers['Referrer-Policy'] = 'no-referrer'
    $bytes = $null
    if ($Context.Request.HttpMethod -ne 'GET') {
        $r.StatusCode = 405
        $r.Headers['Allow'] = 'GET'
        $r.ContentType = 'text/plain; charset=utf-8'
        $bytes = [Text.Encoding]::UTF8.GetBytes('Method not allowed')
    } elseif (-not (Test-Path -LiteralPath $routes[$path] -PathType Leaf)) {
        $r.StatusCode = 503
        $r.ContentType = 'text/plain; charset=utf-8'
        $bytes = [Text.Encoding]::UTF8.GetBytes('Payload not staged')
    } else {
        # Preserve bytes: /agent-hash and downloaded sources must describe the same bytes.
        $bytes = [IO.File]::ReadAllBytes($routes[$path])
        $r.StatusCode = 200
        $r.ContentType = 'text/plain; charset=utf-8'
        $r.Headers['Content-Disposition'] = 'attachment; filename=' + [IO.Path]::GetFileName($routes[$path])
    }
    try {
        $r.ContentLength64 = $bytes.Length
        $r.OutputStream.Write($bytes, 0, $bytes.Length)
    } finally { $r.Close() }
    return $true
}
