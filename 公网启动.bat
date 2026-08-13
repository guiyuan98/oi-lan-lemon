@echo off
chcp 65001 >nul
echo Starting the website and public tunnel. Please wait...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0public-tunnel.ps1" start
exit /b %errorlevel%
