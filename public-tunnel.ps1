param([ValidateSet('start', 'stop')][string]$Action = 'start')

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$data = Join-Path $root 'data'
$exe = Join-Path $root 'tools\cloudflared.exe'
$pidFile = Join-Path $data 'tunnel.pid'
$urlFile = Join-Path $data 'public-url.txt'
$outLog = Join-Path $data 'tunnel.out.log'
$errLog = Join-Path $data 'tunnel.err.log'
$desktopDir = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Lemon'
$desktopUrlFile = Join-Path $desktopDir 'public-url.txt'
$desktopHistoryFile = Join-Path $desktopDir 'public-url-history.txt'

function Get-TunnelProcess {
  if (!(Test-Path $pidFile)) { return $null }
  $id = [int](Get-Content -Raw $pidFile)
  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction SilentlyContinue
  if ($process -and $process.Name -eq 'cloudflared.exe' -and $process.CommandLine -match 'tunnel') { return $process }
  Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
  return $null
}

if ($Action -eq 'stop') {
  $process = Get-TunnelProcess
  if ($process) { Stop-Process -Id $process.ProcessId -Force }
  Remove-Item -LiteralPath $pidFile, $urlFile -Force -ErrorAction SilentlyContinue
  & (Join-Path $root 'stop.bat')
  Write-Host 'Public tunnel and server stopped.' -ForegroundColor Green
  exit $LASTEXITCODE
}

if (!(Test-Path $exe)) { throw "cloudflared not found: $exe" }
New-Item -ItemType Directory -Path $data -Force | Out-Null
$env:NO_BROWSER = '1'
& (Join-Path $root 'start.bat')
if ($LASTEXITCODE) { throw 'Server failed to start.' }

$running = Get-TunnelProcess
if (!$running) {
  Remove-Item -LiteralPath $outLog, $errLog -Force -ErrorAction SilentlyContinue
  $running = Start-Process -FilePath $exe -ArgumentList @('tunnel', '--no-autoupdate', '--protocol', 'http2', '--url', 'http://127.0.0.1:3000') -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru
  Set-Content -LiteralPath $pidFile -Value $running.Id -Encoding ascii
}
$runningId = if ($running -is [System.Diagnostics.Process]) { $running.Id } else { $running.ProcessId }

$url = $null
$connected = $false
for ($i = 0; $i -lt 90 -and !$connected; $i++) {
  Start-Sleep -Seconds 1
  if (!(Get-Process -Id $runningId -ErrorAction SilentlyContinue)) {
    $message = if (Test-Path $errLog) { Get-Content -Raw $errLog } else { 'cloudflared exited.' }
    throw $message
  }
  $logs = @($outLog, $errLog) | Where-Object { Test-Path $_ } | ForEach-Object { Get-Content -Raw $_ }
  $match = [regex]::Match(($logs -join "`n"), 'https://[a-z0-9-]+\.trycloudflare\.com')
  if ($match.Success) { $url = $match.Value }
  $connected = ($logs -join "`n") -match 'Registered tunnel connection'
}
if (!$url -or !$connected) { throw "Tunnel did not connect after 90 seconds. Check $errLog" }

Set-Content -LiteralPath $urlFile -Value $url -Encoding utf8
New-Item -ItemType Directory -Path $desktopDir -Force | Out-Null
Set-Content -LiteralPath $desktopUrlFile -Encoding utf8 -Value @(
  'Current public URL:'
  $url
  ''
  "Generated: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
  'The URL changes whenever the public tunnel restarts. Use this file as the source of truth.'
)
Add-Content -LiteralPath $desktopHistoryFile -Encoding utf8 -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')`t$url"
Write-Host "Public URL: $url" -ForegroundColor Green
Write-Host "Saved to: $desktopUrlFile"

$publicReady = $false
for ($i = 0; $i -lt 10 -and !$publicReady; $i++) {
  try { $publicReady = (Invoke-WebRequest -UseBasicParsing "$url/api/health" -TimeoutSec 4).StatusCode -eq 200 }
  catch { $publicReady = $false }
  if (!$publicReady) { Start-Sleep -Seconds 1 }
}
if ($publicReady) { Start-Process $url }
else { Write-Warning 'The tunnel is running, but DNS is still updating. Wait a minute and open the URL from the TXT file.' }
