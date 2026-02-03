import { createCipheriv, createHash, randomBytes } from 'crypto';

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
