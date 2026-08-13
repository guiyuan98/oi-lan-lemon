param(
  [Parameter(Mandatory = $true)][string]$QtPrefix,
  [string]$Source = '',
  [string]$CompilerDir = ''
)
$ErrorActionPreference = 'Stop'
if (!$Source) { $Source = Join-Path $PSScriptRoot '.build\Project_LemonLime' }
$sourcePath = [IO.Path]::GetFullPath($Source)
$bridgePath = Join-Path $sourcePath 'tools\lemon-headless'
$buildPath = Join-Path $sourcePath $(if ($CompilerDir) { 'build-headless-matching-qt' } else { 'build-headless' })

if (!(Test-Path $sourcePath)) {
  git clone --depth 1 --recursive https://github.com/Project-LemonLime/Project_LemonLime.git $sourcePath
}
New-Item -ItemType Directory -Force $bridgePath | Out-Null
Copy-Item (Join-Path $PSScriptRoot 'lemon-worker\main.cpp') $bridgePath -Force
Copy-Item (Join-Path $PSScriptRoot 'lemon-worker\CMakeLists.txt') $bridgePath -Force

$rootCmake = Join-Path $sourcePath 'CMakeLists.txt'
$cmakeText = Get-Content -Raw $rootCmake
if ($cmakeText -notmatch 'add_subdirectory\(tools/lemon-headless\)') {
  Add-Content $rootCmake "`nadd_subdirectory(tools/lemon-headless)`n"
}

$compilerOption = @()
if ($CompilerDir) {
  $compiler = Join-Path $CompilerDir 'g++.exe'
  if (!(Test-Path $compiler)) { throw "g++.exe not found in $CompilerDir" }
  $compilerOption = "-DCMAKE_CXX_COMPILER=$compiler"
}
cmake -S $sourcePath -B $buildPath -GNinja '-DCMAKE_BUILD_TYPE=Release' "-DCMAKE_PREFIX_PATH=$QtPrefix" '-DEMBED_DOCS=OFF' $compilerOption
cmake --build $buildPath --target lemon-headless

$exe = Get-ChildItem $buildPath -Filter lemon-headless.exe -Recurse | Select-Object -First 1
if (!$exe) { throw 'lemon-headless.exe was not generated' }
$bin = Join-Path $PSScriptRoot 'bin'
New-Item -ItemType Directory -Force $bin | Out-Null
Copy-Item $exe.FullName $bin -Force
$deploy = Get-ChildItem $QtPrefix -Filter windeployqt.exe -Recurse | Select-Object -First 1
if ($deploy) { & $deploy.FullName (Join-Path $bin 'lemon-headless.exe') --release --no-translations }
if ($CompilerDir) {
  'libgcc_s_seh-1.dll','libstdc++-6.dll','libwinpthread-1.dll' | ForEach-Object {
    $runtime = Join-Path $CompilerDir $_
    if (Test-Path $runtime) { Copy-Item $runtime $bin -Force }
  }
}
Write-Host "Lemon worker ready: $(Join-Path $bin 'lemon-headless.exe')" -ForegroundColor Green
