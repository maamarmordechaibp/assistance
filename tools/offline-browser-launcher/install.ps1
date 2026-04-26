# Installs Offline Browser Launcher to %LOCALAPPDATA%\OfflineBrowser
# and creates a Startup shortcut that runs it hidden at login.

$ErrorActionPreference = 'Stop'
$dest = Join-Path $env:LOCALAPPDATA 'OfflineBrowser'
New-Item -ItemType Directory -Force -Path $dest | Out-Null

Copy-Item -Path "$PSScriptRoot\launcher.ps1" -Destination "$dest\launcher.ps1" -Force

# Hidden runner so PowerShell doesn't flash a console at login.
$runnerVbs = Join-Path $dest 'run-hidden.vbs'
@'
Set sh = CreateObject("WScript.Shell")
sh.Run "powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName) & "\launcher.ps1""", 0, False
'@ | Set-Content -Path $runnerVbs -Encoding ASCII

$startup = [Environment]::GetFolderPath('Startup')
$lnk = Join-Path $startup 'OfflineBrowserLauncher.lnk'
$ws = New-Object -ComObject WScript.Shell
$shortcut = $ws.CreateShortcut($lnk)
$shortcut.TargetPath = 'wscript.exe'
$shortcut.Arguments = '"' + $runnerVbs + '"'
$shortcut.WorkingDirectory = $dest
$shortcut.WindowStyle = 7  # minimized
$shortcut.Description = 'Offline Browser Launcher (per-customer Chrome profiles)'
$shortcut.Save()

Write-Host "Installed to: $dest" -ForegroundColor Green
Write-Host "Auto-start shortcut: $lnk" -ForegroundColor Green
Write-Host ""
Write-Host "Starting now..." -ForegroundColor Cyan
Start-Process -FilePath 'wscript.exe' -ArgumentList "`"$runnerVbs`"" -WindowStyle Hidden
Start-Sleep -Seconds 1

try {
  $h = Invoke-RestMethod -Uri 'http://localhost:17345/health' -TimeoutSec 3
  Write-Host "Launcher is running: $($h | ConvertTo-Json -Compress)" -ForegroundColor Green
} catch {
  Write-Host "Could not reach http://localhost:17345/health yet — give it a moment." -ForegroundColor Yellow
}
