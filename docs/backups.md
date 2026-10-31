# Backups, export and import

Everything here is in **Settings > Backups**.

## What a backup holds

Every backup covers the whole tracker: every startup, the shared settings and the uploaded media files. Each one is a folder in `backups/` in the data folder:

- `tracker.sqlite`, a copy of the database that was checked before the backup counted;
- `media-manifest.json`, the list of media files with a fingerprint (SHA-256) of each.

Media files are stored once in `backups/media-store/` and shared by all backups, so a file that did not change takes no extra space. When a backup is deleted, media files that no other backup lists go with it.

Data that has not changed since the newest backup is not backed up again.

## Three kinds

| Kind | When | How many are kept |
|---|---|---|
| Automatic | When the server starts and the data changed since the newest backup, and at the interval you set (six hours by default) while you are editing | The newest 20 (you can change this) |
| Safety | Before a restore, an import or deleting a startup | The newest 20 (you can change this), counted apart from automatic ones |
| Pinned | When you click **Back up now**, with an optional label | All of them, until you delete them |

Automatic backups can be turned off in **Settings > Backups** (or in the setup), and the interval can be any whole number of hours from 1 to 8760; six is the default. Safety backups always run.

If a safety backup cannot be taken, the restore, import or delete it was for does not happen.

## Restoring

Pick a backup and **Restore**. You choose how much comes back:

- **This startup only.** The startup's records and media files come back as the backup has them. Other startups are not touched.
- **The whole database.** Every startup and the shared settings come back, with all media files. Startups created after the backup are removed.
- **Selected records.** **Compare with current** lists what differs between the backup and this startup now; tick the records you want back.

Media files the backup does not list are never deleted by a restore.

While a restore runs the tracker accepts no other change. Afterwards, other open tabs of that startup reload. Edits they had not sent yet are not applied on top of the restored data: they show as conflicts, and you choose **Keep mine** or **Use theirs** for each.

## Export

- **This startup** or **All startups** as a `.zip` (one JSON file per section, the media files and a manifest) or as JSON only (no media).
- **The whole database** as a `.sqlite` file.

Exports never include the `secrets/` folder. Sensitive company values (bank accounts, ID numbers) are left out of zip and JSON exports unless you tick "Include sensitive company values"; the database file always holds them, so keep it as private as the data folder.

## Import

Choose a `.zip` or `.json` export, or a `.sqlite` database. The tracker checks it and shows how many records each startup and section holds before anything changes. Then:

- **Add as a new startup**: each startup in the export is added next to the ones you have.
- **Replace this startup**: the current startup's records are replaced with the export's (it must hold exactly one startup).
- **Restore the whole database** (for a `.sqlite` file): like restoring a backup of the whole database.

A safety backup is taken first. Archives with paths that leave the archive, absolute paths, symbolic links, more than 20,000 entries or more than 2 GB of content are refused.

## From a terminal

- `node tools/backup-sqlite.js --label <what>` takes a pinned backup before you run something risky.
- `node tools/restore-sqlite.js --list` lists backups. See [development.md](development.md) for restoring from the command line.
