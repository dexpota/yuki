import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const algorithm = 'aes-256-gcm';

interface EncryptedSecretV1 {
  readonly v: 1;
  readonly dek: Ciphertext;
  readonly value: Ciphertext;
}

interface Ciphertext {
  readonly nonce: string;
  readonly ciphertext: string;
  readonly tag: string;
}

export class SecretEncryptionError extends Error {
  override readonly name = 'SecretEncryptionError';

  public constructor(message = 'Encrypted secret is invalid or cannot be decrypted') {
    super(message);
  }
}

export class SecretVault {
  public constructor(private readonly masterKey: Buffer) {
    if (masterKey.length !== 32) throw new TypeError('Installation master key must be 32 bytes');
  }

  public encrypt(plaintext: string, purpose: string): string {
    const dataKey = randomBytes(32);
    const payload: EncryptedSecretV1 = {
      v: 1,
      dek: encryptBytes(dataKey, this.masterKey, associatedData('dek', purpose)),
      value: encryptBytes(
        Buffer.from(plaintext, 'utf8'),
        dataKey,
        associatedData('value', purpose),
      ),
    };
    dataKey.fill(0);
    return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  }

  public decrypt(envelope: string, purpose: string): string {
    let dataKey: Buffer | undefined;
    try {
      const parsed = JSON.parse(Buffer.from(envelope, 'base64url').toString('utf8')) as unknown;
      if (!isEnvelope(parsed)) throw new SecretEncryptionError();
      dataKey = decryptBytes(parsed.dek, this.masterKey, associatedData('dek', purpose));
      return decryptBytes(parsed.value, dataKey, associatedData('value', purpose)).toString('utf8');
    } catch (error) {
      if (error instanceof SecretEncryptionError) throw error;
      throw new SecretEncryptionError();
    } finally {
      dataKey?.fill(0);
    }
  }
}

function encryptBytes(value: Buffer, key: Buffer, aad: Buffer): Ciphertext {
  const nonce = randomBytes(12);
  const cipher = createCipheriv(algorithm, key, nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(value), cipher.final()]);
  return {
    nonce: nonce.toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
  };
}

function decryptBytes(value: Ciphertext, key: Buffer, aad: Buffer): Buffer {
  const decipher = createDecipheriv(algorithm, key, Buffer.from(value.nonce, 'base64url'));
  decipher.setAAD(aad);
  decipher.setAuthTag(Buffer.from(value.tag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(value.ciphertext, 'base64url')),
    decipher.final(),
  ]);
}

function associatedData(kind: string, purpose: string): Buffer {
  if (purpose.length === 0) throw new TypeError('Secret purpose must not be empty');
  return Buffer.from(`yuki-secret-v1\0${kind}\0${purpose}`, 'utf8');
}

function isEnvelope(value: unknown): value is EncryptedSecretV1 {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<EncryptedSecretV1>;
  return candidate.v === 1 && isCiphertext(candidate.dek) && isCiphertext(candidate.value);
}

function isCiphertext(value: unknown): value is Ciphertext {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<Ciphertext>;
  return (
    typeof candidate.nonce === 'string' &&
    typeof candidate.ciphertext === 'string' &&
    typeof candidate.tag === 'string'
  );
}
