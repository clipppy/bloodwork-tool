# Start-BloodworkTool.ps1
#
# Wrapper launched by the "BloodworkTool" Windows scheduled task at logon.
# It starts the Next.js UI (`npm run ui`) from the repo folder and writes all
# output to logs under %TEMP%. The scheduled task runs this hidden, so no
# console window ever appears for Melissa.
#
# Full install guide: scripts/install/windows-install.md
#
# Logs:
#   %TEMP%\bloodwork-tool.log        (normal output)
#   %TEMP%\bloodwork-tool.error.log  (errors)

# Resolve the repo from THIS script's own location (it lives at
# <repo>\scripts\install\Start-BloodworkTool.ps1, so the repo root is two levels
# up). This makes the tool run from wherever it's actually installed instead of a
# hard-coded Documents path — matching how Update-BloodworkTool.ps1 already
# resolves the repo, and sidestepping OneDrive-synced Documents folders entirely.
$repo   = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$logOut = Join-Path $env:TEMP 'bloodwork-tool.log'
$logErr = Join-Path $env:TEMP 'bloodwork-tool.error.log'

function Write-ErrLog([string]$message) {
    $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    Add-Content -Path $logErr -Value "[$stamp] Start-BloodworkTool: $message"
}

# 1. Sanity-check that we resolved to an actual repo root (contains package.json).
#    With $repo derived from $PSScriptRoot this only fails if this script was moved
#    out of <repo>\scripts\install\.
if (-not (Test-Path -LiteralPath (Join-Path $repo 'package.json'))) {
    Write-ErrLog "Resolved repo root '$repo' has no package.json — Start-BloodworkTool.ps1 must live in <repo>\scripts\install\. Restore it there and restart the task."
    exit 1
}

# 2. npm must be on PATH (i.e. Node.js is installed).
$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npm) { $npm = Get-Command npm -ErrorAction SilentlyContinue }
if (-not $npm) {
    Write-ErrLog "npm was not found on PATH. Install Node.js (Phase B) and confirm 'node --version' works in a new PowerShell window."
    exit 1
}

# 3. Launch the UI. stdout and stderr go to separate log files. -Wait keeps
#    this wrapper alive for as long as the dev server runs, so the scheduled
#    task stays in the "Running" state (and can restart it on failure).
try {
    Start-Process -FilePath $npm.Source `
        -ArgumentList 'run', 'ui' `
        -WorkingDirectory $repo `
        -RedirectStandardOutput $logOut `
        -RedirectStandardError $logErr `
        -NoNewWindow -Wait
}
catch {
    Write-ErrLog "Failed to start 'npm run ui': $($_.Exception.Message)"
    exit 1
}
