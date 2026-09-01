$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$RootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Port = if ($env:PARTICLE_ROSE_PORT) { $env:PARTICLE_ROSE_PORT } else { "5174" }
$Url = "http://localhost:$Port/"
$PidFile = Join-Path $RootDir ".particle-rose.pid"
$LogFile = Join-Path $RootDir ".particle-rose.log"
$ErrorLogFile = Join-Path $RootDir ".particle-rose.error.log"

function Test-ProjectPage {
    try {
        $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 1
        return $response.StatusCode -eq 200 -and $response.Content -match "/src/main.tsx"
    } catch {
        return $false
    }
}

function Open-ProjectPage {
    $chromeCandidates = @(
        (Join-Path ${env:ProgramFiles} "Google\Chrome\Application\chrome.exe"),
        (Join-Path ${env:ProgramFiles(x86)} "Google\Chrome\Application\chrome.exe"),
        (Join-Path ${env:LocalAppData} "Google\Chrome\Application\chrome.exe")
    )
    $chrome = $chromeCandidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
    if ($chrome) {
        Start-Process -FilePath $chrome -ArgumentList "--new-window", $Url | Out-Null
    } else {
        Start-Process $Url | Out-Null
    }
}

if (Test-Path $PidFile) {
    $existingPid = (Get-Content $PidFile -First 1 -ErrorAction SilentlyContinue).Trim()
    $existingProcess = $null
    if ($existingPid -match "^\d+$") {
        $existingProcess = Get-Process -Id ([int]$existingPid) -ErrorAction SilentlyContinue
    }
    if ($existingProcess -and (Test-ProjectPage)) {
        Open-ProjectPage
        exit 0
    }
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
}

if (Test-ProjectPage) {
    Open-ProjectPage
    exit 0
}

if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
    Write-Error "npm was not found. Install Node.js first."
    exit 1
}

$process = Start-Process -FilePath "npm.cmd" `
    -ArgumentList "run", "dev", "--", "--host", "127.0.0.1", "--port", $Port `
    -WorkingDirectory $RootDir `
    -RedirectStandardOutput $LogFile `
    -RedirectStandardError $ErrorLogFile `
    -WindowStyle Hidden `
    -PassThru
$process.Id | Set-Content -Path $PidFile -Encoding ascii

for ($attempt = 0; $attempt -lt 60; $attempt++) {
    if (Test-ProjectPage) {
        Open-ProjectPage
        exit 0
    }
    $process.Refresh()
    if ($process.HasExited) {
        Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
        Write-Error "Particle Rose stopped during startup. Check .particle-rose.log and .particle-rose.error.log."
        exit 1
    }
    Start-Sleep -Milliseconds 250
}

if (-not $process.HasExited) {
    & taskkill.exe /PID $process.Id /T /F *> $null
}
Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
Write-Error "Particle Rose did not become ready. Check .particle-rose.log and .particle-rose.error.log."
exit 1
