# Bloodwork Tool — Install Guide (Melissa Tulisano's Mac)

This guide is for **Clay** to follow during the on-site install. Work top to
bottom — don't skip phases. Each step says what you're doing, the exact command
to copy-paste, how to confirm it worked, and what to do if it doesn't.

**End goal:** the lab-report UI auto-starts every time Melissa logs in, so she
never opens Terminal. She just visits `http://localhost:3000` in her browser.

**The plan in one sentence:** install Node → clone the repo into
`~/Documents/bloodwork-tool` → test it → install a launchd service so it
auto-starts → verify → bookmark it → do one real report together.

> **Conventions used below**
> - The repo lives at `~/Documents/bloodwork-tool` (i.e.
>   `/Users/<her-username>/Documents/bloodwork-tool`).
> - The service is named `com.bloodwork-tool.ui`.
> - Everything runs as **Melissa's** macOS user — do **not** use `sudo` for any
>   of this. If a command asks for a password, stop and re-read the step.
> - Run every command in **her** account, in the **Terminal** app
>   (Applications → Utilities → Terminal).

---

## Phase A — Pre-flight check (what's already installed)

**What you're doing:** finding out what's already on the machine so you only
install what's missing.

```bash
sw_vers                 # macOS version
node --version          # Node.js (want v18.17+ or any v20 LTS)
npm --version           # npm (comes with Node)
git --version           # git
whoami                  # her Mac username — note this down
```

**Verify:** You want to see a `node` version of **v18.17 or higher** (v20.x LTS
is ideal). `git` is preinstalled on modern macOS.

**If it fails:**
- `node: command not found` → Node isn't installed. Continue to **Phase B**.
- `git: command not found` → macOS will pop up a dialog offering to install the
  Command Line Developer Tools. Click **Install**, wait for it to finish, then
  re-run `git --version`.
- Node version is **older than v18.17** → treat it as "needs install" and do
  **Phase B** (the nodejs.org installer upgrades in place).

---

## Phase B — Install Node.js (only if Phase A showed it's missing/old)

**What you're doing:** installing Node.js using the standard installer from
nodejs.org. Skip this phase entirely if Phase A already showed v18.17+.

1. On the Mac, open a browser and go to **https://nodejs.org**.
2. Download the **LTS** version (the big green button — currently the 20.x
   line). It downloads a file ending in `.pkg`.
3. Open the downloaded `.pkg` and click through the installer (Continue →
   Agree → Install). It will ask for **Melissa's Mac password** — that's
   expected for the installer only.

**Verify:** open a **new** Terminal window (important — the old one won't see
the new install) and run:

```bash
node --version
npm --version
```

Both should print version numbers.

**If it fails:**
- Still `command not found` in a new window → confirm the `.pkg` actually
  finished. The installer puts Node in `/usr/local/bin`; check with
  `ls -l /usr/local/bin/node`. If it's there but not found, the PATH is the
  issue — open a brand-new Terminal window and try again.
- Apple Silicon note: the nodejs.org `.pkg` installs to `/usr/local/bin`, which
  is already in the plist's PATH, so you're covered either way.

---

## Phase C — Clone the repo and install dependencies

**What you're doing:** downloading the tool into `~/Documents/bloodwork-tool`
and installing its packages.

```bash
cd ~/Documents
git clone https://github.com/clipppy/bloodwork-tool.git
cd ~/Documents/bloodwork-tool
npm install
```

**Verify:**

```bash
ls ~/Documents/bloodwork-tool/package.json   # should print the path, no error
ls ~/Documents/bloodwork-tool/node_modules   # should list many folders
```

**If it fails:**
- `git clone` asks for a username/password or says **repository not found** →
  the repo is private. Sign in to the Mac's browser with the GitHub account
  that has access, or generate a Personal Access Token and use it as the
  password when prompted. (You can also clone on your own laptop and copy the
  folder over, but `npm install` still has to run on her Mac.)
- `npm install` errors about Node version → Node is too old; go back to
  **Phase B** and install the LTS, then re-run `npm install`.
- `npm install` hangs or fails on network → check Wi-Fi, then re-run
  `npm install` (it resumes safely).

---

## Phase D — First test run (prove it works before automating)

**What you're doing:** starting the UI by hand once, to confirm the app loads
before we hand it to launchd.

```bash
cd ~/Documents/bloodwork-tool
npm run ui
```

Wait for a line like `✓ Ready` / `Local: http://localhost:3000`. Then, on the
Mac, open a browser to:

```
http://localhost:3000
```

**Verify:** the bloodwork tool's web page loads in the browser.

**Stop the test** when you're satisfied: go back to Terminal and press
**Ctrl + C**. (We only ran it by hand to confirm — launchd will run it for real
in Phase E.)

**If it fails:**
- Browser says "can't connect" → look at the Terminal output. If you see
  `EADDRINUSE` / port 3000 in use, something else is already on that port; find
  and quit it with `lsof -i :3000` then `kill <PID>`, and re-run `npm run ui`.
- Terminal shows a build/compile error → screenshot it. Confirm `npm install`
  finished cleanly in Phase C; re-run `npm install`, then `npm run ui`.

---

## Phase E — Install the launchd service (auto-start on login)

**What you're doing:** installing a LaunchAgent so macOS starts the UI
automatically every time Melissa logs in — no Terminal needed.

1. Make sure the LaunchAgents folder exists:

   ```bash
   mkdir -p ~/Library/LaunchAgents
   ```

2. Copy the plist out of the repo into that folder:

   ```bash
   cp ~/Documents/bloodwork-tool/scripts/install/com.bloodwork-tool.ui.plist \
      ~/Library/LaunchAgents/com.bloodwork-tool.ui.plist
   ```

3. Replace the `USERNAME` placeholder with her **actual** Mac username,
   automatically (no manual editing — `$(whoami)` fills it in):

   ```bash
   sed -i '' "s|USERNAME|$(whoami)|g" ~/Library/LaunchAgents/com.bloodwork-tool.ui.plist
   ```

   **Verify the replacement worked** — this should show her real home path
   twice, with **no** `USERNAME` left:

   ```bash
   grep -n "/Users/" ~/Library/LaunchAgents/com.bloodwork-tool.ui.plist
   grep -c "USERNAME"  ~/Library/LaunchAgents/com.bloodwork-tool.ui.plist   # must print 0
   ```

4. Load the service with the modern `launchctl bootstrap` command (targets the
   GUI session for her user ID):

   ```bash
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.bloodwork-tool.ui.plist
   ```

**Verify:** the service is registered and the page loads on its own.

```bash
launchctl list | grep bloodwork      # should show a line for com.bloodwork-tool.ui
```

Give it ~10 seconds to boot, then open `http://localhost:3000` in the browser —
it should load **without** you having run `npm run ui` yourself.

**If it fails:**
- `grep -c "USERNAME"` printed something other than `0` → the `sed` didn't run;
  re-run step 3 exactly.
- `launchctl bootstrap` says **"Bootstrap failed: 5: Input/output error"** or
  **"service already bootstrapped"** → it's already loaded. Unload it first,
  then load again:
  ```bash
  launchctl bootout gui/$(id -u)/com.bloodwork-tool.ui
  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.bloodwork-tool.ui.plist
  ```
- `launchctl list | grep bloodwork` shows a **non-zero number** in the second
  column (the exit code) → it crashed on launch. Check the logs:
  ```bash
  tail -n 40 /tmp/bloodwork-tool.error.log
  ```
  Most common cause is a wrong path (USERNAME not replaced) or Node not on the
  PATH — re-check step 3 and that `node --version` works.

---

## Phase F — Verify auto-start actually survives a login

**What you're doing:** proving the service comes back on its own, the way it
will every morning when Melissa logs in.

**Option 1 — without logging out (fast, do this first):** force launchd to
restart the service from scratch, exactly as a fresh login would:

```bash
launchctl kickstart -k gui/$(id -u)/com.bloodwork-tool.ui
```

Wait ~10 seconds, then reload `http://localhost:3000` in the browser.

**Option 2 — the real thing (do this once to be sure):** log out of her macOS
account (Apple menu → Log Out), log back in, wait ~15 seconds, and open
`http://localhost:3000`. Do **not** open Terminal — that's the whole point.

**Verify:** the page loads in the browser after the kickstart/login, with no
manual Terminal step.

**If it fails:**
- Page doesn't load after kickstart → `launchctl list | grep bloodwork` and
  check the exit code; then `tail -n 40 /tmp/bloodwork-tool.error.log`. See the
  Troubleshooting section below.

---

## Phase G — Bookmark localhost:3000 in her browser

**What you're doing:** making the tool one click away for Melissa.

1. In **her** default browser (the one she actually uses — Safari or Chrome),
   go to `http://localhost:3000`.
2. Bookmark it:
   - **Safari:** Bookmarks → Add Bookmark → save to **Favorites**, name it
     **"Bloodwork Tool"**.
   - **Chrome:** click the ☆ star in the address bar → name it
     **"Bloodwork Tool"** → save to the **Bookmarks Bar**.
3. Make sure the Bookmarks/Favorites bar is visible so she can see it:
   - Safari: View → Show Favorites Bar.
   - Chrome: View → Always Show Bookmarks Bar.

**Verify:** close the tab, click the **Bloodwork Tool** bookmark, and confirm it
opens the tool.

---

## Phase H — Walk Melissa through her first generation

**What you're doing:** doing one real report together so she's confident using
it solo.

1. Have her click the **Bloodwork Tool** bookmark.
2. Walk her through the UI: upload a sample lab PDF, fill in the patient name
   and date, and generate the Word report.
3. Open the generated `.docx` and confirm it looks right — spot-check that the
   header reads **CARBONE CHIROPRACTIC CENTER, LLC** and that flagged values
   look correct.
4. Tell her the one rule she needs to remember: **"If the page ever won't load,
   restart the Mac and wait a minute — it starts itself."** She never needs
   Terminal.

**Verify:** Melissa generates a report end-to-end **herself**, while you watch.

---

# Troubleshooting

Run these in Terminal, as Melissa's user (no `sudo`).

**Is the server running?**
```bash
launchctl list | grep bloodwork
```
A line with `com.bloodwork-tool.ui` means it's loaded. The **second column** is
the last exit code: `0` is healthy; any other number means it crashed — check
the logs below.

**View the live logs** (Ctrl + C to stop watching):
```bash
tail -f /tmp/bloodwork-tool.log          # normal output
tail -f /tmp/bloodwork-tool.error.log    # errors
```

**Unload the service** (stop it completely):
```bash
launchctl bootout gui/$(id -u)/com.bloodwork-tool.ui
```

**Reload after a change** (e.g. you edited the plist, or pulled new code) —
always bootout first, then bootstrap:
```bash
launchctl bootout gui/$(id -u)/com.bloodwork-tool.ui
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.bloodwork-tool.ui.plist
```

**Force a restart without logging out** (quick health test):
```bash
launchctl kickstart -k gui/$(id -u)/com.bloodwork-tool.ui
```

**Update the tool to the latest code later:**
```bash
cd ~/Documents/bloodwork-tool
git pull
npm install
launchctl kickstart -k gui/$(id -u)/com.bloodwork-tool.ui
```

**Common causes when it won't start:**
- `USERNAME` was never replaced in the plist → `grep -c USERNAME
  ~/Library/LaunchAgents/com.bloodwork-tool.ui.plist` should be `0`. If not,
  re-run the `sed` from Phase E step 3, then bootout + bootstrap.
- Node not found by the service → the plist PATH covers `/usr/local/bin` and
  `/opt/homebrew/bin`; confirm `node --version` works in a normal Terminal. If
  Node lives somewhere else, that's the problem.
- Port 3000 already taken → `lsof -i :3000`, then `kill <PID>`, then kickstart.
- Repo folder isn't at `~/Documents/bloodwork-tool` → the plist paths are
  hard-coded to that location; the repo must live exactly there.
