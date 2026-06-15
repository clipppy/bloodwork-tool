# Bloodwork Tool — Install Guide (Melissa Tulisano's Windows 11 PC)

This guide is for **Clay** to follow during the on-site install. Work top to
bottom — don't skip phases. Each step says what you're doing, the exact command
to copy-paste, how to confirm it worked, and what to do if it doesn't.

This is the **Windows** counterpart to `install.md` (the Mac guide). The tool
itself is identical on both platforms — only the OS setup differs (PowerShell
instead of Terminal, Windows paths, and Windows Task Scheduler instead of
launchd).

**End goal:** the lab-report UI auto-starts every time Melissa logs in, so she
never opens PowerShell. She just visits `http://localhost:3000` in her browser.

**The plan in one sentence:** install Node → clone the repo into
`Documents\bloodwork-tool` → test it → register a scheduled task so it
auto-starts → verify → bookmark it → do one real report together.

> **Conventions used below**
> - The repo lives at `$env:USERPROFILE\Documents\bloodwork-tool` (i.e.
>   `C:\Users\<her-username>\Documents\bloodwork-tool`). Every command uses
>   `$env:USERPROFILE` / `$env:USERNAME` / `$env:TEMP` so nothing needs manual
>   substitution — it works for whatever her Windows username turns out to be.
> - The scheduled task is named **`BloodworkTool`** (no spaces).
> - Everything runs as **Melissa's** Windows user. She has admin access, so
>   we open PowerShell **as Administrator** but the task is still configured to
>   run as her normal account — never as SYSTEM.
> - All commands are **PowerShell**. Windows 11 24H2 ships PowerShell 5.1 by
>   default; everything here also works in PowerShell 7+.

> **Firewall note — read before you start.** This practice is behind a
> **Computech-managed firewall**. If any download or install step is blocked,
> call Computech and ask them to whitelist these domains:
>
> - `nodejs.org`
> - `git-scm.com`
> - `github.com` (and `*.githubusercontent.com`)
> - `registry.npmjs.org`

---

## Phase A — Pre-flight check (what's already installed)

**What you're doing:** opening an admin PowerShell and finding out what's
already on the machine so you only install what's missing.

1. Click **Start**, type `powershell`, right-click **Windows PowerShell**, and
   choose **Run as administrator**. Click **Yes** on the UAC prompt.
2. Confirm the Windows version — run `winver` (a dialog should say **Windows 11**,
   version **24H2**), or check **Settings → System → About**.
3. Check what's installed:

```powershell
node --version          # Node.js (want v18.17+ or any v20 LTS)
npm --version           # npm (comes with Node)
git --version           # git
$env:USERNAME           # her Windows username — note this down
```

**Verify:** you want a `node` version of **v18.17 or higher** (v20.x LTS is
ideal). On a fresh Windows machine, none of `node`, `npm`, or `git` will be
present yet — that's expected.

**If it fails:**
- `node : The term 'node' is not recognized...` → Node isn't installed.
  Continue to **Phase B**.
- `git : The term 'git' is not recognized...` → Git isn't installed. Phase B
  covers Git too.
- Node version is **older than v18.17** → treat it as "needs install" and do
  **Phase B** (the nodejs.org installer upgrades in place).
- A download in Phase B gets blocked / times out → it's almost certainly the
  Computech firewall. Call them with the domain list from the top of this guide.

---

## Phase B — Install Node.js and Git (only what Phase A showed is missing)

**What you're doing:** installing Node.js (and Git, if missing) using the
standard installers. Skip whichever is already present.

### Node.js

1. Open a browser and go to **https://nodejs.org**.
2. Download the **LTS** version (the big green button — currently the 20.x
   line). It downloads an installer ending in **`.msi`**.
3. Run the `.msi` and click through the dialog:
   **Next → accept the license → Next → keep the default install location
   (`C:\Program Files\nodejs\`) → Next → Next → Install → Yes** on the UAC
   prompt → **Finish**.
4. **IMPORTANT:** on the "Tools for Native Modules" screen, leave the
   **"Automatically install the necessary tools..."** checkbox **UNCHECKED**.
   We do **not** need Chocolatey / Python / Visual Studio Build Tools for this
   project — checking it kicks off a long, error-prone extra install.

**Verify:** open a **brand-new** PowerShell window (important — the old one
won't see the new PATH) and run:

```powershell
node --version
npm --version
```

Both should print version numbers. If you opened the new window as a normal
(non-admin) user, that's fine for this check — just remember Phase E needs an
**admin** window again.

### Git (if Phase A showed it missing)

1. Go to **https://git-scm.com/download/win** — the download starts
   automatically (a `.exe`).
2. Run it and click **Next** through every screen — the **default options are
   fine** for our use. Finish the installer.

**Verify:** in a new PowerShell window:

```powershell
git --version
```

**If it fails:**
- `node` still not recognized in a new window → confirm the `.msi` actually
  finished. Check the install landed: `Test-Path 'C:\Program Files\nodejs\node.exe'`
  should print `True`. If it's `True` but `node` isn't found, you're still in an
  old window — open a fresh PowerShell.
- The installer download is blocked → Computech firewall; see the domain list
  at the top.

---

## Phase C — Clone the repo and install dependencies

**What you're doing:** downloading the tool into
`Documents\bloodwork-tool` and installing its packages.

```powershell
cd $env:USERPROFILE\Documents
git clone https://github.com/clipppy/bloodwork-tool.git
cd $env:USERPROFILE\Documents\bloodwork-tool
npm install
```

**Verify:**

```powershell
Test-Path $env:USERPROFILE\Documents\bloodwork-tool\package.json   # True
Test-Path $env:USERPROFILE\Documents\bloodwork-tool\node_modules   # True
```

Both must print `True`.

**If it fails:**
- `git clone` asks for a username/password or says **repository not found** →
  the repo is private. Sign in to the browser with the GitHub account that has
  access, or generate a Personal Access Token and paste it as the password when
  prompted. (You can also clone on your own laptop and copy the folder to
  `C:\Users\<her>\Documents\bloodwork-tool`, but `npm install` still has to run
  on her PC.)
- `npm install` errors about Node version → Node is too old; redo **Phase B**
  with the LTS, open a new PowerShell, then re-run `npm install`.
- `npm install` hangs, times out, or fails on `registry.npmjs.org` → that's the
  Computech firewall blocking npm. Call them with the domain list (especially
  `registry.npmjs.org`), then re-run `npm install` (it resumes safely).

---

## Phase D — First test run (prove it works before automating)

**What you're doing:** starting the UI by hand once, to confirm the app loads
before we hand it to Task Scheduler.

```powershell
cd $env:USERPROFILE\Documents\bloodwork-tool
npm run ui
```

Wait for a line like `✓ Ready` / `Local: http://localhost:3000`. Then open a
browser to:

```
http://localhost:3000
```

**Verify:** the bloodwork tool's web page loads in the browser.

**Stop the test** when you're satisfied: click back in the PowerShell window and
press **Ctrl + C** (answer `Y` if it asks to terminate the batch job). We only
ran it by hand to confirm — the scheduled task runs it for real in Phase E.

**If it fails:**
- Browser says "can't connect" → look at the PowerShell output. If you see
  `EADDRINUSE` / port 3000 in use, something is already on that port; see the
  port-3000 fix in **Troubleshooting**, then re-run `npm run ui`.
- PowerShell shows a build/compile error → screenshot it. Confirm `npm install`
  finished cleanly in Phase C; re-run `npm install`, then `npm run ui`.

---

## Phase E — Register the scheduled task (auto-start on login)

**What you're doing:** registering a Windows scheduled task so the UI starts
automatically every time Melissa logs in — no PowerShell needed. The task runs
the `Start-BloodworkTool.ps1` wrapper that ships in the repo.

Do this in the **admin** PowerShell window. Copy-paste this whole block — it
builds the task and registers it in one go:

```powershell
$repo   = Join-Path $env:USERPROFILE 'Documents\bloodwork-tool'
$script = Join-Path $repo 'scripts\install\Start-BloodworkTool.ps1'

$action  = New-ScheduledTaskAction -Execute 'powershell.exe' `
           -Argument "-WindowStyle Hidden -ExecutionPolicy Bypass -NoProfile -File `"$script`""

$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"

$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
             -LogonType Interactive -RunLevel Limited

$settings = New-ScheduledTaskSettingsSet `
            -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
            -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
            -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask -TaskName 'BloodworkTool' `
    -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
    -Description 'Auto-start the Bloodwork Tool UI at logon.' -Force
```

What that does, in plain terms:
- **Triggers at logon** for Melissa's account.
- **Runs `powershell.exe -WindowStyle Hidden -File Start-BloodworkTool.ps1`** —
  hidden, so no window pops up.
- **Runs as her** (`-RunLevel Limited` = her normal user, **not** SYSTEM, not
  elevated).
- **Restarts on failure** every 1 minute, up to 3 times, and has **no run-time
  limit** (the dev server is meant to run all day).
- `-Force` lets you re-run the whole block later to overwrite the task cleanly.

**Verify:**

```powershell
Get-ScheduledTask -TaskName "BloodworkTool"
```

You should see a task named `BloodworkTool` with **State** `Ready`.

**If it fails:**
- `Register-ScheduledTask : Access is denied` → your PowerShell isn't elevated.
  Close it, reopen **as Administrator** (Phase A step 1), and re-run the block.
- `Cannot find path ...Start-BloodworkTool.ps1` → the repo isn't at
  `Documents\bloodwork-tool`, or Phase C didn't finish. Confirm
  `Test-Path $script` prints `True`, then re-run.
- A task already exists from an earlier attempt → the `-Force` flag overwrites
  it, so just re-run the block. (To wipe it entirely, see **Full uninstall** in
  Troubleshooting.)

---

## Phase F — Verify auto-start actually works

**What you're doing:** proving the task brings the UI up on its own, the way it
will every morning when Melissa logs in.

**Option 1 — without logging out (fast, do this first):** start the task by
hand, exactly as a logon would:

```powershell
Start-ScheduledTask -TaskName "BloodworkTool"
```

Wait ~10 seconds (give Node a moment to boot), then open
`http://localhost:3000` in the browser. It should load **without** you having
run `npm run ui` yourself.

**Option 2 — the real thing (do this once to be sure):** **log out** of her
Windows account (Start → her profile icon → **Sign out**), log back in, wait
~15 seconds, and open `http://localhost:3000`. Do **not** open PowerShell —
that's the whole point.

**Verify:** the page loads in the browser after the manual start / after a real
logout-login, with no PowerShell step.

**If it fails:**
- Page doesn't load after `Start-ScheduledTask` → check the task ran and read
  the logs:
  ```powershell
  Get-ScheduledTask -TaskName "BloodworkTool" | Get-ScheduledTaskInfo
  Get-Content $env:TEMP\bloodwork-tool.error.log -Tail 40
  ```
  See the **Troubleshooting** section below.

---

## Phase G — Bookmark localhost:3000 in her browser

**What you're doing:** making the tool one click away for Melissa. Windows 11
ships **Microsoft Edge** as the default browser; cover whichever she actually
uses.

### Microsoft Edge

1. Go to `http://localhost:3000`.
2. Click the ☆ star at the right of the address bar → name it
   **"Bloodwork Tool"** → in the **Folder** dropdown choose **Favorites bar** →
   **Done**.
3. Make the favorites bar always visible: click **`...`** (top-right) →
   **Settings → Appearance → Show favorites bar → Always**. (Quick toggle:
   **Ctrl + Shift + B**.)

### Google Chrome (if she uses it)

1. Go to `http://localhost:3000`.
2. Click the ☆ star in the address bar → name it **"Bloodwork Tool"** → choose
   the **Bookmarks bar** → **Done**.
3. Show the bar: **`⋮` → Bookmarks and lists → Show bookmarks bar** (or
   **Ctrl + Shift + B**).

**Verify:** close the tab, click the **Bloodwork Tool** bookmark on the bar, and
confirm it opens the tool.

---

## Phase H — Walk Melissa through her first generation

**What you're doing:** doing one real report together so she's confident using
it solo.

1. Have her click the **Bloodwork Tool** bookmark.
2. **Drag a sample lab PDF** into the drop zone on the page.
3. **Type the patient name.** Leave the **date** set to today (it defaults to
   today's date).
4. Click **Generate**.
5. The Word report downloads to her **Downloads** folder (`File Explorer →
   Downloads`, or the browser's downloads tray). Open the `.docx` in **Word or
   Google Docs** and confirm it looks right — spot-check that the header reads
   **CARBONE CHIROPRACTIC CENTER, LLC**, that **PART I** opens with the new
   **Flagged Markers** list, and that values look correct.
6. Tell her the one rule she needs to remember: **"If the page ever won't load,
   restart the computer and wait a minute — it starts itself."** She never needs
   PowerShell.

**Verify:** Melissa generates a report end-to-end **herself**, while you watch.

---

# Troubleshooting

Run these in PowerShell, as Melissa's user. A few need the **admin** window
(noted inline).

**Is the task running?**
```powershell
Get-ScheduledTask -TaskName "BloodworkTool" | Get-ScheduledTaskInfo
```
Look at **LastTaskResult** (`0` is healthy) and **LastRunTime**. `Get-ScheduledTask
-TaskName "BloodworkTool"` on its own shows the **State** (`Running` once it's up).

**View the logs:**
```powershell
Get-Content $env:TEMP\bloodwork-tool.log -Tail 40         # normal output
Get-Content $env:TEMP\bloodwork-tool.error.log -Tail 40   # errors
```
Add `-Wait` to either to watch it live (Ctrl + C to stop watching).

**Start / stop the task by hand:**
```powershell
Start-ScheduledTask -TaskName "BloodworkTool"
Stop-ScheduledTask  -TaskName "BloodworkTool"
```

**Update the tool to the latest code later:**
```powershell
cd $env:USERPROFILE\Documents\bloodwork-tool
git pull
npm install            # only needed if package.json changed; harmless to run anyway
Stop-ScheduledTask  -TaskName "BloodworkTool"
Start-ScheduledTask -TaskName "BloodworkTool"
```

**Full uninstall** (admin window):
```powershell
Unregister-ScheduledTask -TaskName "BloodworkTool" -Confirm:$false
Remove-Item -Recurse -Force $env:USERPROFILE\Documents\bloodwork-tool
```

**Common failure — port 3000 already in use** (page won't load, error log shows
`EADDRINUSE`): find what's holding the port and stop it, then restart the task.
```powershell
Get-Process -Id (Get-NetTCPConnection -LocalPort 3000).OwningProcess
Stop-Process -Id (Get-NetTCPConnection -LocalPort 3000).OwningProcess -Force
Start-ScheduledTask -TaskName "BloodworkTool"
```

**Common failure — Computech firewall blocking installs/updates:** if
`npm install`, `git clone`, or `git pull` hangs or fails on a network error,
call Computech and ask them to whitelist these domains:
- `nodejs.org`
- `git-scm.com`
- `github.com` (and `*.githubusercontent.com`)
- `registry.npmjs.org`

**Other common causes when it won't start** (check the error log first):
- **npm / Node not found** → the error log says so explicitly. Confirm
  `node --version` works in a new PowerShell window; if not, redo **Phase B**.
- **Repo folder isn't at `Documents\bloodwork-tool`** → the wrapper and the task
  are hard-coded to that location; the repo must live exactly there. The error
  log will name the path it expected.
- **Task result isn't 0** → read `bloodwork-tool.error.log`; it captures
  whatever `npm run ui` printed when it crashed.
