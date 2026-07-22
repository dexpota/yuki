import { deflateRawSync } from 'node:zlib';

export interface ZipMemberFixture {
  readonly name: string;
  readonly contents?: Uint8Array | string;
  readonly compression?: 'store' | 'deflate';
  readonly flags?: number;
  readonly externalAttributes?: number;
  readonly declaredUncompressedSize?: number;
  readonly declaredCompressedSize?: number;
}

export function buildZip(members: readonly ZipMemberFixture[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const member of members) {
    const name = Buffer.from(member.name);
    const raw = Buffer.from(member.contents ?? '');
    const method = member.compression === 'deflate' ? 8 : 0;
    const compressed = method === 8 ? deflateRawSync(raw) : raw;
    const flags = member.flags ?? 0x800;
    const payload =
      (flags & 0x1) === 0 ? compressed : Buffer.concat([Buffer.alloc(12), compressed]);
    const uncompressedSize = member.declaredUncompressedSize ?? raw.byteLength;
    const compressedSize = member.declaredCompressedSize ?? payload.byteLength;
    const checksum = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressedSize, 18);
    local.writeUInt32LE(uncompressedSize, 22);
    local.writeUInt16LE(name.byteLength, 26);
    localParts.push(local, name, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressedSize, 20);
    central.writeUInt32LE(uncompressedSize, 24);
    central.writeUInt16LE(name.byteLength, 28);
    central.writeUInt32LE(member.externalAttributes ?? 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.byteLength + name.byteLength + payload.byteLength;
  }
  const central = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(members.length, 8);
  end.writeUInt16LE(members.length, 10);
  end.writeUInt32LE(central.byteLength, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, central, end]);
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
