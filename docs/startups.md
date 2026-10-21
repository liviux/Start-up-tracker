# Startups

One tracker can hold several startups. Each one has its own targets, media, history and recycle bin. Settings that describe how you like to work, such as appearance, statuses and prompts, are shared by all of them.

## Switching

The startup switcher sits at the top of the sidebar. Pick another startup to open it. The page reloads, so edits you have not synced yet stay with the startup they belong to and can never be sent to another one.

A startup in the menu shows a marker when this browser still holds edits for it that have not reached the server (↑), or edits waiting for you to resolve a conflict (!), with a short description such as "1 unsynced edit". Open that startup to let them sync.

Each startup has its own address, `/s/<startup id>/`, so you can bookmark one. The plain address of the tracker opens the startup you used last.

## Creating one

The first startup is made in the [setup](setup.md) that opens when the tracker is empty. Closing the setup leaves the plain "Create your first startup" screen, with a button back to the setup.

For more startups, **Settings > Startups > Start the setup for a new startup** runs the setup's startup steps (profile, links, AI context and categories). For a quick one, choose **New startup…** in the switcher, or use the form below it in **Settings > Startups**, and give it a name. You can copy the settings of an existing startup: the profile fields you tick, which categories are turned on, and its view preferences. Records are not copied unless you ask for that. Tags, campaigns, statuses and prompts are shared by every startup anyway.

The startup's id is made from its first name plus four random characters, for example `acme-7f3k`. Renaming the startup later does not change the id, so links and bookmarks keep working.

## Archiving and deleting

An archived startup disappears from the switcher, the combined search and the combined calendar, and its address no longer opens. Nothing is removed, and you can bring it back.

Deleting a startup asks you to type its name, then takes a safety backup of the whole tracker, uploads included. If that backup fails, nothing is deleted. Then the startup's records and its media folder are removed. To get it back, restore that safety backup in **Settings > Backups**.

## Search and calendar across startups

The search box in the top bar and the calendar have a **This startup / All startups** switch, remembered per startup. "All startups" shows matching records and dated events from every startup that is not archived, each with its startup's name. Opening one switches to that startup first. Across startups, search covers marketing, programs, funding, campaigns and media, and the calendar shows marketing, program, funding, company and campaign dates.

## Upgrading an older tracker database

A database from before startups existed (one tracker per file) is upgraded the first time the server opens it. A copy of the old file is kept in the backup folder as `tracker-<time>-pre-upgrade-v<version>.sqlite`, and the upgrade does not run if that copy cannot be made. All existing records go into one startup named "Imported", which you can rename. Uploads that sat directly in the media folder move into that startup's folder, and old `/media/<file>` links keep working.
