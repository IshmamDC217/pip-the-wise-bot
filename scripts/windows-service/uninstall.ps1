param(
    [string]$ServiceName = 'ForgeRealmPip'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$principal = [Security.Principal.WindowsPrincipal]([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)) {
    Write-Host 'Elevating to administrator...'
    $passthru = @('-NoProfile','-ExecutionPolicy','Bypass','-File',"`"$PSCommandPath`"")
    if ($ServiceName -ne 'ForgeRealmPip') { $passthru += @('-ServiceName',$ServiceName) }
    $elevated = Start-Process powershell -ArgumentList $passthru -Verb RunAs -Wait -PassThru
    exit $elevated.ExitCode
}

$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if (-not $existing) {
    Write-Host "Service '$ServiceName' is not installed - nothing to do."
    exit 0
}

Write-Host "Stopping service '$ServiceName'..."
Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue

Write-Host "Removing service..."
sc.exe delete $ServiceName | Out-Null

Write-Host "Done."
