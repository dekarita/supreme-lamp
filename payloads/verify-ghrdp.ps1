# Retired legacy verifier.
# The former script invoked a superseded ghrdp:// URL carrying a token and used
# UI automation. Neither behavior is compatible with the current safe launcher.
# Run the current checks from the dashboard: client DNS probe, launcher beacon,
# RDP LISTENER fields, then WINDOWS AUTO-LOGIN. This stub performs no launch,
# credential operation, UI interaction, or network request.
Write-Host 'This legacy verifier is retired. Use the dashboard diagnostics and the current install.cmd launcher.'
