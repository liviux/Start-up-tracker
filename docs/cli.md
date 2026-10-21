# Command line

The installer adds the `startup-tracker` command. In a git clone, run the same commands as `node bin/startup-tracker.js <command>`.

```text
startup-tracker [command] [options]
```

With no command, it starts the tracker if it is not running and opens it in your browser. When no browser can be opened, for example over SSH, it prints the address instead. Once a day, while the network switch in **Settings > General** is on, it also says when a newer version is out.

## Commands

| Command | What it does |
|---|---|
| `start` | Starts the tracker in the background and opens it, unless `--no-open`. Output goes to `logs/server.log`. |
| `stop` | Stops the tracker cleanly. `--force` ends it if it does not stop within 15 seconds. |
| `status` | Says whether the tracker runs, at which address and for which data folder. `--json` for scripts. Exits with 0 when it runs, 3 when it does not. |
| `open` | Opens the running tracker in the browser. |
| `logs` | Prints the last 50 lines of the server log. `-n <lines>` for more or fewer, `-f` to keep following it. |
| `backup` | Takes a backup of the whole database and its media. `--label <what>` pins it, so it never rotates away. |
| `restore` | `--list` lists the backups. `--snapshot <backup> --startup <id>` restores one startup, `--snapshot <backup> --record <startupId>/<section>/<id>` one record; `--snapshot <backup>` alone restores everything and needs the tracker stopped. See [Backups](backups.md). |
| `update` | Installs the latest release after a safety backup and restarts the tracker. `--check` only looks; `--rollback` goes back to the version before. See [Install](install.md#update). |
| `autostart on`, `off`, `status` | Starts the tracker when you log in, or stops doing so. |
| `doctor` | Checks Node.js, the port, folder permissions, the database and the AI agents found. Changes nothing. |
| `uninstall` | Removes the app and the command; the data stays. `--purge-data` also deletes the data folder after you type `DELETE`. `--yes` skips the first question, for scripts. |
| `version` | Prints the version. |
| `help` | Lists the commands. |

## Options

For `start` and no command:

- `--port <n>` starts on another port this once. Add `--save-port` to keep it for every start.
- `--no-open` does not open the browser.
- `--foreground` keeps the server in this terminal until Ctrl+C. Autostart uses it on macOS and Linux.

For every command:

- `--data-dir <folder>` picks the data folder. Without it, `STARTUP_TRACKER_HOME` does, and then the default `~/.startup-tracker`.
- `--dev` uses `~/.startup-tracker-dev` and port 57323 instead, for development.

## The port

The first start saves port 57322 in `config.json` in the data folder, and every later start uses it. The browser keeps edits it has not sent yet per address, and the port is part of the address, so moving it would leave those edits behind. If another program holds the port, `startup-tracker` says so. On a terminal it offers the next free port and saves it if you answer yes; in a script it prints the `--port <n> --save-port` command to run. The server never moves to another port by itself.

## Autostart

`startup-tracker autostart on` sets up:

- Linux: a systemd user unit, `~/.config/systemd/user/startup-tracker.service`. On WSL this needs systemd turned on (`[boot]` and `systemd=true` in `/etc/wsl.conf`); without it, the command says so.
- macOS: a LaunchAgent, `~/Library/LaunchAgents/startup-tracker.plist`.
- Windows: a Task Scheduler task named "Startup Tracker" that runs at logon.

Each one runs the tracker with the Node.js that ran `autostart on`. If you install a different Node.js later, run `startup-tracker autostart on` again.

## Exit codes

0 success, 1 a failure (the message says what happened), 2 a mistake in the command line, 3 from `status` when the tracker is not running.
