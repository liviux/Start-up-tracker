# AI agents and safety

An AI agent run from the tracker is a program on your computer with your user account's rights. It can read and change files and run commands, as far as its own tools and the permission policy let it. The tracker adds tools to save targets, but it does not add a sandbox. This page explains what that means and how to choose a policy. The setup itself is in [AI agents](agents.md).

## What "Allow everything" means

**Allow everything**, the default policy, approves every permission request the agent makes at once. Research prompts ask the agent to read web pages, and a web page can contain text written to steer an agent ("ignore your instructions and..."). This is called prompt injection. An agent that follows such text could:

- change or delete files your account can reach, not only those in the run's working folder
- run commands, including ones that download and start other programs
- send what it can read, such as files, keys in your shell profile or browser data your account can open, to somewhere else

Agents and their model providers try to resist this, but no one can promise they always do.

## Choosing a policy

| Policy | What the agent may do | Use it when |
|---|---|---|
| **Allow everything** | Everything it asks | You trust the prompt and the pages it will read, and you keep nothing on this account you could not lose |
| **Research only** | Read, search, fetch web pages, think and use the tracker tools; editing, deleting, moving files and running commands are refused | Most research prompts. The agent can still find and save targets |
| **Ask me** | Each request waits for your answer in the run | You want to see every step, or you are trying an agent for the first time |

The policy is set per agent in **Settings > AI agents**, under **Permissions, models and launch settings**.

## When to go further

For prompts that read many unknown pages, or for agents you do not know well, run the tracker under a separate user account on your computer, or in a virtual machine, with nothing else of value in it. The agent then reaches only that account's files.

## What the tracker does on its side

- Each run gets its own token, valid only for that startup and only while the run lasts. The agent never sees the tracker's main token.
- The tracker tools cannot delete anything, and every change an agent makes is in the history with the run's name. **Undo this run** takes the run's changes back. See [Undo](agents.md#undo).
- Sensitive Company values are never given to agents.
- The agent gets a clean environment: your `PATH`, home and temp folders, locale and proxy settings, plus the variables you set for it, and never the tracker's own variables.
- Runs stop after 60 minutes by default, and you can cancel any run.
