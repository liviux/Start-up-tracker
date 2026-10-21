#!/usr/bin/env bash
# Starts Startup Tracker from this folder and opens it in the browser. The
# same as "node bin/startup-tracker.js"; every command and option of the
# startup-tracker command works here too (docs/cli.md).
set -euo pipefail
cd "$(dirname "$0")"
exec node bin/startup-tracker.js "$@"
