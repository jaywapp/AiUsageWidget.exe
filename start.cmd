@echo off
cd /d "%~dp0"
start "" http://localhost:4789
node server.js
