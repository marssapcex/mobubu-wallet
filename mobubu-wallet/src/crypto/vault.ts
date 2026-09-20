/**
 * Obsidian Encrypted Keyring Vault
 * PBKDF2 (SHA-256, 100,000 iterations) + AES-256-GCM
 */

export interface EncryptedVault {
  version: number;
  saltHex: string;
  ivHex: string;
  cipherHex: string;
}

function buf2hex(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function hex2buf(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < clean.length; i += 2) {
    bytes[i / 2] = parseInt(clean.substring(i, i + 2), 16);
  }
  return bytes;
}

export async function encryptVault<T>(data: T, password: string): Promise<EncryptedVault> {
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const baseKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  const aesKey = await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt as any,
      iterations: 100_000,
      hash: 'SHA-256',
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );

  const plaintext = enc.encode(JSON.stringify(data));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: iv as any,
    },
    aesKey,
    plaintext as any
  );

  return {
    version: 1,
    saltHex: buf2hex(salt),
    ivHex: buf2hex(iv),
    cipherHex: buf2hex(ciphertext),
  };
}

export async function decryptVault<T>(vault: EncryptedVault, password: string): Promise<T> {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const salt = hex2buf(vault.saltHex);
  const iv = hex2buf(vault.ivHex);
  const ciphertext = hex2buf(vault.cipherHex);

  const baseKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  const aesKey = await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt as any,
      iterations: 100_000,
      hash: 'SHA-256',
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );

  try {
    const decrypted = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: iv as any,
      },
      aesKey,
      ciphertext as any
    );

    const jsonStr = dec.decode(decrypted);
    return JSON.parse(jsonStr) as T;
  } catch {
    throw new Error('Incorrect password or corrupted vault');
  }
}
