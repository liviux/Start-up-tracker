"use strict";

// startup-tracker uninstall: stops the tracker, turns autostart off and
// removes the installed app and the startup-tracker command. The data folder
// stays unless --purge-data is given and the user types DELETE at the prompt.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { launcherPath } = require("./layout");

const LAUNCHER_MARKER = "Startup Tracker installer";

// A folder that is never deleted, whatever the data folder setting says.
function isProtectedFolder(folder, homedir) {
  const resolved = path.resolve(folder);
  return resolved === path.parse(resolved).root || resolved === path.resolve(homedir) || resolved.split(path.sep).filter(Boolean).length < 2;
}

function removeIfOurs(file) {
  try {
    if (!fs.readFileSync(file, "utf8").includes(LAUNCHER_MARKER)) return false;
  } catch {
    return false;
  }
  fs.rmSync(file, { force: true });
  return true;
}

function removeEmptyFolder(folder) {
  try {
    fs.rmdirSync(folder);
    return true;
  } catch {
    return false;
  }
}

// options: layout, paths, purgeData, out, ask, interactive, homedir, platform,
// stopServer() and disableAutostart(), both best effort.
async function runUninstall(options) {
  const { layout, paths, purgeData = false, out, ask, interactive = false, homedir = os.homedir(), platform = process.platform } = options;
  const stopServer = options.stopServer || (async () => true);
  const disableAutostart = options.disableAutostart || (() => ({ message: "" }));

  if (!(await stopServer())) out("The tracker did not stop; its files are removed anyway once it exits.");
  try {
    const result = disableAutostart();
    if (result && result.message) out(result.message);
  } catch (error) {
    out(`Autostart could not be turned off: ${error.message}`);
  }

  if (layout.installed) {
    const launcher = launcherPath({ platform, homedir, installRoot: layout.installRoot });
    if (removeIfOurs(launcher)) {
      out(`Removed ${launcher}.`);
      if (platform === "win32") {
        removeEmptyFolder(path.dirname(launcher));
        out(`You can remove ${path.dirname(launcher)} from your user PATH in the Windows environment variable settings.`);
      }
    }
    for (const folder of [layout.appNew, layout.appPrev, layout.appDir]) {
      if (fs.existsSync(folder)) {
        fs.rmSync(folder, { recursive: true, force: true });
        out(`Removed ${folder}.`);
      }
    }
  } else {
    out(`This copy runs from ${layout.appRoot}, which the installer did not create; it was left alone. Delete that folder yourself if you no longer need it.`);
  }

  let purged = false;
  if (purgeData) {
    if (isProtectedFolder(paths.root, homedir)) {
      out(`The data folder ${paths.root} is not removed: it is your home folder or a top-level folder.`);
    } else if (!interactive) {
      out("--purge-data asks you to type DELETE, which needs a terminal. Your data was kept.");
    } else {
      out(`This deletes ${paths.root}: every startup, media file and backup in it. It cannot be undone.`);
      const answer = await ask("Type DELETE to remove it, or press Enter to keep it: ");
      if (answer === "DELETE") {
        fs.rmSync(paths.root, { recursive: true, force: true });
        purged = true;
        out(`Removed ${paths.root}.`);
      }
    }
  }
  if (!purged) out(`Your data is still in ${paths.root}. Delete that folder yourself if you want it gone.`);
  if (layout.installed && layout.installRoot !== paths.root) removeEmptyFolder(layout.installRoot);
  return { purged };
}

module.exports = { LAUNCHER_MARKER, isProtectedFolder, runUninstall };
