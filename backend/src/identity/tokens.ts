import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const sessionCookieName = 'yuki_session';
export const preAuthCookieName = 'yuki_pre_auth';

export function newOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function deriveCsrfToken(cookieToken: string, csrfKey: Buffer): string {
  return createHmac('sha256', csrfKey)
    .update('yuki-csrf-v1\0')
    .update(cookieToken)
    .digest('base64url');
}

export function constantTimeTokenEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export function decodeBase64Key(value: string, name = 'key'): Buffer {
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32 || key.toString('base64') !== value) {
    throw new TypeError(`${name} must be exactly 32 bytes encoded as canonical base64`);
  }
  return key;
}

export function readIdentityKey(value: string | undefined, name: string): Buffer {
  if (value === undefined || value.length === 0) {
    throw new TypeError(`${name} is required`);
  }
  return decodeBase64Key(value, name);
}
