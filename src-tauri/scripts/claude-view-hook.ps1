# claude-view hook bridge (Windows).
# No-op when not inside a claude-view-launched session.
if (-not $env:CLAUDE_VIEW_ID -or -not $env:CLAUDE_VIEW_PORT) { exit 0 }

# The auth token is not in the environment; read it from the discovery file the
# app writes on startup, and only trust it if the port matches this session.
$instance = Join-Path $env:USERPROFILE ".claude\claude-view\instance.json"
if (-not (Test-Path $instance)) { exit 0 }
try {
    $info = Get-Content -Raw $instance | ConvertFrom-Json
} catch { exit 0 }
if ("$($info.port)" -ne "$env:CLAUDE_VIEW_PORT") { exit 0 }
$token = $info.token
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
