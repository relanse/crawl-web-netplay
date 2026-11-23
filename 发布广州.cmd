@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy\publish.ps1" %*
set "release_exit=%errorlevel%"
pause
exit /b %release_exit%
