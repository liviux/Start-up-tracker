# Security policy

## Reporting a vulnerability

Please report security problems privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. This uses GitHub's private vulnerability reporting, so only the maintainers see the report. Do not open a public issue, discussion or pull request for a security problem.

A useful report says:

- what an attacker can do, and what they need first (another website open in the same browser, access to the same network, a local account on the same computer);
- the steps or a request that shows it, against a tracker with demo data (`node tools/demo-data.js --data-dir <folder>`), never your own data;
- the version of Startup Tracker, Node.js and your operating system.

Do not include personal data or the contents of your own tracker in the report.

We will confirm that we received the report, tell you whether we can reproduce it, and keep you informed until it is fixed. Once a fix is released, we publish an advisory and credit you if you want to be credited.

## Supported versions

Only the latest release gets security fixes. Please check that the problem still happens on the latest release before you report it.

## In scope

Startup Tracker runs a web server on your own computer. These parts are in scope:

- **The local server**: anything that lets another website, another device on the network or another local user read or change tracker data, or makes the server answer requests from hosts it should refuse.
- **The write guard**: a request that changes data without coming from the tracker's own page and without the API token (`secrets/api-token` in the data folder), or a way to read that token.
- **Path checks**: a way to read files outside `public/`, `content/` and the media folder (the code, the data folder, git metadata), or to write uploads or documents outside the media folder, for example with `..`, encoded paths or symbolic links.
- **The page**: script injection through record fields, notes, links or uploaded files, and ways around the page's content security policy.
- **Backups, restore and import**: a crafted backup or import file that writes outside the data folder or runs code.

[docs/security.md](docs/security.md) describes what the server is meant to do.

## Out of scope

- Someone who already controls your user account or your computer. They can read the data folder directly.
- A server you deliberately opened to other devices with `ALLOWED_HOSTS`, beyond what the write guard and path checks promise.
- Problems in Node.js itself or in your browser. Please report those to their projects.
