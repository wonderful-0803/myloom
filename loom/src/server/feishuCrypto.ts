/**
 * Feishu / Lark event encryption helpers (AES-256-CBC).
 * Spec: base64(encrypt) → IV(16) + ciphertext; key = SHA256(ENCRYPT_KEY).
 */
import crypto from 'crypto';

export function decryptFeishuEncrypt(encrypt: string, encryptKey: string): string {
  if (!encrypt) throw new Error('empty encrypt payload');
  if (!encryptKey) throw new Error('ENCRYPT_KEY required to decrypt');

  const key = crypto.createHash('sha256').update(encryptKey).digest(); // 32 bytes
  const buf = Buffer.from(encrypt, 'base64');
  if (buf.length <= 16) throw new Error('encrypt payload too short');
  const iv = buf.subarray(0, 16);
  const data = buf.subarray(16);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  const decoded = Buffer.concat([decipher.update(data), decipher.final()]);
  return decoded.toString('utf8');
}

/** Encrypt helper for unit tests (mirrors Feishu algorithm). */
export function encryptFeishuPayload(plain: string, encryptKey: string): string {
  const key = crypto.createHash('sha256').update(encryptKey).digest();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, enc]).toString('base64');
}
