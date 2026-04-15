// AES-256-GCM encryption for the password vault (Deno-compatible, Web Crypto API)

const ALGORITHM = 'AES-GCM';
const KEY_LENGTH = 256;
const IV_LENGTH = 12;
const TAG_LENGTH = 128;

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes;
}

async function getEncryptionKey(): Promise<CryptoKey> {
  const rawKey = Deno.env.get('VAULT_ENCRYPTION_KEY');
  if (!rawKey) throw new Error('VAULT_ENCRYPTION_KEY is not set');
  const keyBytes = hexToBytes(rawKey.padEnd(64, '0').slice(0, 64));
  return crypto.subtle.importKey('raw', keyBytes.buffer as ArrayBuffer, { name: ALGORITHM, length: KEY_LENGTH }, false, ['encrypt', 'decrypt']);
}

export async function encrypt(plaintext: string): Promise<Uint8Array> {
  const key = await getEncryptionKey();
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt({ name: ALGORITHM, iv, tagLength: TAG_LENGTH }, key, encoded);
  const result = new Uint8Array(IV_LENGTH + ciphertext.byteLength);
  result.set(iv, 0);
  result.set(new Uint8Array(ciphertext), IV_LENGTH);
  return result;
}

export async function decrypt(encryptedData: Uint8Array): Promise<string> {
  const key = await getEncryptionKey();
  const iv = encryptedData.slice(0, IV_LENGTH);
  const ciphertext = encryptedData.slice(IV_LENGTH);
  const decrypted = await crypto.subtle.decrypt({ name: ALGORITHM, iv, tagLength: TAG_LENGTH }, key, ciphertext);
  return new TextDecoder().decode(decrypted);
}
