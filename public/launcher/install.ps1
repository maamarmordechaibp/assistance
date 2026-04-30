# Offline Browser Launcher — one-line installer
#
# Reps run this from PowerShell with:
#   irm https://offlinesbrowse.com/launcher/install.ps1 | iex
#
# It downloads launcher.ps1 from the SAME origin this script came from,
# installs it under %LOCALAPPDATA%\OfflineBrowser, registers a hidden
# auto-start shortcut, and starts the listener immediately.

$ErrorActionPreference = 'Stop'

# Resolve the base URL we were fetched from. PSCommandPath is null when
# piped via `iex`, so we fall back to the dashboard's production origin.
function Resolve-BaseUrl {
  $candidates = @(
    $env:OFFLINE_LAUNCHER_BASE,
    'https://offlinesbrowse.com/launcher',
    'https://assistance-six.vercel.app/launcher'
  ) | Where-Object { $_ }
  foreach ($u in $candidates) {
    try {
      $probe = Invoke-WebRequest -Uri "$u/launcher.ps1" -Method Head -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop
      if ($probe.StatusCode -eq 200) { return $u }
    } catch { }
  }
  throw 'Could not reach launcher download URL. Check internet connection.'
}

$base = Resolve-BaseUrl
$dest = Join-Path $env:LOCALAPPDATA 'OfflineBrowser'
New-Item -ItemType Directory -Force -Path $dest | Out-Null

Write-Host 'Offline Browser Launcher — installer' -ForegroundColor Cyan
Write-Host "Source: $base"
Write-Host "Target: $dest"
Write-Host ''

# Stop any prior instance before overwriting files (best-effort).
try {
  Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='wscript.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like '*OfflineBrowser*launcher.ps1*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
} catch { }

Write-Host 'Downloading launcher.ps1 ...' -ForegroundColor DarkGray
Invoke-WebRequest -Uri "$base/launcher.ps1" -OutFile (Join-Path $dest 'launcher.ps1') -UseBasicParsing -ErrorAction Stop

# Hidden VBS runner so PowerShell doesn't flash a console window at login.
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

Write-Host "Auto-start shortcut: $lnk" -ForegroundColor Green
Write-Host 'Starting launcher ...' -ForegroundColor Cyan
Start-Process -FilePath 'wscript.exe' -ArgumentList "`"$runnerVbs`"" -WindowStyle Hidden

# Poll /health for up to ~10s before declaring success.
$ok = $false
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Milliseconds 500
  try {
    $h = Invoke-RestMethod -Uri 'http://localhost:17345/health' -TimeoutSec 2 -ErrorAction Stop
    if ($h.ok) { $ok = $true; break }
  } catch { }
}

if ($ok) {
  Write-Host ''
  Write-Host '  Done. You can close this window and return to the dashboard.' -ForegroundColor Green
  Write-Host '  The launcher will now auto-start every time you sign in.' -ForegroundColor Green
} else {
  Write-Host ''
  Write-Host '  Installed, but the health check did not respond.' -ForegroundColor Yellow
  Write-Host "  Check $dest\launcher.ps1 — sign out / sign in to retry." -ForegroundColor Yellow
}
