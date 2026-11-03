import type { FileMimeType } from '@twring/contracts';

type Result = { mimeType: FileMimeType; width?: number; height?: number };
const dimensions = (mimeType: FileMimeType, width?: number, height?: number): Result =>
  width && height ? { mimeType, width, height } : { mimeType };

function jpegSize(bytes: Buffer): [number, number] | undefined {
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset++] !== 0xff) return;
    let marker = bytes[offset++];
    while (marker === 0xff && offset < bytes.length) marker = bytes[offset++];
    if (marker === undefined) return;
    if (marker === 0xd9 || marker === 0xda) return;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) return;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker) && length >= 7)
      return [bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3)];
    offset += length;
  }
}

function webpSize(bytes: Buffer): [number, number] | undefined {
  if (bytes.length < 30) return;
  const chunk = bytes.toString('ascii', 12, 16);
  if (chunk === 'VP8X') return [1 + bytes.readUIntLE(24, 3), 1 + bytes.readUIntLE(27, 3)];
  if (chunk === 'VP8L' && bytes[20] === 0x2f) {
    const bits = bytes.readUInt32LE(21);
    return [1 + (bits & 0x3fff), 1 + ((bits >>> 14) & 0x3fff)];
  }
  if (chunk === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a)
    return [bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff];
}

export function sniffFile(
  bytes: Buffer,
  declaredType: string | undefined,
  name: string,
): Result | undefined {
  if (!bytes.length) return;
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    const size = jpegSize(bytes);
    return dimensions('image/jpeg', size?.[0], size?.[1]);
  }
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    const size =
      bytes.length >= 24 && bytes.toString('ascii', 12, 16) === 'IHDR'
        ? [bytes.readUInt32BE(16), bytes.readUInt32BE(20)]
        : undefined;
    return dimensions('image/png', size?.[0], size?.[1]);
  }
  if (
    bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  ) {
    const size = webpSize(bytes);
    return dimensions('image/webp', size?.[0], size?.[1]);
  }
  if (bytes.length >= 5 && bytes.toString('ascii', 0, 5) === '%PDF-')
    return { mimeType: 'application/pdf' };
  if (bytes.includes(0)) return;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return;
  }
  // Non-text controls are not useful documents and often indicate a disguised executable.
  // eslint-disable-next-line no-control-regex -- reject binary controls in purported text
  if (/[\x01-\x08\x0b\x0c\x0e-\x1f]/.test(text)) return;
  const type = declaredType?.split(';')[0]?.trim().toLowerCase();
  const lower = name.toLowerCase();
  if (type === 'application/json' || lower.endsWith('.json')) {
    try {
      JSON.parse(text);
      return { mimeType: 'application/json' };
    } catch {
      /* Plain text fallback. */
    }
  }
  if (type === 'text/csv' || lower.endsWith('.csv')) return { mimeType: 'text/csv' };
  if (type === 'text/markdown' || lower.endsWith('.md') || lower.endsWith('.markdown'))
    return { mimeType: 'text/markdown' };
  return { mimeType: 'text/plain' };
}
