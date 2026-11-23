$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Push-Location $projectRoot

try {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        throw 'Node.js was not found. Install the current Node.js LTS release, then reopen PowerShell.'
    }
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        throw 'npm was not found. Reinstall Node.js with npm included, then reopen PowerShell.'
    }

    $envFile = Join-Path $projectRoot '.env'
    if (-not (Test-Path $envFile)) {
        throw 'Missing .env. Copy .env.example to .env and fill in DATABASE_URL and SESSION_SECRET.'
    }

    $envLines = Get-Content $envFile
    foreach ($name in @('DATABASE_URL', 'SESSION_SECRET', 'HOST')) {
        $line = $envLines | Where-Object { $_ -match "^\s*$name\s*=" } | Select-Object -First 1
        $value = if ($line) { ($line -split '=', 2)[1].Trim().Trim('"').Trim("'") } else { '' }
        if ([string]::IsNullOrWhiteSpace($value)) {
            throw "Set a non-empty $name in .env before starting the app."
        }
    }

    if (-not (Test-Path (Join-Path $projectRoot 'node_modules'))) {
        Write-Host 'Installing project dependencies...'
        & npm ci
        if ($LASTEXITCODE -ne 0) {
            throw 'Dependency installation failed.'
        }
    }

    Write-Host 'Starting the app. Keep this window open while using it.'
    & npm start
    if ($LASTEXITCODE -ne 0) {
        throw 'The app stopped with an error. Review the messages above.'
    }
}
finally {
    Pop-Location
}
