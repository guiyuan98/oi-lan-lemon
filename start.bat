@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node.js was not found. Please install Node.js first.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $root=(Get-Location).Path; $data=Join-Path $root 'data'; $pidFile=Join-Path $data 'server.pid'; $url='http://127.0.0.1:3000/'; function TestServer { try { return (Invoke-RestMethod ($url+'api/health') -TimeoutSec 2).ok -eq $true } catch { return $false } }; New-Item -ItemType Directory -Path $data -Force | Out-Null; if(Test-Path $pidFile){ $oldPid=[int](Get-Content -Raw $pidFile); $running=Get-CimInstance Win32_Process -Filter ('ProcessId='+$oldPid) -ErrorAction SilentlyContinue; if($running -and $running.Name -eq 'node.exe' -and $running.CommandLine -match 'server\.mjs'){ Write-Host ('Server is already running. PID: '+$oldPid) -ForegroundColor Yellow; if($env:NO_BROWSER -ne '1'){ Start-Process $url }; exit 0 }; Remove-Item -LiteralPath $pidFile -Force }; $env:HOST='0.0.0.0'; $env:PORT='3000'; $node=(Get-Command node).Source; $process=Start-Process -FilePath $node -ArgumentList 'server.mjs' -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput (Join-Path $data 'server.out.log') -RedirectStandardError (Join-Path $data 'server.err.log') -PassThru; for($i=0; $i -lt 40 -and !(TestServer); $i++){ Start-Sleep -Milliseconds 250 }; if(!(TestServer) -or !(Get-Process -Id $process.Id -ErrorAction SilentlyContinue)){ Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue; throw ('Server failed to start. Check '+(Join-Path $data 'server.err.log')) }; Set-Content -LiteralPath $pidFile -Value $process.Id -Encoding ascii; Write-Host ('Server started. PID: '+$process.Id) -ForegroundColor Green; Write-Host ('Open: '+$url); if($env:NO_BROWSER -ne '1'){ Start-Process $url }"

if errorlevel 1 (
  echo.
  echo Failed to start the server.
  pause
  exit /b 1
)
ping -n 2 127.0.0.1 >nul
exit /b 0
