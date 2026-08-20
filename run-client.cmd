@echo off
set "PATH=C:\Program Files\nodejs;%PATH%"
cd /d "%~dp0client"
call npm run dev
