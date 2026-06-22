@echo off
REM Update-BloodworkTool.cmd — double-click this to update the Bloodwork Tool.
REM It just runs Update-BloodworkTool.ps1 with an execution policy that lets it
REM run, so the practice never has to touch PowerShell. The -NoProfile / -Bypass
REM flags mean this works even if the machine has never set an execution policy.
REM Full runbook: scripts/install/windows-install.md ("Updating the tool").
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Update-BloodworkTool.ps1"
REM Backup pause in case PowerShell exits before its own Read-Host runs.
pause
