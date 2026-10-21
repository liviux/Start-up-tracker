#!/usr/bin/env bash
# Installs Startup Tracker for the current user on macOS, Linux and WSL.
#
#   curl -fsSL https://liviux.github.io/Start-up-tracker/install.sh | bash
#   curl -fsSL https://liviux.github.io/Start-up-tracker/install.sh | bash -s -- --no-start
#   bash install.sh --archive ./dist/startup-tracker.tar.gz
#
# What it does, in order (docs/install.md):
#   1. checks for Node.js 22.16 or newer; without it, prints how to install it
#      and stops (it never installs system software itself)
#   2. downloads the release archive and SHA256SUMS from GitHub Releases (or
#      takes --archive with the SHA256SUMS next to it) and checks the hash
#   3. unpacks to <dir>/app.new, then swaps it in as <dir>/app; the version it
#      replaces stays as <dir>/app.prev
#   4. writes the startup-tracker command to ~/.local/bin
#   5. asks whether to start the tracker when you log in
#   6. starts the tracker and opens the browser
#
# Options:
#   --version <x.y.z>  install that release instead of the latest
#   --archive <file>   install from a local release archive (SHA256SUMS beside it)
#   --dir <folder>     install and data folder (default ~/.startup-tracker)
#   --autostart        turn autostart on without asking
#   --no-autostart     leave autostart off without asking
#   --no-start         do not start the tracker at the end
#
# Your data is never touched: it lives in the same folder, outside app/.

set -euo pipefail

REPO="${STARTUP_TRACKER_REPO:-liviux/Start-up-tracker}"
ARCHIVE_NAME="startup-tracker.tar.gz"
SUMS_NAME="SHA256SUMS"
MIN_NODE_MAJOR=22
MIN_NODE_MINOR=16
LAUNCHER_MARKER="Startup Tracker installer"

version=""
archive=""
root="${HOME}/.startup-tracker"
autostart="ask"
start="yes"

say() { printf '%s\n' "$*"; }
fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --version) [ $# -ge 2 ] || fail "--version needs a version, for example 0.1.0"; version="${2#v}"; shift 2 ;;
    --version=*) version="${1#--version=}"; version="${version#v}"; shift ;;
    --archive) [ $# -ge 2 ] || fail "--archive needs a file"; archive="$2"; shift 2 ;;
    --archive=*) archive="${1#--archive=}"; shift ;;
    --dir) [ $# -ge 2 ] || fail "--dir needs a folder"; root="$2"; shift 2 ;;
    --dir=*) root="${1#--dir=}"; shift ;;
    --autostart) autostart="yes"; shift ;;
    --no-autostart) autostart="no"; shift ;;
    --no-start) start="no"; shift ;;
    -h|--help) sed -n '2,29p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) fail "unknown option: $1 (see --help)" ;;
  esac
done

# A literal ~ (from --dir=~/x, which the shell does not expand).
tilde="~"
case "$root" in
  "$tilde") root="$HOME" ;;
  "$tilde"/*) root="${HOME}/${root#"$tilde"/}" ;;
esac
case "$root" in
  /*) ;;
  *) root="$(pwd)/${root}" ;;
esac

# ---- 1. Node.js -----------------------------------------------------------------

os="$(uname -s)"
node_help() {
  say ""
  say "Startup Tracker needs Node.js ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} or newer. Install it with one of these, then run this installer again:"
  if [ "$os" = "Darwin" ]; then
    say "  brew install node@24                      (Homebrew)"
  fi
  say "  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash && nvm install 24   (nvm)"
  say "  curl -fsSL https://fnm.vercel.app/install | bash && fnm install 24                                  (fnm)"
  say "  or the installer from https://nodejs.org/"
}

command -v node >/dev/null 2>&1 || { say "Node.js was not found."; node_help; exit 1; }
node_version="$(node -p 'process.versions.node' 2>/dev/null || true)"
node_major="${node_version%%.*}"
node_rest="${node_version#*.}"
node_minor="${node_rest%%.*}"
if ! [ "$node_major" -gt "$MIN_NODE_MAJOR" ] 2>/dev/null && ! { [ "$node_major" -eq "$MIN_NODE_MAJOR" ] 2>/dev/null && [ "$node_minor" -ge "$MIN_NODE_MINOR" ]; }; then
  say "Node.js ${node_version:-of unknown version} is too old."
  node_help
  exit 1
fi
say "Node.js ${node_version}: ok."

# ---- 2. Download and check ---------------------------------------------------------

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else node -e 'process.stdout.write(require("crypto").createHash("sha256").update(require("fs").readFileSync(process.argv[1])).digest("hex"))' "$1"
  fi
}

fetch() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL --retry 3 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then wget -q -O "$2" "$1"
  else fail "neither curl nor wget is installed, so the release cannot be downloaded."
  fi
}

mkdir -p "$root"
chmod 700 "$root" 2>/dev/null || true
work="$(mktemp -d "${root}/.install.XXXXXX")"
cleanup() { rm -rf "$work"; }
trap cleanup EXIT

if [ -n "$archive" ]; then
  [ -f "$archive" ] || fail "no archive at ${archive}"
  sums="$(dirname "$archive")/${SUMS_NAME}"
  [ -f "$sums" ] || fail "${SUMS_NAME} must sit next to the archive (tools/build-release.js writes both)."
  cp "$archive" "${work}/${ARCHIVE_NAME}"
  cp "$sums" "${work}/${SUMS_NAME}"
  say "Installing from ${archive}."
else
  if [ -n "$version" ]; then base="https://github.com/${REPO}/releases/download/v${version}"
  else base="https://github.com/${REPO}/releases/latest/download"
  fi
  say "Downloading Startup Tracker ${version:-(latest)} from github.com/${REPO}..."
  fetch "${base}/${ARCHIVE_NAME}" "${work}/${ARCHIVE_NAME}" || fail "the download failed. Check the version and your connection."
  fetch "${base}/${SUMS_NAME}" "${work}/${SUMS_NAME}" || fail "${SUMS_NAME} could not be downloaded, so the archive cannot be checked."
fi

expected="$(awk -v name="$ARCHIVE_NAME" '{ file = $2; sub(/^\*/, "", file) } file == name { print tolower($1); exit }' "${work}/${SUMS_NAME}")"
[ -n "$expected" ] || fail "${SUMS_NAME} has no line for ${ARCHIVE_NAME}. Nothing was installed."
actual="$(sha256_of "${work}/${ARCHIVE_NAME}")"
[ "$expected" = "$actual" ] || fail "the archive does not match its checksum (expected ${expected}, got ${actual}). Nothing was installed."
say "Checksum verified."

# ---- 3. Unpack and swap -------------------------------------------------------------

mkdir "${work}/unpacked"
tar -xzf "${work}/${ARCHIVE_NAME}" -C "${work}/unpacked"
set -- "${work}/unpacked"/*
if [ $# -ne 1 ] || [ ! -d "$1" ]; then fail "the archive must hold exactly one top folder."; fi
if [ ! -f "$1/bin/startup-tracker.js" ] || [ ! -f "$1/server.js" ]; then fail "the archive is not a Startup Tracker release."; fi
rm -rf "${root}/app.new"
mv "$1" "${root}/app.new"
new_version="$(node -p 'require(process.argv[1]).version' "${root}/app.new/package.json")"

was_running="no"
if [ -f "${root}/app/bin/startup-tracker.js" ]; then
  if STARTUP_TRACKER_HOME="$root" node "${root}/app/bin/startup-tracker.js" status >/dev/null 2>&1; then
    was_running="yes"
    say "Stopping the running tracker..."
    STARTUP_TRACKER_HOME="$root" node "${root}/app/bin/startup-tracker.js" stop || fail "the running tracker did not stop. Stop it and run the installer again."
  fi
  rm -rf "${root}/app.prev"
  mv "${root}/app" "${root}/app.prev"
fi
mv "${root}/app.new" "${root}/app"
if ! node "${root}/app/bin/startup-tracker.js" version >/dev/null 2>&1; then
  rm -rf "${root}/app"
  [ -d "${root}/app.prev" ] && mv "${root}/app.prev" "${root}/app"
  fail "version ${new_version} did not load with Node.js ${node_version}; the previous version is back."
fi
say "Installed Startup Tracker ${new_version} in ${root}/app."

# ---- 4. The command ----------------------------------------------------------------

bin_dir="${HOME}/.local/bin"
launcher="${bin_dir}/startup-tracker"
mkdir -p "$bin_dir"
if [ -e "$launcher" ] && ! grep -q "$LAUNCHER_MARKER" "$launcher" 2>/dev/null; then
  say "${launcher} exists and was not made by this installer; it was left alone. Run ${root}/app/bin/startup-tracker.js instead."
else
  quoted_root="$(printf '%q' "$root")"
  cat > "$launcher" <<EOF
#!/usr/bin/env bash
# ${LAUNCHER_MARKER}: runs the Startup Tracker command installed in ${root}/app.
export STARTUP_TRACKER_HOME="\${STARTUP_TRACKER_HOME:-${quoted_root}}"
exec node ${quoted_root}/app/bin/startup-tracker.js "\$@"
EOF
  chmod 755 "$launcher"
  say "Added the startup-tracker command (${launcher})."
fi
case ":${PATH}:" in
  *":${bin_dir}:"*) ;;
  *) say "Note: ${bin_dir} is not on your PATH. Add this line to ~/.bashrc or ~/.zshrc, then open a new terminal:"
     say "  export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
esac
run_cli() { STARTUP_TRACKER_HOME="$root" node "${root}/app/bin/startup-tracker.js" "$@"; }

# ---- 5. Autostart --------------------------------------------------------------------

if [ "$autostart" = "ask" ]; then
  autostart="no"
  # /dev/tty, not stdin: with curl | bash, stdin is the script itself.
  if { true < /dev/tty; } 2>/dev/null; then
    printf 'Start Startup Tracker when you log in? [y/N] ' > /dev/tty
    read -r answer < /dev/tty || answer=""
    case "$answer" in [yY]|[yY][eE][sS]) autostart="yes" ;; esac
  fi
fi
if [ "$autostart" = "yes" ]; then
  run_cli autostart on || say "Autostart could not be turned on; the tracker still works. Try again later with: startup-tracker autostart on"
fi

# ---- 6. Start -------------------------------------------------------------------------

if [ "$start" = "yes" ] || [ "$was_running" = "yes" ]; then
  run_cli
else
  say "Start it with: startup-tracker"
fi
