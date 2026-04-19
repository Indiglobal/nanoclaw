import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { isSupportedImageMime, processImage } from './image.js';

async function makeImage(
  width: number,
  height: number,
  format: 'jpeg' | 'png' | 'webp' = 'jpeg',
): Promise<Buffer> {
  const img = sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 128, g: 64, b: 200 },
    },
  });
  if (format === 'png') return img.png().toBuffer();
  if (format === 'webp') return img.webp().toBuffer();
  return img.jpeg().toBuffer();
}

describe('isSupportedImageMime', () => {
  it('accepts common image mimes', () => {
    expect(isSupportedImageMime('image/jpeg')).toBe(true);
    expect(isSupportedImageMime('image/png')).toBe(true);
    expect(isSupportedImageMime('image/webp')).toBe(true);
    expect(isSupportedImageMime('image/gif')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isSupportedImageMime('IMAGE/JPEG')).toBe(true);
  });

  it('rejects non-images and empty', () => {
    expect(isSupportedImageMime('application/pdf')).toBe(false);
    expect(isSupportedImageMime('')).toBe(false);
    expect(isSupportedImageMime(undefined)).toBe(false);
  });
});

describe('processImage', () => {
  it('resizes images larger than MAX_DIMENSION on longest side', async () => {
    const input = await makeImage(4000, 2000, 'jpeg');
    const { base64, mime } = await processImage(input, 'image/jpeg');

    expect(mime).toBe('image/jpeg');
    const meta = await sharp(Buffer.from(base64, 'base64')).metadata();
    expect(meta.width).toBe(1568);
    expect(meta.height).toBe(784);
  });

  it('leaves small images at native size', async () => {
    const input = await makeImage(200, 100, 'jpeg');
    const { base64 } = await processImage(input, 'image/jpeg');
    const meta = await sharp(Buffer.from(base64, 'base64')).metadata();
    expect(meta.width).toBe(200);
    expect(meta.height).toBe(100);
  });

  it('preserves PNG format', async () => {
    const input = await makeImage(100, 100, 'png');
    const { mime } = await processImage(input, 'image/png');
    expect(mime).toBe('image/png');
  });

  it('preserves WebP format', async () => {
    const input = await makeImage(100, 100, 'webp');
    const { mime } = await processImage(input, 'image/webp');
    expect(mime).toBe('image/webp');
  });

  it('rejects unsupported MIME', async () => {
    const input = await makeImage(100, 100);
    await expect(processImage(input, 'application/pdf')).rejects.toThrow(
      /Unsupported/,
    );
  });

  it('rejects input over MAX_INPUT_BYTES', async () => {
    const oversized = Buffer.alloc(21 * 1024 * 1024);
    await expect(processImage(oversized, 'image/jpeg')).rejects.toThrow(
      /exceeds/,
    );
  });
});
