# Install

Startup Tracker runs on your computer and keeps its data there. It needs [Node.js](https://nodejs.org/) 22.16 or newer, on macOS, Linux (WSL included) or Windows 10 and later.

## One line

macOS, Linux and WSL:

```bash
curl -fsSL https://liviux.github.io/Start-up-tracker/install.sh | bash
```

Windows PowerShell:

```powershell
irm https://liviux.github.io/Start-up-tracker/install.ps1 | iex
```

The script:

1. checks that Node.js 22.16 or newer is installed. If it is not, it prints how to install it (Homebrew, nvm, fnm or winget) and stops; it never installs system software for you
2. downloads the latest release archive and its `SHA256SUMS` from GitHub Releases and checks the archive's hash
3. unpacks it to `~/.startup-tracker/app` (`%USERPROFILE%\.startup-tracker\app` on Windows). The tracker needs nothing besides Node.js, so nothing is fetched from npm
4. adds the `startup-tracker` command: `~/.local/bin/startup-tracker`, or `%USERPROFILE%\.startup-tracker\bin\startup-tracker.cmd` on your user PATH on Windows
5. asks whether to start the tracker when you log in (see [Autostart](cli.md#autostart))
6. starts the tracker and opens it in your browser, where the [setup](setup.md) takes over

The same scripts are at `https://raw.githubusercontent.com/liviux/Start-up-tracker/main/install.sh` and `.../install.ps1`.

### Reading the script first

Piping a script into a shell runs whatever the server sends. To look at it first, download it, read it, then run the file:

```bash
curl -fsSLO https://liviux.github.io/Start-up-tracker/install.sh
less install.sh
bash install.sh
```

```powershell
irm https://liviux.github.io/Start-up-tracker/install.ps1 -OutFile install.ps1
notepad install.ps1
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

### Options

| install.sh | install.ps1 | What it does |
|---|---|---|
| `--version 0.1.0` | `-Version 0.1.0` | Installs that release instead of the latest |
| `--archive <file>` | `-Archive <file>` | Installs from a release archive on disk; its `SHA256SUMS` must sit next to it |
| `--dir <folder>` | `-Dir <folder>` | Installs to and keeps data in another folder |
| `--autostart` / `--no-autostart` | `-Autostart` / `-NoAutostart` | Answers the autostart question without asking |
| `--no-start` | `-NoStart` | Does not start the tracker at the end |

With `curl | bash`, pass options after `bash -s --`, for example `curl -fsSL .../install.sh | bash -s -- --version 0.1.0`. With `irm | iex` there are no parameters; set `$env:STARTUP_TRACKER_VERSION`, `$env:STARTUP_TRACKER_AUTOSTART` (`yes` or `no`) or `$env:STARTUP_TRACKER_NO_START` first.

## From the source

```bash
git clone https://github.com/liviux/Start-up-tracker.git
cd Start-up-tracker
npm ci
npm start
```

`npm start` runs the server in the terminal on port 57322 with the data in `~/.startup-tracker`. `./start.sh` (or `start.bat` on Windows) starts it in the background and opens the browser, the same as the `startup-tracker` command; `node bin/startup-tracker.js <command>` runs any of the [commands](cli.md) from the folder. A clone is updated with `git pull` and `npm ci`, not with `startup-tracker update`.

## Where things are

| | macOS and Linux | Windows |
|---|---|---|
| The app | `~/.startup-tracker/app` (the version before the last update in `app.prev`) | `%USERPROFILE%\.startup-tracker\app` |
| Your data | `~/.startup-tracker/data`, `media`, `backups` and the rest of that folder | `%USERPROFILE%\.startup-tracker\...` |
| The command | `~/.local/bin/startup-tracker` | `%USERPROFILE%\.startup-tracker\bin\startup-tracker.cmd` |
| The log | `~/.startup-tracker/logs/server.log` | `%USERPROFILE%\.startup-tracker\logs\server.log` |

The tracker listens only on `127.0.0.1`, on port 57322. The port is saved in `config.json` at the first start and used every time after, because the browser keeps edits it has not sent yet per address, and the port is part of the address. If something else holds the port, `startup-tracker` says so and offers to save a different one.

## Update

```bash
startup-tracker update
```

It looks up the latest release, checks the archive against `SHA256SUMS`, takes a safety backup of the database, swaps the new version in, restarts the tracker if it was running and shows what changed. If the new version does not start, the old one comes back. `startup-tracker update --rollback` returns to the previous version later. Your data is not changed by the update itself; a new version that needs a newer database layout upgrades it when it opens it, after a backup of its own.

`startup-tracker update --check` only looks. **Settings > About** shows whether a newer version exists and has **Check for updates now**. The tracker checks by itself once a day only while the network switch in **Settings > General** is on.

## Uninstall

```bash
startup-tracker uninstall
```

This stops the tracker, turns autostart off and removes the app and the `startup-tracker` command. Your data stays in `~/.startup-tracker`. To remove the data too, run `startup-tracker uninstall --purge-data` and type `DELETE` when asked; anything else keeps it.

## If something does not work

`startup-tracker doctor` checks Node.js, the port, the permissions of the data folder, the database and the AI agents found on this computer, and says what to do about each problem. It changes nothing. `startup-tracker logs` prints the end of the server log.
