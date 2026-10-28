# Settings

Open **Settings** at the top of the page. Sections that apply only to the startup you have open show its name next to the title; the others are shared by every startup.

## Startup profile

This startup only. Name, one-liner, description, industry, icon, website and links, country, entity type, default currency, home city or region, "Company and founders, for AI prompts" and the number of new targets a day the prompts aim for (10 by default).

The icon can be a PNG, SVG, JPG or ICO file. It is resized to 256 px in the browser and also used as the browser tab icon. Without one, the startup's initials are shown.

"Company and founders, for AI prompts" is the text every prompt gets as `{{CONSTRAINTS}}`: who works on the product, the legal entity, the founders, what you may apply for and what to avoid. About 1,000 characters works well; the counter warns under 400 and over 2,500. Below the box, each topic adds a sentence to start from where the cursor is. The text is sent to the AI agents you run, so write only what you are comfortable sharing. See [Prompts](prompts.md).

The entity type is filled in when you pick a template in the [Company](company.md) tab; you can also type it. The default currency is the one the Company tab's budget and expenses use.

## Startups

Every startup with its icon, creation date, number of records and media size. Add one with the [setup](setup.md) or with the quick form, rename, copy settings from another startup, archive (hidden from the switcher until you unarchive it) and delete (you type the name to confirm). See [startups.md](startups.md).

## Appearance

Shared. Light, dark or follow the system, and one of eleven themes. Each card shows a screenshot of the Calendar in that theme; the theme changes the layout and type as well as the colours, and light or dark still applies on top. The choice is also kept in the browser so the page opens in it without a flash.

The default is **Studio**. The other ten were built with five design skills, two themes each:

| Skill | Themes |
| --- | --- |
| ui-ux-pro-max | Ledger, Night Shift |
| taste-skill | Field Notes, Meridian |
| impeccable | Lacquer, Shinjuku |
| emilkowalski/skills | Quiet, Tactile |
| hallmark | Broadsheet, Signal |

An older saved theme id opens the new theme that carries its idea, so nobody drops back to Studio after an update.

**Section colours**: Marketing, Programs, Funding and Company each have a colour, used for the sidebar dots, the stripe above each section's title, chips, search results and the calendar's counts. Pick the standard palette or the colour-blind friendly one (Okabe and Ito's hues), or set your own colour per section. For each colour the tracker works out a soft tint and a text shade that reads at 4.5:1 or better on it, in light and dark mode. A colour you pick that would read worse than that as text gets a note, and the tracker uses a darker or lighter shade for its text. **Reset colours** goes back to the standard palette. The section code (MK, PO, FU, COMP) always shows next to the colour.

## General

Shared.

- **App name**: shown in the sidebar, the footer and the browser title (`<startup> · <app name>`).
- **Language**: English for now.
- **Time zone**: the zone dates and times are shown in. "Browser time zone" follows the computer.
- **Date format**: the system's, `15 Oct 2026` or `2026-10-15`.
- **Week starts on**: Monday or Sunday, for the calendar.
- **Page size**: rows per page in lists.
- **Your name**: the name record history shows for your edits. Empty shows "You".
- **Network**: whether the tracker may fetch the AI agent registry and check for updates. Nothing else goes out.
- **Search and calendar show**: this startup or all startups by default.

## Statuses

Shared. The status list for targets in every section and every startup, the campaign statuses and the priorities. See [statuses.md](statuses.md).

## AI agents

The agents you can run prompts with, their permission policy, models and environment variables, the limits for runs and the agent tokens. See [AI agents](agents.md).

## Backups

Automatic backups can be turned off here, the hours between them changed (six by default), and the number of automatic and safety backups to keep changed. See [backups.md](backups.md).

## Recycle bin

This startup's deleted records, grouped by type, plus deleted prompts, tags and campaigns, which every startup shares. Restore a record, delete it for good, or empty the bin. Records are deleted for good after 30 days; you can choose 7 to 365 days, or keep them until you empty the bin yourself. The clean-up runs when the server starts and once a day.

## About

The version, the data folder, the database file, the port, the database's schema version and size, and the result of the last integrity check, with **Verify now**. `node tools/about.js` prints the same facts in a terminal without changing anything. **Updates** shows whether a newer version exists (checked once a day while the network switch is on) and has **Check for updates now**; installing it is `startup-tracker update` in a terminal ([Install](install.md#update)). **Run setup again** opens the [setup](setup.md) from the start for the startup you have open.
