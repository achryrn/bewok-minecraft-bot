$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot

# Jest cannot resolve test paths reliably when the project sits on a mapped
# network drive (Z:) - known Node/Windows UNC quirk. So we run the suite from a
# local copy under %LOCALAPPDATA%. Sources are re-copied on every run; the
# node_modules install is done once.

$Local = Join-Path $env:LOCALAPPDATA 'minecraft-bot-tests'
New-Item -ItemType Directory -Force -Path $Local | Out-Null

Write-Host ""
Write-Host "================================================================"
Write-Host "  minecraft-bot  -  test runner"
Write-Host "================================================================"
Write-Host "[..] preparing local test copy at  $Local"
robocopy "$Root\src"  "$Local\src"  /E /NFL /NDL /NJH /NJS /NP | Out-Null
robocopy "$Root\tests" "$Local\tests" /E /NFL /NDL /NJH /NJS /NP | Out-Null
Copy-Item "$Root\package.json"      "$Local\package.json" -Force
Copy-Item "$Root\package-lock.json" "$Local\package-lock.json" -Force
Copy-Item "$Root\jest.config.js"    "$Local\jest.config.js" -Force

if (-not (Test-Path "$Local\node_modules\mineflayer")) {
    Write-Host "[..] installing dependencies for tests (first run only)..." -ForegroundColor Cyan
    Push-Location $Local
    & npm install --no-audit --no-fund
    $installCode = $LASTEXITCODE
    Pop-Location
    if ($installCode -ne 0) {
        Write-Host "[ERROR] npm install failed." -ForegroundColor Red
        exit 1
    }
}

Write-Host ""
Write-Host "[..] running unit tests..." -ForegroundColor Cyan
Write-Host ""
Push-Location $Local
& node node_modules\jest\bin\jest.js --config jest.config.js --runInBand
$code = $LASTEXITCODE
Pop-Location
Write-Host ""
if ($code -eq 0) {
    Write-Host "[ok] all tests passed." -ForegroundColor Green
} else {
    Write-Host "[ERROR] $code test(s) failed - see details above." -ForegroundColor Red
}
exit $code
