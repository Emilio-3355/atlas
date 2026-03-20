import nacl from 'tweetnacl';
import { getEnv } from '../config/env.js';
import logger from '../utils/logger.js';

function getKey(): Uint8Array {
  const key = getEnv().CREDENTIAL_ENCRYPTION_KEY;
  if (!key) throw new Error('CREDENTIAL_ENCRYPTION_KEY not set');
  return Buffer.from(key, 'base64');
}

export function encrypt(plaintext: string): string {
  const nonce = nacl.randomBytes(24);
  const encrypted = nacl.secretbox(Buffer.from(plaintext), nonce, getKey());
  return Buffer.concat([Buffer.from(nonce), Buffer.from(encrypted)]).toString('base64');
}

export function decrypt(ciphertext: string): string {
  const buf = Buffer.from(ciphertext, 'base64');
  const nonce = buf.subarray(0, 24);
  const box = buf.subarray(24);
  const decrypted = nacl.secretbox.open(box, nonce, getKey());
  if (!decrypted) throw new Error('Decryption failed');
  return Buffer.from(decrypted).toString();
}

/**
 * Try to decrypt a value. If it fails (old plaintext), return as-is.
 * This provides graceful migration from plaintext to encrypted storage.
 */
export function decryptGraceful(value: string): { plaintext: string; wasEncrypted: boolean } {
  // If CREDENTIAL_ENCRYPTION_KEY is not set, return as-is
  if (!getEnv().CREDENTIAL_ENCRYPTION_KEY) {
    return { plaintext: value, wasEncrypted: false };
  }

  try {
    const decrypted = decrypt(value);
    return { plaintext: decrypted, wasEncrypted: true };
  } catch {
    // Not encrypted (old plaintext value) — return as-is
    logger.debug('Value appears to be plaintext (decrypt failed), returning as-is');
    return { plaintext: value, wasEncrypted: false };
  }
}

/**
 * Encrypt only if CREDENTIAL_ENCRYPTION_KEY is configured.
 * Returns plaintext unchanged if encryption is not set up.
 */
export function encryptIfAvailable(plaintext: string): string {
  if (!getEnv().CREDENTIAL_ENCRYPTION_KEY) {
    return plaintext;
  }
  return encrypt(plaintext);
}
