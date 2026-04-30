/**
 * secure-export.js — v1.9.9
 *
 * Encrypted profile export/import including the bot token.
 *
 * Design:
 *   - User supplies a passphrase at export time and again at import time.
 *   - Token (and any future secrets) are encrypted with AES-256-GCM.
 *   - Key is derived from the passphrase via PBKDF2-HMAC-SHA256 with a
 *     random per-export salt (200,000 iterations — OWASP 2023 floor).
 *   - GCM auth tag is stored separately. Tampering with any field will
 *     fail decryption — we won't "succeed with garbage."
 *   - The encrypted file is portable across machines: import on a new
 *     PC + correct passphrase recovers the token into the OS keychain.
 *   - Plaintext tokens are never written to disk by this module. They
 *     exist only briefly in memory during encrypt/decrypt.
 *
 * File format (.multirp-secure.json):
 *   {
 *     "format": "multirp-secure-profile",
 *     "version": 1,
 *     "createdAt": "2026-04-30T...",
 *     "profile": { ...non-secret fields, same shape as .multirp.json... },
 *     "secrets": {
 *       "botToken": {
 *         "alg": "aes-256-gcm",
 *         "kdf": "pbkdf2-sha256",
 *         "iter": 200000,
 *         "salt": "<base64>",
 *         "iv":   "<base64>",
 *         "tag":  "<base64>",
 *         "ct":   "<base64>"
 *       }
 *     }
 *   }
 */

const crypto = require('crypto');

const KDF_ITER = 200000;
const KDF_KEYLEN = 32;       // 256-bit AES key
const KDF_DIGEST = 'sha256';
const SALT_LEN = 16;
const IV_LEN = 12;           // GCM standard IV

function deriveKey(passphrase, salt) {
  return crypto.pbkdf2Sync(
    Buffer.from(passphrase, 'utf-8'),
    salt,
    KDF_ITER,
    KDF_KEYLEN,
    KDF_DIGEST
  );
}

function encryptSecret(plaintext, passphrase) {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new Error('Nothing to encrypt.');
  }
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw new Error('Passphrase required.');
  }
  const salt = crypto.randomBytes(SALT_LEN);
  const iv = crypto.randomBytes(IV_LEN);
  const key = deriveKey(passphrase, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    alg: 'aes-256-gcm',
    kdf: 'pbkdf2-sha256',
    iter: KDF_ITER,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ct: ct.toString('base64')
  };
}

function decryptSecret(blob, passphrase) {
  if (!blob || typeof blob !== 'object') throw new Error('Bad secret blob.');
  if (blob.alg !== 'aes-256-gcm') throw new Error('Unsupported cipher.');
  if (blob.kdf !== 'pbkdf2-sha256') throw new Error('Unsupported KDF.');
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw new Error('Passphrase required.');
  }
  const salt = Buffer.from(blob.salt, 'base64');
  const iv = Buffer.from(blob.iv, 'base64');
  const tag = Buffer.from(blob.tag, 'base64');
  const ct = Buffer.from(blob.ct, 'base64');
  const iter = Number.isInteger(blob.iter) && blob.iter >= 50000 ? blob.iter : KDF_ITER;
  const key = crypto.pbkdf2Sync(Buffer.from(passphrase, 'utf-8'), salt, iter, KDF_KEYLEN, KDF_DIGEST);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  try {
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString('utf-8');
  } catch (e) {
    // GCM auth tag mismatch → wrong passphrase or tampered file.
    throw new Error('Wrong passphrase, or the file has been modified.');
  }
}

/**
 * Build a secure export envelope.
 * @param {object} profile      Sanitized non-secret profile (same shape as .multirp.json).
 * @param {string} botToken     Plaintext bot token (will be encrypted).
 * @param {string} passphrase   User-chosen passphrase.
 * @returns {string} JSON text ready to write to disk.
 */
function serializeSecure(profile, botToken, passphrase) {
  const envelope = {
    format: 'multirp-secure-profile',
    version: 1,
    createdAt: new Date().toISOString(),
    profile,
    secrets: {}
  };
  if (botToken) {
    envelope.secrets.botToken = encryptSecret(botToken, passphrase);
  }
  return JSON.stringify(envelope, null, 2);
}

/**
 * Parse and decrypt a secure export envelope.
 * @param {string} text         JSON text from disk.
 * @param {string} passphrase   User-supplied passphrase.
 * @returns {{ profile: object, botToken: string|null }}
 */
function parseSecure(text, passphrase) {
  let env;
  try { env = JSON.parse(text); }
  catch (e) { throw new Error('Not valid JSON.'); }
  if (!env || env.format !== 'multirp-secure-profile') {
    throw new Error('Not a MultiRP secure profile file.');
  }
  if (env.version !== 1) {
    throw new Error(`Unsupported secure profile version: ${env.version}`);
  }
  if (!env.profile || typeof env.profile !== 'object') {
    throw new Error('Profile data missing from secure file.');
  }
  let botToken = null;
  if (env.secrets && env.secrets.botToken) {
    botToken = decryptSecret(env.secrets.botToken, passphrase);
  }
  return { profile: env.profile, botToken };
}

/**
 * Detect whether a given file content looks like a secure envelope, without
 * attempting to decrypt. Used by the importer to know whether to prompt for
 * a passphrase.
 */
function looksSecure(text) {
  try {
    const obj = JSON.parse(text);
    return obj && obj.format === 'multirp-secure-profile';
  } catch (_) {
    return false;
  }
}

module.exports = {
  serializeSecure,
  parseSecure,
  looksSecure,
  encryptSecret,
  decryptSecret,
  KDF_ITER
};
