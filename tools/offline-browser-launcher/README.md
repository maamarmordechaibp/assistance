# Offline Browser Launcher

A tiny background service that runs on the rep's PC and lets the Offline
dashboard open **real Chrome windows** in **per-customer profiles** —
no iframe, no Browserbase, full speed, full size.

Each customer gets their own isolated profile under
`%LOCALAPPDATA%\OfflineBrowser\Profiles\customer-<id>`, so logins, cookies,
saved passwords, and history stay separate per customer and persist across
sessions.

## Install (one-time, per rep)

1. Open **PowerShell** in this folder.
2. Run:
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\install.ps1
   ```
3. Done. It runs hidden at every login.

## Verify

Open http://localhost:17345/health in any browser — you should see
`{"ok":true,"version":"1.0"}`.

## Uninstall

```powershell
Remove-Item "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\OfflineBrowserLauncher.lnk" -ErrorAction SilentlyContinue
Remove-Item "$env:LOCALAPPDATA\OfflineBrowser" -Recurse -Force -ErrorAction SilentlyContinue
# Then sign out / sign back in to stop the running instance, or kill wscript.exe in Task Manager.
```

## Security

- Only listens on `127.0.0.1` (not network-visible).
- Only accepts requests from the configured Vercel/localhost origins
  (CORS allow-list in `launcher.ps1`).
- URLs must start with `http://`, `https://` or `about:` — no `file:`,
  no `javascript:`, no shell escapes.
- Profile names are sanitised to `[A-Za-z0-9_-]` only.
