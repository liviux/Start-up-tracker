@echo off
rem Starts Startup Tracker from this folder and opens it in the browser. The
rem same as "node bin\startup-tracker.js"; every command and option of the
rem startup-tracker command works here too (docs/cli.md).
cd /d "%~dp0"
node bin\startup-tracker.js %*
