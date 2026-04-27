# Chrome Password Capture Helper

Tiny .NET console app the launcher runs after Chrome exits. Reads
`<profileDir>\Default\Login Data` (a SQLite file) and `<profileDir>\Default\Local State`,
DPAPI-decrypts the AES key, AES-GCM-decrypts each saved password,
and prints the credentials as JSON to stdout for the launcher to POST
to the `customer-browser-profile` `capture-credentials` endpoint.

## Why a separate exe instead of inline PowerShell

PowerShell can call DPAPI, but doing AES-GCM + reading SQLite reliably
on every Windows version is much easier with .NET 8. This keeps the
launcher itself short.

## Build

```powershell
cd tools/chrome-credential-capture
dotnet publish -c Release -r win-x64 --self-contained false -o ../offline-browser-launcher/bin
```

Drop the resulting `chrome-credential-capture.exe` next to `launcher.ps1`.
The launcher auto-detects it.

## Output

JSON object on stdout:

```json
{
  "ok": true,
  "credentials": [
    {
      "origin_url": "https://www.amazon.com",
      "signon_realm": "https://www.amazon.com/",
      "username": "user@example.com",
      "password": "..."
    }
  ]
}
```

Errors:
```json
{ "ok": false, "error": "..." }
```
