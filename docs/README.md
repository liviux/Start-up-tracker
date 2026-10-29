# Startup Tracker

Startup Tracker keeps track of a startup's marketing (MK), programs and opportunities (PO), funding (FU) and company tasks (COMP), for one startup or several side by side. It is a small web app that runs on your own computer: a Node.js server and a page you open in your browser.

- **Targets** in each section with statuses, categories, dates, notes, links between records and a full history.
- A **calendar** and a daily **focus queue** across all sections.
- **Company** templates for the major legal forms in 199 countries and territories, plus a generic one, with setup steps and recurring obligations from official sources.
- **Prompts** filled with your startup's details, and **AI agents** on your computer (Claude Code, Codex, Gemini CLI and others) that save what they find straight into the tracker, with undo.
- Automatic **backups**, a recycle bin, and export and import.

![The Marketing page of the fictional demo startup: counts per status group and the focus queue with the next targets](assets/screenshot-marketing.png)

*The Marketing page of the demo startup, "Northwind Robotics".*

| | |
|---|---|
| ![The calendar with dated work across every section](assets/screenshot-calendar.png) | ![The company setup steps with their official sources](assets/screenshot-company.png) |
| ![A prompt filled with the startup's profile, ready to copy or run](assets/screenshot-prompts.png) | ![An agent run and the target it saved](assets/screenshot-agents.png) |

## Your data stays on your computer

The server listens on 127.0.0.1, so only your computer can reach it. Everything you enter goes into one SQLite database in a data folder in your home directory, next to your uploads and backups. The code folder never holds data, so updating or removing the app leaves your data alone. [Privacy](privacy.md) lists the two things the tracker fetches from the internet and the switch that turns them off.

## Getting started

You need Node.js 22.16 or newer on macOS, Linux or Windows. [Install](install.md) has the one-line installer and the manual steps; [The setup](setup.md) walks through the first start. [Concepts](concepts.md) explains the words the tracker uses, and [FAQ and troubleshooting](faq.md) answers the usual questions.
