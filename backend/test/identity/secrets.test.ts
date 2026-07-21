import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { SecretEncryptionError, SecretVault } from '../../src/identity/index.js';

describe('identity secret encryption', () => {
  it('envelope-encrypts secrets and binds them to their purpose', () => {
    const vault = new SecretVault(randomBytes(32));
    const encrypted = vault.encrypt('printer-api-key', 'printer:123');

    expect(encrypted).not.toContain('printer-api-key');
    expect(vault.decrypt(encrypted, 'printer:123')).toBe('printer-api-key');
    expect(() => vault.decrypt(encrypted, 'printer:456')).toThrow(SecretEncryptionError);
  });

  it('rejects tampered envelopes without including secret material in errors', () => {
    const vault = new SecretVault(randomBytes(32));
    const encrypted = vault.encrypt('never disclose this', 'storage:s3');

    expect(() => vault.decrypt(`${encrypted}x`, 'storage:s3')).toThrow(
      'Encrypted secret is invalid or cannot be decrypted',
    );
  });
});
