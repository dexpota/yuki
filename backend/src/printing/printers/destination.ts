import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export class UnsafePrinterDestinationError extends Error {
  override readonly name = 'UnsafePrinterDestinationError';
}

export interface PrinterDestination {
  readonly origin: string;
  readonly baseUrl: string;
}

export interface PrinterDestinationPolicyOptions {
  /** Local RFC1918/ULA addresses are expected for self-hosted OctoPrint. */
  readonly allowPrivateNetworks?: boolean;
  readonly allowedHostnames?: ReadonlySet<string>;
  readonly lookupAddresses?: (hostname: string) => Promise<readonly string[]>;
}

export class PrinterDestinationPolicy {
  readonly #allowPrivateNetworks: boolean;
  readonly #allowedHostnames: ReadonlySet<string> | undefined;
  readonly #lookupAddresses: (hostname: string) => Promise<readonly string[]>;

  public constructor(options: PrinterDestinationPolicyOptions = {}) {
    this.#allowPrivateNetworks = options.allowPrivateNetworks ?? true;
    this.#allowedHostnames = options.allowedHostnames;
    this.#lookupAddresses = options.lookupAddresses ?? resolveAddresses;
  }

  public async validate(rawUrl: string): Promise<PrinterDestination> {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new UnsafePrinterDestinationError('Printer URL is invalid');
    }
    if (!['http:', 'https:'].includes(parsed.protocol))
      throw new UnsafePrinterDestinationError('Printer URL scheme is not allowed');
    if (parsed.username || parsed.password)
      throw new UnsafePrinterDestinationError('Printer URL must not contain credentials');
    if (parsed.search || parsed.hash)
      throw new UnsafePrinterDestinationError('Printer URL must not contain a query or fragment');
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
    const lookupHostname =
      hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
    if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost'))
      throw new UnsafePrinterDestinationError('Printer hostname is not allowed');
    if (this.#allowedHostnames && !this.#allowedHostnames.has(hostname))
      throw new UnsafePrinterDestinationError('Printer hostname is not allowlisted');

    let addresses: readonly string[];
    try {
      addresses = isIP(lookupHostname)
        ? [lookupHostname]
        : await this.#lookupAddresses(lookupHostname);
    } catch {
      throw new UnsafePrinterDestinationError('Printer hostname could not be resolved');
    }
    if (
      addresses.length === 0 ||
      addresses.some((address) => !addressAllowed(address, this.#allowPrivateNetworks))
    )
      throw new UnsafePrinterDestinationError('Printer address is not allowed');

    parsed.hostname = hostname;
    parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}/`;
    return { origin: parsed.origin, baseUrl: parsed.toString() };
  }
}

async function resolveAddresses(hostname: string): Promise<readonly string[]> {
  return (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);
}

function addressAllowed(address: string, allowPrivateNetworks: boolean): boolean {
  const normalized = address.toLowerCase().split('%')[0] ?? '';
  const version = isIP(normalized);
  if (version === 6) {
    const mapped = mappedIpv4(normalized);
    return mapped === null
      ? ipv6Allowed(normalized, allowPrivateNetworks)
      : ipv4Allowed(mapped, allowPrivateNetworks);
  }
  if (version !== 4) return false;
  return ipv4Allowed(normalized, allowPrivateNetworks);
}

function ipv4Allowed(address: string, allowPrivateNetworks: boolean): boolean {
  const octets = address.split('.').map(Number);
  if (
    octets.length !== 4 ||
    octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  )
    return false;
  const [a, b] = octets as [number, number, number, number];
  if (a === 0 || a === 127 || a >= 224) return false;
  if (a === 169 && b === 254) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  const privateAddress = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  return allowPrivateNetworks || !privateAddress;
}

function ipv6Allowed(address: string, allowPrivateNetworks: boolean): boolean {
  const segments = ipv6Segments(address);
  if (segments === null) return false;
  const first = segments[0] as number;
  if (segments.every((segment) => segment === 0)) return false;
  if (segments.slice(0, 7).every((segment) => segment === 0) && segments[7] === 1) return false;
  if ((first & 0xff00) === 0xff00 || (first & 0xffc0) === 0xfe80) return false;
  const privateAddress = (first & 0xfe00) === 0xfc00;
  return allowPrivateNetworks || !privateAddress;
}

function mappedIpv4(address: string): string | null {
  const segments = ipv6Segments(address);
  if (segments === null) return null;
  const compatible = segments.slice(0, 6).every((segment) => segment === 0);
  const mapped = segments.slice(0, 5).every((segment) => segment === 0) && segments[5] === 0xffff;
  if (!compatible && !mapped) return null;
  const high = segments[6] as number;
  const low = segments[7] as number;
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

function ipv6Segments(address: string): readonly number[] | null {
  let normalized = address.toLowerCase();
  const dotted = normalized.match(/(\d{1,3}(?:\.\d{1,3}){3})$/)?.[1];
  if (dotted !== undefined) {
    if (isIP(dotted) !== 4) return null;
    const octets = dotted.split('.').map(Number);
    normalized = `${normalized.slice(0, -dotted.length)}${(
      ((octets[0] as number) << 8) | (octets[1] as number)
    ).toString(16)}:${(((octets[2] as number) << 8) | (octets[3] as number)).toString(16)}`;
  }
  const halves = normalized.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] === '' ? [] : (halves[0] as string).split(':');
  const right = halves.length === 1 || halves[1] === '' ? [] : (halves[1] as string).split(':');
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const groups = [...left, ...Array.from({ length: missing }, () => '0'), ...right];
  const segments = groups.map((group) => Number.parseInt(group, 16));
  return segments.length === 8 && segments.every((segment) => Number.isInteger(segment))
    ? segments
    : null;
}
