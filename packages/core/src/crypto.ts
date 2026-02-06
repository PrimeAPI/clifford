import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

function deriveKey(secret: string) {
  if (!secret) {
    throw new Error('Missing DATA_ENCRYPTION_KEY');
  }
  return createHash('sha256').update(secret, 'utf8').digest();
}

export function encryptSecret(plainText: string, secret: string) {
  const key = deriveKey(secret);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    cipherText: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
  };
}

export function decryptSecret(cipherText: string, iv: string, tag: string, secret: string) {
  const key = deriveKey(secret);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(cipherText, 'base64')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}
