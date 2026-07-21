import type { FastifyReply, FastifyRequest } from 'fastify';

export interface IdentityCookieOptions {
  readonly secure: boolean;
  readonly domain?: string;
}

export function readCookie(request: FastifyRequest, name: string): string | undefined {
  const header = request.headers.cookie;
  if (header === undefined) return undefined;
  for (const pair of header.split(';')) {
    const separator = pair.indexOf('=');
    if (separator < 0) continue;
    if (pair.slice(0, separator).trim() !== name) continue;
    const value = pair.slice(separator + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function setHttpOnlyCookie(
  reply: FastifyReply,
  name: string,
  value: string,
  expiresAt: Date,
  options: IdentityCookieOptions,
): void {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Expires=${expiresAt.toUTCString()}`,
    ...(options.secure ? ['Secure'] : []),
    ...(options.domain === undefined ? [] : [`Domain=${options.domain}`]),
  ];
  appendSetCookie(reply, parts.join('; '));
}

function appendSetCookie(reply: FastifyReply, value: string): void {
  const existing = reply.getHeader('set-cookie');
  if (existing === undefined) reply.header('set-cookie', value);
  else if (Array.isArray(existing)) reply.header('set-cookie', [...existing, value]);
  else reply.header('set-cookie', [String(existing), value]);
}

export function clearHttpOnlyCookie(
  reply: FastifyReply,
  name: string,
  options: IdentityCookieOptions,
): void {
  setHttpOnlyCookie(reply, name, '', new Date(0), options);
}
