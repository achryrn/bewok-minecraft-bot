param([switch]$Smoke)
$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
Set-Location $Root

Write-Host ""
Write-Host "================================================================"
Write-Host "  minecraft-bot  -  launcher"
Write-Host "================================================================"

# 1. Node.js present?
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Host ""
    Write-Host "[ERROR] Node.js was not found." -ForegroundColor Red
    Write-Host "        Install the LTS version from https://nodejs.org , then run this launcher again." -ForegroundColor Yellow
    exit 1
}
Write-Host "[ok] Node.js " (node --version)

# 2. npm present?
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Host "[ERROR] npm was not found in PATH." -ForegroundColor Red
    exit 1
}

# 3. Dependencies installed? (first run only)
if (-not (Test-Path "$Root\node_modules\mineflayer")) {
    Write-Host ""
    Write-Host "[..] Installing dependencies (first run only - may take a few minutes)..." -ForegroundColor Cyan
    & npm install --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[ERROR] npm install failed. Check the messages above." -ForegroundColor Red
        exit 1
    }
    Write-Host "[ok] dependencies installed."
} else {
    Write-Host "[ok] dependencies present."
}

# 4. Runtime folders (bot state + logs stay out of the project root)
New-Item -ItemType Directory -Force -Path "$Root\data" | Out-Null
New-Item -ItemType Directory -Force -Path "$Root\logs" | Out-Null

# 5. Smoke mode: config + server ping self-check, no connection
if ($Smoke) {
    Write-Host ""
    Write-Host "[..] smoke check: config + server version ping (does not connect)..." -ForegroundColor Cyan
    & node "$Root\index.js" --smoke
    $code = $LASTEXITCODE
    if ($code -eq 0) {
        Write-Host "[ok] smoke check passed." -ForegroundColor Green
    } else {
        Write-Host "[ERROR] smoke check failed (exit $code)." -ForegroundColor Red
    }
    exit $code
}

# 6. Run the bot
Write-Host ""
Write-Host "[..] Starting bot - press Ctrl+C to stop it." -ForegroundColor Cyan
Write-Host "     latest log: $Root\logs\bot.log"
Write-Host ""
& node "$Root\index.js" 2>&1 | Tee-Object -FilePath "$Root\logs\bot.log"
$code = $LASTEXITCODE
Write-Host ""
if ($code -eq 0) {
    Write-Host "[ok] Bot exited cleanly." -ForegroundColor Green
} else {
    Write-Host "[ERROR] Bot exited with code $code - see logs\bot.log" -ForegroundColor Red
}
exit $code
