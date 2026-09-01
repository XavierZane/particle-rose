$ErrorActionPreference = "Stop"

$RootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PidFile = Join-Path $RootDir ".particle-rose.pid"

if (-not (Test-Path $PidFile)) {
    Write-Host "Particle Rose is not managed by the launcher."
    exit 0
}

$pidText = (Get-Content $PidFile -First 1 -ErrorAction SilentlyContinue).Trim()
if ($pidText -notmatch "^\d+$") {
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    Write-Host "Particle Rose launcher state was reset."
    exit 0
}

$managedPid = [int]$pidText
$process = Get-Process -Id $managedPid -ErrorAction SilentlyContinue
if ($process) {
    $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $managedPid" -ErrorAction SilentlyContinue
    $commandLine = if ($processInfo) { $processInfo.CommandLine } else { "" }
    if ($commandLine -match 'npm(?:\.cmd)?\W+run\s+dev|npm-cli\.js\W+run\s+dev|vite') {
        & taskkill.exe /PID $managedPid /T /F *> $null
    } else {
        Write-Warning "PID $managedPid does not look like the Particle Rose dev server; it was not terminated."
    }
}

Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
Write-Host "Particle Rose stopped."
