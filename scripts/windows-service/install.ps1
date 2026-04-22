param(
    [string]$ServiceName = 'ForgeRealmPip',
    [string]$NssmPath    = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Self-elevate: service install writes to the SCM and needs admin.
$principal = [Security.Principal.WindowsPrincipal]([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)) {
    Write-Host 'Elevating to administrator...'
    $passthru = @('-NoProfile','-ExecutionPolicy','Bypass','-File',"`"$PSCommandPath`"")
    if ($ServiceName -ne 'ForgeRealmPip') { $passthru += @('-ServiceName',$ServiceName) }
    if ($NssmPath)                        { $passthru += @('-NssmPath',$NssmPath) }
    Start-Process powershell -ArgumentList $passthru -Verb RunAs
    exit
}

$repoRoot   = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$distEntry  = Join-Path $repoRoot 'dist\index.js'
$envFile    = Join-Path $repoRoot '.env'
$logsDir    = Join-Path $repoRoot 'logs'

if (-not (Test-Path $distEntry)) {
    throw "Build not found at $distEntry. Run 'npm run build' in $repoRoot first."
}
if (-not (Test-Path $envFile)) {
    throw ".env not found at $envFile. Populate it with Discord token etc. before installing the service."
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw 'node not found on PATH.' }
$nodePath = $node.Source

if (-not $NssmPath) {
    $candidates = @(
        $env:NSSM,
        (Get-Command nssm -ErrorAction SilentlyContinue | ForEach-Object Source),
        'A:\Claude\nssm.exe',
        'C:\ProgramData\chocolatey\bin\nssm.exe'
    ) | Where-Object { $_ -and (Test-Path $_) }
    if (-not $candidates -or $candidates.Count -eq 0) {
        throw "nssm.exe not found. Download from https://nssm.cc/download, drop nssm.exe somewhere on PATH (or pass -NssmPath)."
    }
    $NssmPath = $candidates[0]
}

Write-Host "Using node:     $nodePath"
Write-Host "Using nssm:     $NssmPath"
Write-Host "Repo root:      $repoRoot"
Write-Host "Service name:   $ServiceName"

New-Item -ItemType Directory -Force -Path $logsDir | Out-Null

$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Service already exists — stopping and reconfiguring..."
    & $NssmPath stop $ServiceName | Out-Null
} else {
    Write-Host "Installing service..."
    & $NssmPath install $ServiceName $nodePath $distEntry | Out-Null
}

& $NssmPath set $ServiceName Application      $nodePath                                  | Out-Null
& $NssmPath set $ServiceName AppParameters    $distEntry                                 | Out-Null
& $NssmPath set $ServiceName AppDirectory     $repoRoot                                  | Out-Null
& $NssmPath set $ServiceName DisplayName      'ForgeRealm Pip Bot'                       | Out-Null
& $NssmPath set $ServiceName Description      'Discord bot that monitors forgerealm.co.uk' | Out-Null
& $NssmPath set $ServiceName Start            SERVICE_AUTO_START                         | Out-Null
& $NssmPath set $ServiceName AppStdout        (Join-Path $logsDir 'stdout.log')          | Out-Null
& $NssmPath set $ServiceName AppStderr        (Join-Path $logsDir 'stderr.log')          | Out-Null
& $NssmPath set $ServiceName AppRotateFiles   1                                          | Out-Null
& $NssmPath set $ServiceName AppRotateBytes   10485760                                   | Out-Null
& $NssmPath set $ServiceName AppExit          Default Restart                            | Out-Null
& $NssmPath set $ServiceName AppRestartDelay  5000                                       | Out-Null

Write-Host 'Starting service...'
& $NssmPath start $ServiceName | Out-Null

Write-Host ''
Write-Host "Service '$ServiceName' is installed, set to auto-start on boot, and running."
Write-Host "Logs:   $logsDir"
Write-Host "Manage: services.msc or 'nssm restart|stop|edit|status $ServiceName'"
