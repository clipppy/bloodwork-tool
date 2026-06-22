# Update-BloodworkTool.ps1
#
# One-click updater for the deployed Bloodwork Tool. A non-technical user
# double-clicks Update-BloodworkTool.cmd, which runs this. It pulls the latest
# code from origin/main, reinstalls dependencies, and restarts the tool the
# SAME way Start-BloodworkTool.ps1 / Task Scheduler do (the "BloodworkTool"
# scheduled task), then health-checks http://localhost:3000.
#
# Companion to Start-BloodworkTool.ps1. Full install/runbook:
#   scripts/install/windows-install.md  (see "Updating the tool")
#
# The start flow runs the UI in DEV mode (`npm run ui` -> `next dev`), so there
# is NO production build step to run here — see Step 6.
#
# Every step is echoed (timestamped) and also appended to:
#   update-log.txt  (next to this script) — send this file to Clay if it fails.

$ErrorActionPreference = 'Stop'

# Must match the scheduled task registered in Phase E of windows-install.md.
$TaskName = 'BloodworkTool'

$scriptDir = $PSScriptRoot
$logFile   = Join-Path $scriptDir 'update-log.txt'

# ---- logging helper: echo to console AND append to update-log.txt ----
function Log {
    param([string]$Message)
    $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    $line  = "[$stamp] $Message"
    Write-Host $line
    try { Add-Content -Path $logFile -Value $line } catch { Write-Host "  (could not write to log: $($_.Exception.Message))" }
}

# Tracks the current step so the catch block can report exactly what failed.
$step = 'startup'

Log '================================================================'
Log 'Update-BloodworkTool starting.'

try {
    # ---- Step 1: strict error handling (set above; record it) ----
    $step = '1/8 strict error handling'
    Log "STEP $step : `$ErrorActionPreference = Stop"

    # ---- Step 2: resolve the repo path the same place Start does ----
    # Start-BloodworkTool.ps1 lives in <repo>\scripts\install\, so the repo
    # root is two levels up from this script. We resolve relative to
    # $PSScriptRoot (not a hard-coded C:\Users\... path) so it keeps working
    # for whatever Windows username the machine has. This still equals
    # %USERPROFILE%\Documents\bloodwork-tool on the deployed machine.
    $step = '2/8 resolve repo path'
    Log "STEP $step"
    $repo = (Resolve-Path (Join-Path $scriptDir '..\..')).Path
    if (-not (Test-Path -LiteralPath (Join-Path $repo 'package.json'))) {
        throw "No package.json at '$repo' — this script must live in <repo>\scripts\install\."
    }
    Log "  Repo: $repo"
    Set-Location -LiteralPath $repo

    # Locate git and npm on PATH (same defensive lookup Start uses for npm).
    $git = Get-Command git.exe -ErrorAction SilentlyContinue
    if (-not $git) { $git = Get-Command git -ErrorAction SilentlyContinue }
    if (-not $git) { throw "git was not found on PATH. Install Git (Phase B of windows-install.md)." }
    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $npm) { $npm = Get-Command npm -ErrorAction SilentlyContinue }
    if (-not $npm) { throw "npm was not found on PATH. Install Node.js (Phase B of windows-install.md)." }

    # ---- Step 3: stop the running tool (same mechanism as Start) ----
    # Start runs via the "BloodworkTool" scheduled task, so we stop the task.
    # A known failure mode is the task being in a "confused state" — catch it,
    # print remediation, and carry on (freeing the port below still works).
    $step = '3/8 stop the tool'
    Log "STEP $step : Stop-ScheduledTask '$TaskName'"
    try {
        Stop-ScheduledTask -TaskName $TaskName
        Log "  Scheduled task stop requested."
    }
    catch {
        Log "  WARNING: could not stop scheduled task '$TaskName': $($_.Exception.Message)"
        Log "  REMEDIATION: the task may be missing or in a confused state. Re-register it"
        Log "  via the Phase E 'Register-ScheduledTask' block in scripts/install/windows-install.md."
    }

    # Backup: free port 3000 directly, the same way Troubleshooting does, in
    # case a stray node process kept it (so npm ci / restart aren't blocked).
    try {
        $conns = Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue
        if ($conns) {
            $pids = $conns | Select-Object -ExpandProperty OwningProcess -Unique
            foreach ($procId in $pids) {
                try {
                    Stop-Process -Id $procId -Force -ErrorAction Stop
                    Log "  Freed port 3000 (stopped PID $procId)."
                }
                catch { Log "  Note: could not stop PID $procId on port 3000: $($_.Exception.Message)" }
            }
        }
        else {
            Log "  Port 3000 already free."
        }
    }
    catch { Log "  Note: port-3000 check skipped: $($_.Exception.Message)" }

    # Give the dev server a moment to release files before pulling/installing.
    Start-Sleep -Seconds 2

    # ---- Step 4: pull latest code (hard reset to origin/main) ----
    # This machine is a PRISTINE DEPLOY MIRROR: the repo here is never edited
    # locally, so a hard reset to origin/main is the intended, safe way to take
    # the latest code (it discards nothing of value and avoids merge prompts a
    # non-technical user couldn't answer). Do NOT use this on a dev machine.
    $step = '4/8 git fetch + reset --hard origin/main'
    Log "STEP $step"
    & $git.Source fetch origin
    if ($LASTEXITCODE -ne 0) { throw "git fetch origin failed (exit $LASTEXITCODE)." }
    & $git.Source reset --hard origin/main
    if ($LASTEXITCODE -ne 0) { throw "git reset --hard origin/main failed (exit $LASTEXITCODE)." }
    $hash = (& $git.Source rev-parse --short HEAD).Trim()
    Log "  Now at commit: $hash"

    # ---- Step 5: deterministic dependency install from the lockfile ----
    $step = '5/8 npm ci'
    Log "STEP $step"
    & $npm.Source ci
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed (exit $LASTEXITCODE)." }
    Log "  Dependencies installed."

    # ---- Step 6: build — SKIPPED ----
    # The start flow runs the UI in DEV mode (`npm run ui` -> `next dev`), which
    # compiles on demand. There is no production `next build`/`next start` in the
    # start path, so there is nothing to build here. (If the start flow ever
    # switches to a production build, add `& $npm.Source run build` here.)
    $step = '6/8 build (skipped — dev mode)'
    Log "STEP $step : skipped; the tool runs via 'npm run ui' (next dev)."

    # ---- Step 7: restart the tool (same mechanism as Start) ----
    $step = '7/8 restart the tool'
    Log "STEP $step : Start-ScheduledTask '$TaskName'"
    try {
        Start-ScheduledTask -TaskName $TaskName
        Log "  Scheduled task start requested."
    }
    catch {
        Log "  WARNING: could not start scheduled task '$TaskName': $($_.Exception.Message)"
        Log "  REMEDIATION: the task may be missing or in a confused state. Re-register it"
        Log "  via the Phase E 'Register-ScheduledTask' block in scripts/install/windows-install.md,"
        Log "  then double-click Update-BloodworkTool.cmd again."
    }

    # ---- Step 8: health check — poll localhost:3000 for up to ~30s ----
    $step = '8/8 health check'
    Log "STEP $step : polling http://localhost:3000 (up to ~30s)"
    $isUp = $false
    for ($i = 1; $i -le 45; $i++) {
        try {
            $resp = Invoke-WebRequest -Uri 'http://localhost:3000' -UseBasicParsing -TimeoutSec 5
            if ($resp.StatusCode -ge 200 -and $resp.StatusCode -lt 500) { $isUp = $true; break }
        }
        catch {
            # Not up yet (dev server still compiling, or connection refused).
        }
        Start-Sleep -Seconds 2
    }

    if ($isUp) {
        Log "RESULT: localhost:3000 UP — update complete at commit $hash."
        Write-Host ''
        Write-Host '  SUCCESS: the Bloodwork Tool is updated and running.' -ForegroundColor Green
        Write-Host "  Now at commit $hash. Open http://localhost:3000 to use it." -ForegroundColor Green
    }
    else {
        Log "RESULT: localhost:3000 DOWN after ~30s — the tool did not come back up."
        Write-Host ''
        Write-Host '  WARNING: the update ran but localhost:3000 is not responding yet.' -ForegroundColor Yellow
        Write-Host '  Wait a minute and refresh the page; if it stays down, send Clay the' -ForegroundColor Yellow
        Write-Host "  update-log.txt file in this folder:" -ForegroundColor Yellow
        Write-Host "    $logFile" -ForegroundColor Yellow
    }
}
catch {
    Log "FAILED at step [$step]: $($_.Exception.Message)"
    Write-Host ''
    Write-Host "  UPDATE FAILED at step: $step" -ForegroundColor Red
    Write-Host "  $($_.Exception.Message)" -ForegroundColor Red
    Write-Host '  Send Clay the update-log.txt file in this folder:' -ForegroundColor Red
    Write-Host "    $logFile" -ForegroundColor Red
}
finally {
    Log 'Update-BloodworkTool finished.'
    Log '================================================================'
    Write-Host ''
    # Keep the window open so a non-technical user can read the outcome.
    Read-Host 'Press Enter to close'
}
