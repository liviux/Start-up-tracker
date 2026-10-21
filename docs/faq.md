# FAQ and troubleshooting

## The tracker does not start

Run `startup-tracker doctor`. It checks Node.js, the port, the data folder's permissions and the database, and says what to do about each problem. `startup-tracker logs` shows the end of the server log.

- **"needs Node.js 22.16 or newer"**: install a newer Node.js ([Install](install.md)), then open a new terminal.
- **"Port 57322 is used by another program"**: something else holds the port. On a terminal, `startup-tracker` offers the next free port and saves it if you agree. Edits the browser had not sent yet stay with the old address: open the old address once more after freeing the port to send them.
- **"refuses to start on a damaged database"**: the database failed its integrity check. The message names the newest backup that passed; restore it with `startup-tracker restore --snapshot <backup>` while the tracker is stopped. The damaged file is kept beside it.

## The page says "Conflict"

Another tab, another browser or an agent changed the same record after you started editing it. The save-state badge offers **Keep mine** or **Use theirs**. Nothing is overwritten until you choose, and your other edits keep saving meanwhile.

## The startup switcher shows ↑ or !

↑ means this browser holds edits for that startup that have not reached the tracker yet, for example after the tracker was stopped. Open the startup to send them. ! means an edit waits for you to resolve a conflict.

## I deleted something by mistake

Deleted records go to the recycle bin in **Settings > Recycle bin** for 30 days. For anything older, or a record that was changed rather than deleted, open its **History** tab, or restore one record from a backup ([Backups](backups.md)).

## How do I move my data to another computer?

Either export everything (**Settings > Backups > Export**, as a zip) and import it on the other computer, or stop the tracker and copy the whole data folder, `~/.startup-tracker`. Do not copy only `data/tracker.sqlite` while the tracker runs.

## Where is my data?

In `~/.startup-tracker` (`%USERPROFILE%\.startup-tracker` on Windows) unless you chose another folder. `startup-tracker status` and **Settings > About** show it. The app's code is in `app/` inside it, if you used the installer, and never holds data.

## An agent says "Needs login"

Log in to the agent the way its own documentation says, often by running it once in a terminal; the **Check** result shows the exact command. Then select **Check** again. See [AI agents](agents.md#check).

## An agent run does nothing for a long time

A run with no update for 10 minutes is flagged as idle; you decide whether to cancel it. Some agents download their package on the first run, which can take a few minutes.

## Can I use it with my team?

Not today. The tracker is for one person on one computer: it listens only on `127.0.0.1` and has no accounts.

## Does it work offline?

Yes. Only the agent registry and the update check go online, and both can be turned off ([Privacy](privacy.md)). AI agents need their model provider, so runs need a connection.
