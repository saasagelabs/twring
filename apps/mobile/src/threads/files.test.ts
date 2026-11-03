import { describe, expect, it } from 'vitest';
import { fileCheck, filesPreview, humanSize, typeLabel } from './files';

describe('file helpers', () => {
  it('labels types and human sizes', () => {
    expect(typeLabel('image/jpeg')).toBe('JPEG image');
    expect(typeLabel('application/pdf')).toBe('PDF');
    expect(humanSize(10)).toBe('10 B');
    expect(humanSize(1536)).toBe('2 KB');
    expect(humanSize(1258291)).toBe('1.2 MB');
  });
  it('checks size, type, and message count', () => {
    expect(
      fileCheck({ mimeType: 'application/pdf', sizeBytes: 10 * 1024 * 1024 }, 4),
    ).toBeUndefined();
    expect(fileCheck({ mimeType: 'application/pdf', sizeBytes: 10 * 1024 * 1024 + 1 }, 0)).toBe(
      'file_too_large',
    );
    expect(fileCheck({ mimeType: 'application/zip', sizeBytes: 10 }, 0)).toBe(
      'unsupported_file_type',
    );
    expect(fileCheck({ mimeType: 'application/pdf', sizeBytes: 10 }, 5)).toBe('too_many_files');
  });
  it('summarizes photos and documents', () => {
    const photo = {
      id: 'fil_aaaaaaaaaaaaaaaaaaaa',
      name: 'p.jpg',
      mime_type: 'image/jpeg' as const,
      size_bytes: 10,
    };
    const doc = {
      id: 'fil_bbbbbbbbbbbbbbbbbbbb',
      name: 'a.pdf',
      mime_type: 'application/pdf' as const,
      size_bytes: 10,
    };
    expect(filesPreview([photo])).toBe('Photo');
    expect(filesPreview([photo, photo])).toBe('2 photos');
    expect(filesPreview([doc])).toBe('File: a.pdf');
    expect(filesPreview([photo, doc, doc])).toBe('3 files');
  });
});
