# AI agents

You can run a prompt from the Prompts page with an AI coding agent installed on your computer, such as Claude Code, Codex, Gemini CLI or OpenCode, and watch it work. The agent saves what it finds straight into the tracker, and each run can be undone.

The tracker talks to agents over the [Agent Client Protocol](https://agentclientprotocol.com) (ACP), version 1. It starts the agent as a program on your computer and exchanges messages with it; there is no cloud service in between. What the agent itself sends to its model provider is between you and that provider.

![An agent run on the Agents page: the conversation and plan on the right, the run list on the left, and the target it saved](assets/screenshot-agents.png)

*An agent run in the demo startup. The conversation, plan and tool calls are saved with the run; the target it created is already in the tracker.*

## Before you start

Agents can read and change files and run commands on this computer with your user account's rights. The tracker gives an agent no file or terminal access of its own, and it runs the agent in a working folder inside the data folder, but that folder is not a sandbox: the agent's own tools can reach anything your account can. Pick the permission policy (below) with that in mind; [AI agents and safety](agent-safety.md) explains the risks and the choices.

## Setting up an agent

Open **Settings > AI agents**.

**Add an agent** lists the agents in the official ACP registry, plus a few adapters from `content/acp-local.json` that are not in it. The tracker fetches the registry at most once a day and keeps a copy in the data folder's `cache/` folder. With **Network** off in Settings > General it uses the copy that ships with the app instead, and if that cannot be read either, a built-in list of well-known agents. **Rescan now** fetches the registry again and looks for installed agents.

Each agent shows how it is installed:

- **npx**: an npm package. The first start downloads it, which can take a few minutes. Before that first download the tracker names the package and version and asks you.
- **uvx**: a Python package, run with [uv](https://docs.astral.sh/uv/). Install uv first.
- **binary**: a program you install yourself. The list links to the download; the program must be on your `PATH`.

"found on this computer" means its program is already on your `PATH`. An npm agent found that way runs from there, without a download.

The check also looks for the native program an adapter needs, not only the adapter itself. Codex, Claude Code, Grok, Antigravity (`agy`), Command Code and OpenCode are found this way. A found native program marks the agent as available; the tracker then uses the adapter only when it does not find the agent's own command. Codex and Claude use their npm adapters, Antigravity uses the `agy-acp` adapter, and Grok and Command Code run their installed command with their ACP mode.

Agents with no ACP mode of their own carry a blue **ADAPTER** badge, in the list and on their card. Claude Code, Codex and Antigravity are the common ones. The adapter is a separate program, usually downloaded with `npx` on first use, that speaks ACP for the agent and starts its own program, so that program still has to be installed and logged in. An agent counts as an adapter when it needs a native program other than its own, or when its registry entry calls it an ACP adapter or wrapper.

**Add** shows the exact command the tracker will run and asks you to confirm it. The first time, the same dialog repeats the warning above. To use an agent that is not in the registry, add **a custom command**: any program that speaks ACP on its standard input and output. It runs exactly as you type it, with no shell.

### Check

**Check** starts the agent, says hello over ACP, opens a session in an empty temporary folder to read its models, then stops it. It ends in one of these states:

- **Ready**: the agent answered. Its name, version and models show.
- **Needs login**: the agent wants you to log in first. For a login that happens in a terminal, the exact command shows; run it, then check again. For a login the agent handles itself, select **Log in**.
- **Incompatible**: the agent does not speak ACP version 1.
- **Not installed**: the program cannot be found or started.
- **Last check failed**: anything else. The message says what went wrong.

**Test prompt** also asks the agent to reply "OK", which costs a few tokens.

An agent whose last check failed cannot run until it passes, or until you select **Allow it anyway**.

### Options

Under **Permissions, models and launch settings**:

- **Permission policy**, per agent:
  - **Allow everything** (the default): every permission request is approved at once.
  - **Research only**: reading, searching, fetching, thinking and the tracker tools are allowed; editing, deleting, moving files and running commands are refused.
  - **Ask me**: each request waits for your answer, and the run shows "Waiting for you".
- **Default model** and **Preferred models**. The list is filled in after **Check** reads it from the agent; until then you can type a model id if you know it. Type part of a name or id to search, and pick one. Preferred models are listed first when you start a run. **Test prompt** runs with the default model, so pick one first.
- **Effort**, per model, next to the default model and in each preferred model's chip. **Check** reads the levels each of those models offers, so after you pick a new model, check again to see its levels. A model that offers none shows no effort box. Most agents take the effort over ACP. Cline takes it only as `--thinking` when it starts, which the tracker adds for you. The run dialog starts from the effort picked here and lets you change it for one run.
- **OpenRouter routing**, for OpenCode only, next to an `openrouter/` model: **Nitro** sends the request to the fastest providers, **Floor** to the cheapest, **Exacto** to the ones best at tool calls. The variant becomes part of the model id (`openrouter/vendor/model:nitro`). OpenCode accepts only model ids it knows, so the tracker registers the variants you picked in `OPENCODE_CONFIG_CONTENT` when it starts OpenCode. Your own OpenCode config is not changed.
- **Arguments** and, for a custom agent, **Command**. A changed custom command is confirmed again.
- **Environment variables**, one `NAME=value` per line, for API keys and the like. The values are kept in `secrets/agent-env.json` in the data folder, readable only by your account, and show as `***`; leave `***` to keep a value.

An agent gets a clean environment: `PATH`, your home and temp folders, the locale, proxy settings and the variables you set. It never gets the tracker's own variables or tokens.

**Runs** sets how many runs go at the same time (2), when a run is stopped (after 60 minutes), how many finished runs are kept (100) and when a quiet run is flagged as idle (after 10 minutes).

**Agent tokens** lists the limited tokens of copied prompts and of runs, and revokes them.

## Running a prompt

On the Prompts page, set up the prompt as usual, then select **Run with…**. The dialog shows:

- the startup, the agent and the model;
- your **Constraints** text, highlighted; when it is empty you get a warning, since the agent then has no limits from you;
- the prompt exactly as it will be sent.

Unfilled variables, or an example text still reading "[write it here before running]", block the run. Nothing else goes with the prompt: no Company documents, no files and no sensitive Company values.

**Start** begins the run and opens it on top of the Prompts page. When the limit of runs at the same time is reached, a run waits as **Queued**.

What happens:

1. The tracker makes a folder for the run, `agent-runs/<startup>/<run>/` in the data folder, with an `AGENTS.md` of rules: use the tracker tools, never delete, check for duplicates, cite sources.
2. It starts the agent with that folder's `work/` as the working folder, and gives it the tracker tools (below) as an MCP server.
3. It sets the model and sends the prompt. Updates show as they arrive.
4. Permission requests are answered by the agent's policy. A refusal picks the agent's own "reject" option.
5. When the agent stops, the run shows its stop reason and the list of what it changed. The changes are already saved.

If the agent saved nothing through the tools but its last message holds targets as a JSON block, the run offers **Import AI results** with that text.

## Watching runs

The **Agents** page in the sidebar lists the runs of this startup (tick **All startups** to see every run). Its badge counts the runs going; it turns amber when one waits for you. Select a run to open it. **Open in its own window** shows one run at `/s/<startup>/agents/<run>`.

A run has five tabs:

- **Conversation**: the messages, the agent's thinking (folded), its tool calls with their kind and status, the plan, and permission requests with buttons when they wait for you.
- **Prompt**: the exact text sent, with the agent, command, model and policy used.
- **Changes**: the targets the run created or updated, and links it made.
- **Permissions**: each request and the answer given, by the policy or by you.
- **Log**: the raw protocol messages and the agent's error output. Configured variable values and tokens are replaced by `***` before anything is stored. **Download the log** saves it.

Controls:

- **Cancel** asks the agent to stop. If it has not stopped after 10 seconds, the tracker ends it and every program it started.
- **Send a follow-up message** sends another prompt in the same session. The agent stays available for 10 minutes after it finishes.
- **Run again** starts a new run with the same prompt, agent and model.
- **Stop all agents** on the Agents page cancels every run.

A run with no update for the idle time shows a notice; you decide whether to cancel it. If the tracker stops while runs are going, they show as **Interrupted** afterwards.

## Undo

**Undo this run** in the Changes tab takes the run's changes back: targets it created go to the recycle bin, links it made are removed, and targets it updated get their earlier version. A target someone changed after the run is left as it is and listed. The history of each target says which run changed it: the origin is `agent` and the actor names the agent and model.

## The tracker tools

The agent reaches the tracker through an MCP server the tracker starts for each run (`bin/tracker-mcp.js`). Its token works only for this run's startup and only while the run lasts. The tools:

| Tool | What it does |
|---|---|
| `get_startup_context` | The startup's profile and its legal form. Sensitive Company values are never included. |
| `get_taxonomy` | The categories turned on for this startup, with descriptions. |
| `list_tags`, `list_campaigns` | The shared tags and campaigns. |
| `search_targets` | Targets by text or web address, in one section or all, including the recycle bin. For duplicate checks. |
| `get_target` | One target with its revision. |
| `create_target` | A new target, checked against the section's fields like "Import AI results". Takes several categories. Refuses a target with the same link or name as one you track. |
| `update_target` | Changes fields and categories of a target. Needs the revision from `get_target`; if the target changed meanwhile, it answers with a conflict. |
| `append_note` | Adds a dated paragraph to a target's notes. |
| `link_records` | Links two records. |
| `get_calendar_load` | How many dated items each day has, so the agent can respect your daily limit. |

There is no tool to delete. Each write carries a mutation id, so a call the agent repeats after a lost answer is saved once.

The MCP server speaks the stateless MCP revision 2026-07-28 and the handshake revisions 2025-11-25 and 2025-06-18.
