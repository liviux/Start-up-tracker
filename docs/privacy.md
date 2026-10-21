# Privacy

Startup Tracker runs on your computer. There is no account, no server of ours and no analytics. The tracker listens only on `127.0.0.1`, so other computers cannot reach it, and everything you enter stays in the data folder (`~/.startup-tracker`).

## What leaves your computer

The tracker itself goes online for two things only:

| What | When | What is sent |
|---|---|---|
| The [ACP agent registry](agents.md#setting-up-an-agent) | At most once a day, when you open Settings > AI agents | A plain request for the public registry file at `cdn.agentclientprotocol.com`. Nothing about you or your data. |
| The update check | At most once a day, when you open Settings > About or run `startup-tracker` | A plain request to GitHub's API for the latest release of this project. Nothing about you or your data. |

Both follow one switch, **Fetch the agent registry and check for updates** in **Settings > General**. With it off, the tracker does not go online on its own: it uses the registry copy that ships with the app and reports the last update check it has. **Rescan now** (Settings > AI agents) and **Check for updates now** (Settings > About) still work when you click them, because then you asked.

The page's scripts, styles, fonts and icons all come from the tracker, and its content security policy blocks scripts and styles from anywhere else. Images are the exception, in two places: the agent icons in Settings > AI agents load from the registry's servers (only while the switch above is on), and an image you put in a Markdown note by its web address loads from that address. Links you add to targets open only when you click them.

## AI agents

When you run a prompt with an [AI agent](agents.md), the agent is a program on your computer, but it sends the prompt and whatever it reads to its model provider (Anthropic, OpenAI, Google and so on). What it sends, and what that provider keeps, is between you and the provider; read their terms. The prompt holds the startup details the template asks for, such as your profile and the "Company and founders" text. Sensitive Company values (ID numbers, bank accounts) are never put in a prompt or given to an agent's tools.

Setting up an agent that installs through npm or uv downloads its package from that registry the first time it runs; the tracker names the package and asks you before.

Copying a prompt to paste into a chat app sends nothing by itself: you choose where to paste it.

## Your data folder

The data folder is readable only by your user account (folders `0700`, the API token `0600` on macOS and Linux). Backups and exports stay in it until you move them. An export leaves sensitive Company values out unless you tick them. `startup-tracker doctor` warns when the folder's permissions let other users read it.
