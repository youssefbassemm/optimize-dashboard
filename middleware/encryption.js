'use strict';

const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;   // 96-bit IV — standard for GCM
const TAG_LEN = 16;  // 128-bit auth tag

function getKey() {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error('ENCRYPTION_KEY must be 64 hex characters (32 bytes)');
  }
  return Buffer.from(hex, 'hex');
}

/**
 * Encrypts a JSON-serialisable value.
 * Returns a hex string: iv(12B) + tag(16B) + ciphertext
 */
function encryptJSON(value) {
  const key = getKey();
  const iv  = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const plain  = JSON.stringify(value);
  const enc    = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag    = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('hex');
}

/**
 * Decrypts a hex string produced by encryptJSON.
 * Returns the original value, or null on any failure (bad key, tampered data, etc.)
 */
function decryptJSON(hex) {
  try {
    const buf     = Buffer.from(hex, 'hex');
    const iv      = buf.subarray(0, IV_LEN);
    const tag     = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const enc     = buf.subarray(IV_LEN + TAG_LEN);
    const decipher = crypto.createDecipheriv(ALGO, getKey(), iv);
    decipher.setAuthTag(tag);
    const plain   = Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
    return JSON.parse(plain);
  } catch {
    return null;
  }
}

module.exports = { encryptJSON, decryptJSON };
