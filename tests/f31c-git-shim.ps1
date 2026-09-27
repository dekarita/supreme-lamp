# [F31c §5] LAB-ONLY git shim. autologin-lab cell Y prepends this to the
# extracted token-diagnostic block so a dry-run failure is simulated without
# touching a real remote. Not used by main.yml.
function git {
    $line = ($args -join ' ')
    if ($line -match 'push' -and $line -match 'dry-run') {
        if ($env:F31C_GIT_MODE -eq 'fail') {
            Write-Output 'remote: HTTP 401: Bad credentials'
            $global:LASTEXITCODE = 1
            return
        }
        Write-Output 'Everything up-to-date'
        $global:LASTEXITCODE = 0
        return
    }
    $global:LASTEXITCODE = 0
}
