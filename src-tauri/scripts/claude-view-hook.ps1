# claude-view hook bridge (Windows).
# No-op when not inside a claude-view-launched session.
if (-not $env:CLAUDE_VIEW_ID -or -not $env:CLAUDE_VIEW_PORT) { exit 0 }
# The port is injected by the app and is always an integer; refuse anything else
# rather than interpolate it into a path below.
if ($env:CLAUDE_VIEW_PORT -notmatch '^\d+$') { exit 0 }

# The auth token is not in the environment; read it from the discovery file the
# app writes on startup.
#
# Preferred: instances\<port>.json — the filename IS the port, so two running
# apps can never clobber each other's file and the port check is implicit.
# Fallback: the legacy shared instance.json, which must be checked against this
# session's port because any instance may have been the last to write it.
$dir     = Join-Path $env:USERPROFILE ".claude\claude-view"
$perPort = Join-Path $dir "instances\$($env:CLAUDE_VIEW_PORT).json"
$legacy  = Join-Path $dir "instance.json"

$token = $null
if (Test-Path $perPort) {
    try { $token = (Get-Content -Raw $perPort | ConvertFrom-Json).token } catch { exit 0 }
} elseif (Test-Path $legacy) {
    try { $info = Get-Content -Raw $legacy | ConvertFrom-Json } catch { exit 0 }
    if ("$($info.port)" -ne "$env:CLAUDE_VIEW_PORT") { exit 0 }
    $token = $info.token
}
if (-not $token) { exit 0 }

$payload = [Console]::In.ReadToEnd()

try {
    Invoke-RestMethod -Uri "http://127.0.0.1:$($env:CLAUDE_VIEW_PORT)/hooks" `
        -Method Post `
        -ContentType "application/json" `
        -Headers @{
            "X-Claude-View-Id"    = $env:CLAUDE_VIEW_ID
            "X-Claude-View-Token" = $token
        } `
        -Body $payload `
        -TimeoutSec 2 | Out-Null
} catch {}

exit 0
