import sharp from 'sharp';

// Claude's documented sweet spot for image input — keeps enough detail for
// OCR/detail while avoiding oversized payloads.
const MAX_DIMENSION = 1568;

// Hard ceiling on pre-resize input bytes. Anything larger is rejected rather
// than risking sharp OOM on a pathological file.
const MAX_INPUT_BYTES = 20 * 1024 * 1024;

// Images whose MIME lies outside this set are treated as non-images and
// skipped by callers.
const SUPPORTED_MIMES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/gif',
  'image/webp',
]);

export function isSupportedImageMime(mime: string | undefined): boolean {
  if (!mime) return false;
  return SUPPORTED_MIMES.has(mime.toLowerCase());
}

export interface ProcessedImage {
  mime: string;
  base64: string;
}

/**
 * Resize an image so its longest side is at most MAX_DIMENSION, then return
 * base64-encoded bytes. Preserves original format when possible; falls back to
 * JPEG if sharp can't round-trip the input.
 *
 * Throws if input exceeds MAX_INPUT_BYTES or has an unsupported MIME.
 */
export async function processImage(
  bytes: Buffer,
  mime: string,
): Promise<ProcessedImage> {
  if (bytes.length > MAX_INPUT_BYTES) {
    throw new Error(
      `Image exceeds ${MAX_INPUT_BYTES} bytes (got ${bytes.length})`,
    );
  }
  if (!isSupportedImageMime(mime)) {
    throw new Error(`Unsupported image MIME: ${mime}`);
  }

  // Normalize GIF → first frame to avoid multi-frame base64 bloat.
  const pipeline = sharp(bytes, { animated: false });

  const meta = await pipeline.metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  const longest = Math.max(width, height);

  let resized = pipeline;
  if (longest > MAX_DIMENSION) {
    resized = pipeline.resize({
      width: width >= height ? MAX_DIMENSION : undefined,
      height: height > width ? MAX_DIMENSION : undefined,
      fit: 'inside',
      withoutEnlargement: true,
    });
  }

  // Preserve format for PNG/WebP, otherwise use JPEG (smallest for photos).
  const normalized = mime.toLowerCase();
  let outMime: string;
  let outBuf: Buffer;
  if (normalized === 'image/png') {
    outMime = 'image/png';
    outBuf = await resized.png().toBuffer();
  } else if (normalized === 'image/webp') {
    outMime = 'image/webp';
    outBuf = await resized.webp().toBuffer();
  } else {
    outMime = 'image/jpeg';
    outBuf = await resized.jpeg({ quality: 85 }).toBuffer();
  }

  return { mime: outMime, base64: outBuf.toString('base64') };
}
