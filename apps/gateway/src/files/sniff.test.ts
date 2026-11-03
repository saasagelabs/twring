import { describe, expect, it } from 'vitest';
import { sniffFile } from './sniff';

describe('sniffFile', () => {
  it('recognizes image and PDF bytes ahead of the name', () => {
    const png = Buffer.alloc(24);
    Buffer.from('89504e470d0a1a0a', 'hex').copy(png);
    png.write('IHDR', 12);
    png.writeUInt32BE(24, 16);
    png.writeUInt32BE(16, 20);
    expect(sniffFile(png, 'text/plain', 'fake.txt')).toEqual({
      mimeType: 'image/png',
      width: 24,
      height: 16,
    });
    const jpeg = Buffer.from('ffd8ffc00011080010002003011100021101031101', 'hex');
    expect(sniffFile(jpeg, 'text/plain', 'fake.txt')).toEqual({
      mimeType: 'image/jpeg',
      width: 32,
      height: 16,
    });
    const webp = Buffer.alloc(30);
    webp.write('RIFF', 0);
    webp.write('WEBP', 8);
    webp.write('VP8X', 12);
    webp.writeUIntLE(31, 24, 3);
    webp.writeUIntLE(15, 27, 3);
    expect(sniffFile(webp, '', 'x.txt')).toEqual({ mimeType: 'image/webp', width: 32, height: 16 });
    expect(sniffFile(Buffer.from('%PDF-1.7'), 'text/plain', 'x.txt')).toEqual({
      mimeType: 'application/pdf',
    });
  });
  it('accepts valid UTF-8 text and rejects binary', () => {
    expect(sniffFile(Buffer.from('{"a":1}'), 'application/json', 'x')).toEqual({
      mimeType: 'application/json',
    });
    expect(sniffFile(Buffer.from('{"a":1}'), '', 'x.json')).toEqual({
      mimeType: 'application/json',
    });
    expect(sniffFile(Buffer.from('a,b\n1,2'), '', 'x.csv')).toEqual({ mimeType: 'text/csv' });
    expect(sniffFile(Buffer.from('# Heading'), 'text/markdown', 'x')).toEqual({
      mimeType: 'text/markdown',
    });
    expect(sniffFile(Buffer.from('hello'), '', 'x')).toEqual({ mimeType: 'text/plain' });
    expect(sniffFile(Buffer.from([0xff]), '', 'x')).toBeUndefined();
    expect(sniffFile(Buffer.from([65, 0, 66]), '', 'x')).toBeUndefined();
    expect(sniffFile(Buffer.from([0x4d, 0x5a, 1, 2]), '', 'x.exe')).toBeUndefined();
    expect(sniffFile(Buffer.alloc(0), '', 'x')).toBeUndefined();
  });
});
