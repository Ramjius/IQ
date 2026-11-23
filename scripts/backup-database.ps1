param(
    [string]$OutputDirectory = (Join-Path (Split-Path -Parent $PSScriptRoot) 'backups')
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $projectRoot '.env'

if (-not (Get-Command pg_dump -ErrorAction SilentlyContinue)) {
    throw 'pg_dump was not found. Install PostgreSQL command-line tools and add their bin folder to PATH.'
}
if (-not (Test-Path $envFile)) {
    throw 'Missing .env. Set DATABASE_URL before creating a backup.'
}

$line = Get-Content $envFile | Where-Object { $_ -match '^\s*DATABASE_URL\s*=' } | Select-Object -First 1
$databaseUrl = if ($line) { ($line -split '=', 2)[1].Trim().Trim('"').Trim("'") } else { '' }
if ([string]::IsNullOrWhiteSpace($databaseUrl)) {
    throw 'Set a non-empty DATABASE_URL in .env before creating a backup.'
}

$pgVariableNames = @('PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGCONNECT_TIMEOUT', 'PGSSLMODE')
$previousPgValues = @{}
foreach ($name in $pgVariableNames) {
    $previousPgValues[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}

try {
    $uri = [Uri]$databaseUrl
    if ($uri.Scheme -notin @('postgres', 'postgresql')) {
        throw 'DATABASE_URL must be a PostgreSQL connection URL.'
    }

    $userInfo = $uri.UserInfo -split ':', 2
    if ($userInfo.Count -ne 2) {
        throw 'DATABASE_URL must include a PostgreSQL username and password.'
    }

    $env:PGHOST = $uri.Host
    $env:PGPORT = if ($uri.IsDefaultPort -or $uri.Port -lt 1) { '5432' } else { [string]$uri.Port }
    $env:PGUSER = [Uri]::UnescapeDataString($userInfo[0])
    $env:PGPASSWORD = [Uri]::UnescapeDataString($userInfo[1])
    $env:PGDATABASE = [Uri]::UnescapeDataString($uri.AbsolutePath.TrimStart('/'))
    $env:PGCONNECT_TIMEOUT = '15'

    if ($uri.Query -match '(?:^\?|&)sslmode=([^&]+)') {
        $env:PGSSLMODE = [Uri]::UnescapeDataString($Matches[1])
    }

    New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
    $timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $backupFile = Join-Path $OutputDirectory "invoicing-$timestamp.backup"

    & pg_dump --format=custom --no-owner --no-acl --no-password --file $backupFile
    if ($LASTEXITCODE -ne 0) {
        Remove-Item -LiteralPath $backupFile -Force -ErrorAction SilentlyContinue
        throw 'pg_dump failed. The backup file was removed; check the database connection and PostgreSQL tools.'
    }

    Write-Host "Database backup created: $backupFile"
    Write-Host 'This file contains financial data. Keep it private and copy it to a separate backup location.'
}
finally {
    foreach ($name in $pgVariableNames) {
        [Environment]::SetEnvironmentVariable($name, $previousPgValues[$name], 'Process')
    }
}
