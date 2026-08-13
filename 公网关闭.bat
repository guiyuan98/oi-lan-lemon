@echo off
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0public-tunnel.ps1" stop
if errorlevel 1 pause
