'use strict';

/**
 * AES-256-CBC encryption for stored credentials.
 *
 * Every set of integration credentials (Shopify token, Locally password, etc.)
 * is encrypted before being written to the database and decrypted on the way out.
 * The raw secret never touches the frontend.
 *
 * Format stored in DB:  <hex-IV>:<hex-ciphertext>
 */

const crypto = require('crypto');

const ALGORITHM = 'aes-256-cbc';

// ENCRYPTION_KEY must be 64 hex chars (32 bytes). Set in .env.
function getKey() {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error(
      'ENCRYPTION_KEY must be a 64-character hex string (32 bytes). ' +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
  return Buffer.from(hex, 'hex');
}

/**
 * Encrypt a plaintext string.
 * @param {string} text
 * @returns {string}  "<iv_hex>:<ciphertext_hex>"
 */
function encrypt(text) {
  const key    = getKey();
  const iv     = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const enc    = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return `${iv.toString('hex')}:${enc.toString('hex')}`;
}

/**
 * Decrypt a string produced by encrypt().
 * @param {string} encryptedText  "<iv_hex>:<ciphertext_hex>"
 * @returns {string}
 */
function decrypt(encryptedText) {
  const key          = getKey();
  const [ivHex, enc] = encryptedText.split(':');
  const iv           = Buffer.from(ivHex, 'hex');
  const decipher     = crypto.createDecipheriv(ALGORITHM, key, iv);
  const dec          = Buffer.concat([decipher.update(Buffer.from(enc, 'hex')), decipher.final()]);
  return dec.toString('utf8');
}

/**
 * Convenience: encrypt a credentials object (JSON → string → encrypted).
 * @param {object} obj
 * @returns {string}
 */
function encryptJSON(obj) {
  return encrypt(JSON.stringify(obj));
}

/**
 * Convenience: decrypt + parse a credentials object.
 * @param {string} encryptedText
 * @returns {object}
 */
function decryptJSON(encryptedText) {
  return JSON.parse(decrypt(encryptedText));
}

module.exports = { encrypt, decrypt, encryptJSON, decryptJSON };
