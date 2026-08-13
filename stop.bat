@echo off
setlocal
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $pidFile=Join-Path (Get-Location).Path 'data\server.pid'; if(!(Test-Path $pidFile)){ Write-Host 'Server is not running.' -ForegroundColor Yellow; exit 0 }; $serverPid=[int](Get-Content -Raw $pidFile); $server=Get-CimInstance Win32_Process -Filter ('ProcessId='+$serverPid) -ErrorAction SilentlyContinue; if(!$server){ Remove-Item -LiteralPath $pidFile -Force; Write-Host 'Server was already stopped.' -ForegroundColor Yellow; exit 0 }; if($server.Name -ne 'node.exe' -or $server.CommandLine -notmatch 'server\.mjs'){ throw ('PID '+$serverPid+' does not belong to this server. Refusing to stop it.') }; function StopTree([int]$id){ $children=Get-CimInstance Win32_Process -Filter ('ParentProcessId='+$id) -ErrorAction SilentlyContinue; foreach($child in $children){ StopTree $child.ProcessId }; Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }; StopTree $serverPid; Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue; Write-Host ('Server stopped. PID: '+$serverPid) -ForegroundColor Green"

if errorlevel 1 (
  echo.
  echo Failed to stop the server.
  pause
  exit /b 1
)
ping -n 2 127.0.0.1 >nul
exit /b 0
