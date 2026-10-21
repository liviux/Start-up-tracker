# Installs Startup Tracker for the current user on Windows.
#
#   irm https://liviux.github.io/Start-up-tracker/install.ps1 | iex
#   .\install.ps1 -Archive .\dist\startup-tracker.tar.gz -NoStart
#
# What it does, in order (docs/install.md):
#   1. checks for Node.js 22.16 or newer; without it, says how to install it
#      (winget install OpenJS.NodeJS.LTS) and stops
#   2. downloads the release archive and SHA256SUMS from GitHub Releases (or
#      takes -Archive with the SHA256SUMS next to it) and checks the hash
#   3. unpacks to <Dir>\app.new, then swaps it in as <Dir>\app; the version it
#      replaces stays as <Dir>\app.prev
#   4. writes <Dir>\bin\startup-tracker.cmd and puts that folder on your user PATH
#   5. asks whether to start the tracker when you log in (a Task Scheduler task)
#   6. starts the tracker and opens the browser
#
# With "irm | iex" there are no parameters; set $env:STARTUP_TRACKER_VERSION,
# $env:STARTUP_TRACKER_AUTOSTART ("yes" or "no") or $env:STARTUP_TRACKER_NO_START
# first instead. Your data is never touched: it lives in the same folder,
# outside app\.

param(
  [string]$Version = $env:STARTUP_TRACKER_VERSION,
  [string]$Archive = "",
  [string]$Dir = (Join-Path $env:USERPROFILE ".startup-tracker"),
  [switch]$Autostart,
  [switch]$NoAutostart,
  [switch]$NoStart
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$Repo = if ($env:STARTUP_TRACKER_REPO) { $env:STARTUP_TRACKER_REPO } else { "liviux/Start-up-tracker" }
$ArchiveName = "startup-tracker.tar.gz"
$SumsName = "SHA256SUMS"
$MinNode = [version]"22.16.0"
$LauncherMarker = "Startup Tracker installer"

# Throws rather than exits: with "irm | iex" an exit would close the window.
function Exit-Install([string]$Message) {
  throw "Startup Tracker was not installed: $Message"
}

# ---- 1. Node.js ---------------------------------------------------------------------

$node = Get-Command node -ErrorAction SilentlyContinue
$nodeHelp = @"

Startup Tracker needs Node.js $($MinNode.Major).$($MinNode.Minor) or newer. Install it, open a new PowerShell window and run this installer again:
  winget install OpenJS.NodeJS.LTS
  or the installer from https://nodejs.org/
"@
if (-not $node) {
  Write-Output $nodeHelp
  Exit-Install "Node.js was not found."
}
$nodeVersionText = (& node -p "process.versions.node").Trim()
if ([version]$nodeVersionText -lt $MinNode) {
  Write-Output $nodeHelp
  Exit-Install "Node.js $nodeVersionText is too old."
}
Write-Output "Node.js ${nodeVersionText}: ok."

# tar.exe ships with Windows 10 (1803) and later; it unpacks the release.
if (-not (Get-Command tar.exe -ErrorAction SilentlyContinue)) {
  Exit-Install "tar.exe was not found. It comes with Windows 10 version 1803 and later."
}

# ---- 2. Download and check ------------------------------------------------------------

$Dir = [System.IO.Path]::GetFullPath($Dir)
New-Item -ItemType Directory -Force -Path $Dir | Out-Null
$work = Join-Path $Dir (".install-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Path $work | Out-Null

try {
  $archiveFile = Join-Path $work $ArchiveName
  $sumsFile = Join-Path $work $SumsName
  if ($Archive) {
    if (-not (Test-Path -LiteralPath $Archive -PathType Leaf)) { Exit-Install "no archive at $Archive" }
    $sumsBeside = Join-Path (Split-Path -Parent (Resolve-Path -LiteralPath $Archive)) $SumsName
    if (-not (Test-Path -LiteralPath $sumsBeside)) { Exit-Install "$SumsName must sit next to the archive (tools/build-release.js writes both)." }
    Copy-Item -LiteralPath $Archive -Destination $archiveFile
    Copy-Item -LiteralPath $sumsBeside -Destination $sumsFile
    Write-Output "Installing from $Archive."
  } else {
    $tag = if ($Version) { "v" + $Version.TrimStart("v") } else { "" }
    $base = if ($tag) { "https://github.com/$Repo/releases/download/$tag" } else { "https://github.com/$Repo/releases/latest/download" }
    Write-Output "Downloading Startup Tracker $(if ($tag) { $tag } else { '(latest)' }) from github.com/$Repo..."
    try {
      Invoke-WebRequest -UseBasicParsing -Uri "$base/$ArchiveName" -OutFile $archiveFile
      Invoke-WebRequest -UseBasicParsing -Uri "$base/$SumsName" -OutFile $sumsFile
    } catch {
      Exit-Install "the download failed ($($_.Exception.Message)). Check the version and your connection."
    }
  }

  $expected = $null
  foreach ($line in Get-Content -LiteralPath $sumsFile) {
    if ($line -match '^([0-9a-fA-F]{64})\s+\*?(.+)$' -and $Matches[2].Trim() -eq $ArchiveName) { $expected = $Matches[1].ToLower(); break }
  }
  if (-not $expected) { Exit-Install "$SumsName has no line for $ArchiveName. Nothing was installed." }
  $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $archiveFile).Hash.ToLower()
  if ($actual -ne $expected) { Exit-Install "the archive does not match its checksum (expected $expected, got $actual). Nothing was installed." }
  Write-Output "Checksum verified."

  # ---- 3. Unpack and swap ---------------------------------------------------------------

  $unpacked = Join-Path $work "unpacked"
  New-Item -ItemType Directory -Path $unpacked | Out-Null
  & tar.exe -xzf $archiveFile -C $unpacked
  if ($LASTEXITCODE -ne 0) { Exit-Install "the archive could not be unpacked." }
  $top = @(Get-ChildItem -LiteralPath $unpacked)
  if ($top.Count -ne 1 -or -not $top[0].PSIsContainer) { Exit-Install "the archive must hold exactly one top folder." }
  $source = $top[0].FullName
  if (-not (Test-Path (Join-Path $source "bin\startup-tracker.js")) -or -not (Test-Path (Join-Path $source "server.js"))) {
    Exit-Install "the archive is not a Startup Tracker release."
  }

  $app = Join-Path $Dir "app"
  $appNew = Join-Path $Dir "app.new"
  $appPrev = Join-Path $Dir "app.prev"
  if (Test-Path $appNew) { Remove-Item -Recurse -Force $appNew }
  Move-Item -LiteralPath $source -Destination $appNew
  $newVersion = (& node -p "require(process.argv[1]).version" (Join-Path $appNew "package.json")).Trim()

  $env:STARTUP_TRACKER_HOME = $Dir
  $wasRunning = $false
  $oldCli = Join-Path $app "bin\startup-tracker.js"
  if (Test-Path $oldCli) {
    & node $oldCli status *> $null
    if ($LASTEXITCODE -eq 0) {
      $wasRunning = $true
      Write-Output "Stopping the running tracker..."
      & node $oldCli stop
      if ($LASTEXITCODE -ne 0) { Exit-Install "the running tracker did not stop. Stop it and run the installer again." }
    }
    if (Test-Path $appPrev) { Remove-Item -Recurse -Force $appPrev }
    Move-Item -LiteralPath $app -Destination $appPrev
  }
  Move-Item -LiteralPath $appNew -Destination $app
  $cli = Join-Path $app "bin\startup-tracker.js"
  & node $cli version *> $null
  if ($LASTEXITCODE -ne 0) {
    Remove-Item -Recurse -Force $app
    if (Test-Path $appPrev) { Move-Item -LiteralPath $appPrev -Destination $app }
    Exit-Install "version $newVersion did not load with Node.js $nodeVersionText; the previous version is back."
  }
  Write-Output "Installed Startup Tracker $newVersion in $app."
} finally {
  Remove-Item -Recurse -Force -LiteralPath $work -ErrorAction SilentlyContinue
}

# ---- 4. The command ---------------------------------------------------------------------

$binDir = Join-Path $Dir "bin"
$launcher = Join-Path $binDir "startup-tracker.cmd"
New-Item -ItemType Directory -Force -Path $binDir | Out-Null
if ((Test-Path $launcher) -and -not (Select-String -LiteralPath $launcher -SimpleMatch $LauncherMarker -Quiet)) {
  Write-Output "$launcher exists and was not made by this installer; it was left alone."
} else {
  $content = @"
@echo off
rem ${LauncherMarker}: runs the Startup Tracker command installed in $app.
if "%STARTUP_TRACKER_HOME%"=="" set "STARTUP_TRACKER_HOME=$Dir"
node "$cli" %*
"@
  Set-Content -LiteralPath $launcher -Value $content -Encoding ASCII
  Write-Output "Added the startup-tracker command ($launcher)."
}
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
$parts = @($userPath -split ";" | Where-Object { $_ })
if ($parts -notcontains $binDir) {
  [Environment]::SetEnvironmentVariable("Path", (($parts + $binDir) -join ";"), "User")
  Write-Output "Added $binDir to your user PATH; open a new terminal to use startup-tracker there."
}
$env:Path = "$binDir;$env:Path"

# ---- 5. Autostart ------------------------------------------------------------------------

$wantAutostart = $false
if ($Autostart -or $env:STARTUP_TRACKER_AUTOSTART -eq "yes") {
  $wantAutostart = $true
} elseif (-not $NoAutostart -and $env:STARTUP_TRACKER_AUTOSTART -ne "no" -and [Environment]::UserInteractive) {
  $answer = Read-Host "Start Startup Tracker when you log in? [y/N]"
  $wantAutostart = $answer -match '^(y|yes)$'
}
if ($wantAutostart) {
  & node $cli autostart on
  if ($LASTEXITCODE -ne 0) { Write-Output "Autostart could not be turned on; the tracker still works. Try again later with: startup-tracker autostart on" }
}

# ---- 6. Start ------------------------------------------------------------------------------

if ((-not $NoStart -and -not $env:STARTUP_TRACKER_NO_START) -or $wasRunning) {
  & node $cli
} else {
  Write-Output "Start it with: startup-tracker"
}
