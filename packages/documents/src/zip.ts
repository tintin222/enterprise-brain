/** Office Open XML files are ZIP archives; parsers inflate every entry into memory. */
export const MAX_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;

/**
 * Total uncompressed size declared in a ZIP's central directory: Infinity for
 * ZIP64 archives (over 4 GB or 65k entries), undefined when it cannot be read.
 */
export function zipUncompressedSize(data: Uint8Array): number | undefined {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  // The end-of-central-directory record is 22 bytes plus a comment of up to 64 KB, at the end of the file.
  for (let eocd = data.length - 22; eocd >= Math.max(0, data.length - 22 - 0xffff); eocd--) {
    if (view.getUint32(eocd, true) !== EOCD_SIGNATURE) continue;
    const entries = view.getUint16(eocd + 10, true);
    let offset = view.getUint32(eocd + 16, true);
    if (entries === 0xffff || offset === 0xffffffff) return Infinity;
    let total = 0;
    for (let i = 0; i < entries; i++) {
      if (offset + 46 > data.length || view.getUint32(offset, true) !== CENTRAL_HEADER_SIGNATURE) return undefined;
      const size = view.getUint32(offset + 24, true);
      if (size === 0xffffffff) return Infinity;
      total += size;
      offset += 46 + view.getUint16(offset + 28, true) + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
    }
    return total;
  }
  return undefined;
}

/** Refuse archives that would inflate beyond the limit (zip bombs) before a parser loads them. */
export function assertSafeZip(data: Uint8Array, kind: string): void {
  const size = zipUncompressedSize(data);
  if (size !== undefined && size > MAX_UNCOMPRESSED_BYTES) {
    const described = Number.isFinite(size) ? `${Math.round(size / 1024 / 1024)} MB` : "more than 4 GB";
    throw new Error(`the ${kind} file expands to ${described}, above the ${MAX_UNCOMPRESSED_BYTES / 1024 / 1024} MB safety limit`);
  }
}
