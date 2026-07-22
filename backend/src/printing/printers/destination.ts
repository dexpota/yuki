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
    if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost'))
      throw new UnsafePrinterDestinationError('Printer hostname is not allowed');
    if (this.#allowedHostnames && !this.#allowedHostnames.has(hostname))
      throw new UnsafePrinterDestinationError('Printer hostname is not allowlisted');

    let addresses: readonly string[];
    try {
      addresses = isIP(hostname) ? [hostname] : await this.#lookupAddresses(hostname);
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
  if (address.includes(':')) return ipv6Allowed(address, allowPrivateNetworks);
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
  const normalized = address.toLowerCase().split('%')[0] ?? '';
  if (
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb')
  )
    return false;
  if (normalized.startsWith('ff')) return false;
  const privateAddress = normalized.startsWith('fc') || normalized.startsWith('fd');
  return allowPrivateNetworks || !privateAddress;
}
