#Requires -RunAsAdministrator
<#
.SYNOPSIS
    AURA Satellite Agent Windows Service Installer
    Called by the bootstrap agent's POST /upgrade after extracting the satellite package.
#>

$ErrorActionPreference = "Stop"
$AgentDir  = "C:\Program Files\AURA\SatelliteAgent"
$MainPy    = "$AgentDir\main.py"
$PythonExe = (Get-Command python -ErrorAction SilentlyContinue)?.Source

if (-not $PythonExe) {
    Write-Error "Python not found on PATH"
    exit 1
}

# Remove existing AURASatellite service if present
$existing = Get-Service "AURASatellite" -ErrorAction SilentlyContinue
if ($existing) {
    if ($existing.Status -eq "Running") {
        nssm stop AURASatellite confirm 2>$null
        Start-Sleep 2
    }
    nssm remove AURASatellite confirm 2>$null
    Start-Sleep 1
}

# Also stop bootstrap if still running
$bootstrap = Get-Service "AURABootstrap" -ErrorAction SilentlyContinue
if ($bootstrap -and $bootstrap.Status -eq "Running") {
    nssm stop AURABootstrap confirm 2>$null
}

# Register satellite agent service
$nssmAvailable = $null -ne (Get-Command nssm -ErrorAction SilentlyContinue)
if ($nssmAvailable) {
    nssm install AURASatellite "$PythonExe" "`"$MainPy`""
    nssm set AURASatellite AppDirectory $AgentDir
    nssm set AURASatellite DisplayName "AURA Satellite Agent"
    nssm set AURASatellite Description "AURA permanent inference node on port 7779"
    nssm set AURASatellite Start SERVICE_AUTO_START
} else {
    sc.exe create AURASatellite binPath= "`"$PythonExe`" `"$MainPy`"" start= auto
}

# Open firewall for port 7779
Remove-NetFirewallRule -DisplayName "AURA Satellite Agent" -ErrorAction SilentlyContinue
New-NetFirewallRule `
    -DisplayName "AURA Satellite Agent" `
    -Direction Inbound `
    -Protocol TCP `
    -LocalPort 7779 `
    -RemoteAddress LocalSubnet `
    -Action Allow | Out-Null

# Start the service
if ($nssmAvailable) {
    nssm start AURASatellite
} else {
    sc.exe start AURASatellite
}

# Remove bootstrap service
if ($nssmAvailable) {
    nssm remove AURABootstrap confirm 2>$null
} else {
    sc.exe delete AURABootstrap 2>$null
}

Write-Host "AURASatellite service installed and started on port 7779"
