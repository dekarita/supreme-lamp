# [F92 §1.5] Pester tests for the hardened HTTP wrapper + the F92 fanout.
# The server file STARTS a listener when dot-sourced, so these tests extract
# the F92 function text by brace balance and Invoke-Expression it into the test
# scope - the same no-boot idiom the f60 lab tests use.
$ErrorActionPreference = 'Stop'
$serverPath = Join-Path $PSScriptRoot '..' '..' 'payloads' 'ghrdp-server.ps1'

BeforeAll {
    $script:ServerPath = Join-Path $PSScriptRoot '..' '..' 'payloads' 'ghrdp-server.ps1'
    # Pester 5 runs BeforeAll in a fresh scope: do the extraction inline.
    $text = ''
    foreach ($fn in @('Get-F92HeaderValue', 'Invoke-F92Http')) {
        $lines = Get-Content -LiteralPath $script:ServerPath
        $start = -1
        for ($i = 0; $i -lt $lines.Count; $i++) {
            if ($lines[$i] -match ('^\s*function\s+' + [regex]::Escape($fn) + '\s*\{')) { $start = $i; break }
        }
        if ($start -lt 0) { throw "function $fn not found in the server file" }
        $depth = 0
        $end = -1
        for ($i = $start; $i -lt $lines.Count; $i++) {
            $depth += ([regex]::Matches($lines[$i], '\{')).Count
            $depth -= ([regex]::Matches($lines[$i], '\}')).Count
            if ($depth -eq 0 -and $i -gt $start) { $end = $i; break }
        }
        if ($end -lt 0) { throw "unbalanced braces extracting $fn" }
        $text += ($lines[$start..$end] -join "`n") + "`n"
    }
    Invoke-Expression $text
}

Describe 'Invoke-F92Http (F92 §1.2)' {
    It 'returns the uniform success shape with Ok/HttpStatus/CfRay/ElapsedMs/Bytes/Content' {
        Mock Invoke-WebRequest {
            return [pscustomobject]@{
                StatusCode       = 200
                RawContentLength = 12
                Content          = '{"ok":true}'
                Headers          = @{ 'cf-ray' = @('deadbeefed') }
            }
        }
        $r = Invoke-F92Http -Uri 'https://api.openverse.org/v1/images/?q=Saturn%27s'
        $r.Ok | Should -BeTrue
        $r.HttpStatus | Should -Be 200
        $r.CfRay | Should -Be 'deadbeefed'
        $r.Bytes | Should -Be 12
        $r.Content | Should -Be '{"ok":true}'
        $r.Error | Should -BeNullOrEmpty
        $r.ElapsedMs | Should -BeGreaterOrEqual 0
    }

    It 'returns the uniform failure shape (Ok=false, Error text) instead of throwing' {
        Mock Invoke-WebRequest { throw 'boom' }
        $r = Invoke-F92Http -Uri 'https://example.invalid/'
        $r.Ok | Should -BeFalse
        $r.Error | Should -Not -BeNullOrEmpty
        $r.Content | Should -BeNullOrEmpty
        $r.Bytes | Should -Be 0
    }

    It 'applies -UserAgent and the Accept default on every call' {
        $seen = @{}
        Mock Invoke-WebRequest -MockWith {
            $seen['UserAgent'] = $UserAgent
            $seen['Headers'] = $Headers
            return [pscustomobject]@{ StatusCode = 200; RawContentLength = 1; Content = 'x'; Headers = @{} }
        } -Verifiable
        $null = Invoke-F92Http -Uri 'https://example.invalid/' -UserAgent 'ua-f92-test'
        Should -InvokeVerifiable
        $seen['UserAgent'] | Should -Be 'ua-f92-test'
        $seen['Headers']['Accept'] | Should -BeLike '*application/json*'
    }

    It 'URL-encodes the apostrophe: Saturn''s -> Saturn%27s (via EscapeDataString contract)' {
        # The encoding itself is pinned on the fanout side (Invoke-F92SiteSearch
        # builds every URL through [Uri]::EscapeDataString); here we pin that a
        # pre-encoded URI reaches Invoke-WebRequest byte-for-byte.
        Mock Invoke-WebRequest {
            return [pscustomobject]@{ StatusCode = 200; RawContentLength = 1; Content = 'x'; Headers = @{} }
        } -ParameterFilter { $Uri -eq ('https://api.openverse.org/v1/images/?q=' + [Uri]::EscapeDataString("Saturn's Rings")) }
        $q = [Uri]::EscapeDataString("Saturn's Rings")
        $q | Should -Be 'Saturn%27s%20Rings'
        $r = Invoke-F92Http -Uri ('https://api.openverse.org/v1/images/?q=' + $q)
        $r.Ok | Should -BeTrue
        Should -Invoke Invoke-WebRequest -Times 1 -Exactly
    }
}
