# Offline Browser Launcher — runs in background on the rep's PC.
# Listens on http://localhost:17345 and opens real Chrome windows in
# isolated per-customer profiles when the dashboard asks it to.
#
# Usage:
#   .\launcher.ps1                 # run in the foreground (Ctrl+C to stop)
#   .\install.ps1                  # install + auto-start at login

$port = 17345
$base = Join-Path $env:LOCALAPPDATA 'OfflineBrowser\Profiles'
New-Item -ItemType Directory -Force -Path $base | Out-Null

# Allow only the production app + localhost dev to talk to us.
$AllowedOrigins = @(
  'https://assistance-six.vercel.app',
  'https://offlinesbrowse.com',
  'http://localhost:3000',
  'http://127.0.0.1:3000'
)

function Find-Browser {
  $candidates = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
  )
  foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
  return $null
}

$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add("http://127.0.0.1:$port/")
$listener.Prefixes.Add("http://localhost:$port/")
try {
  $listener.Start()
} catch {
  Write-Host "Failed to bind port $port. Is another instance already running?" -ForegroundColor Red
  exit 1
}
Write-Host "Offline Browser Launcher listening on http://localhost:$port" -ForegroundColor Green
Write-Host "Profile root: $base"
$browser = Find-Browser
if (-not $browser) {
  Write-Host "WARNING: Chrome/Edge not found in standard locations." -ForegroundColor Yellow
} else {
  Write-Host "Browser: $browser"
}

while ($listener.IsListening) {
  try {
    $ctx = $listener.GetContext()
  } catch { break }
  $req = $ctx.Request
  $res = $ctx.Response
  try {
    $origin = $req.Headers['Origin']
    if ($origin -and ($AllowedOrigins -contains $origin)) {
      $res.Headers.Add('Access-Control-Allow-Origin', $origin)
      $res.Headers.Add('Vary', 'Origin')
    } else {
      $res.Headers.Add('Access-Control-Allow-Origin', 'null')
    }
    $res.Headers.Add('Access-Control-Allow-Headers', 'content-type')
    $res.Headers.Add('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')

    if ($req.HttpMethod -eq 'OPTIONS') {
      $res.StatusCode = 204
    }
    elseif ($req.Url.AbsolutePath -eq '/health') {
      $body = '{"ok":true,"version":"1.0"}'
      $b = [Text.Encoding]::UTF8.GetBytes($body)
      $res.ContentType = 'application/json'; $res.OutputStream.Write($b, 0, $b.Length)
    }
    elseif ($req.Url.AbsolutePath -eq '/open' -and $req.HttpMethod -eq 'POST') {
      $reader = [IO.StreamReader]::new($req.InputStream)
      $raw = $reader.ReadToEnd()
      $payload = $raw | ConvertFrom-Json
      $profile = ([string]$payload.profile) -replace '[^A-Za-z0-9_-]', '_'
      if (-not $profile) { throw 'profile required' }
      $url = [string]$payload.url
      if (-not $url) { $url = 'about:blank' }
      if ($url -notmatch '^(https?://|about:)') { throw 'invalid url scheme' }
      $b = Find-Browser
      if (-not $b) { throw 'Chrome or Edge not found on this PC' }
      $profileDir = Join-Path $base $profile
      New-Item -ItemType Directory -Force -Path $profileDir | Out-Null
      Start-Process -FilePath $b -ArgumentList @("--user-data-dir=$profileDir", '--new-window', $url) | Out-Null
      Write-Host "[open] profile=$profile url=$url" -ForegroundColor Cyan
      $body = '{"ok":true,"profile":"' + $profile + '"}'
      $b2 = [Text.Encoding]::UTF8.GetBytes($body)
      $res.ContentType = 'application/json'; $res.OutputStream.Write($b2, 0, $b2.Length)
    }
    else {
      $res.StatusCode = 404
    }
  } catch {
    $res.StatusCode = 500
    $body = (@{error = "$_"} | ConvertTo-Json -Compress)
    $b = [Text.Encoding]::UTF8.GetBytes($body)
    try { $res.OutputStream.Write($b, 0, $b.Length) } catch { }
    Write-Host "[error] $_" -ForegroundColor Red
  } finally {
    try { $res.Close() } catch { }
  }
}
