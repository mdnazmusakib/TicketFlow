/** Image upload policy for event banners (PRD: JPEG, PNG, WebP only, max 2 MB). */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

export const IMAGE_TYPES = {
  jpeg: { mime: 'image/jpeg', ext: 'jpg' },
  png: { mime: 'image/png', ext: 'png' },
  webp: { mime: 'image/webp', ext: 'webp' },
} as const;

export type ImageKind = keyof typeof IMAGE_TYPES;

export const ALLOWED_IMAGE_MIME_TYPES: readonly string[] = Object.values(IMAGE_TYPES).map(
  (t) => t.mime,
);

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Identifies an image from its bytes (magic numbers), never from the file
 * name or the client-declared MIME type. Returns null for anything else.
 * - JPEG: FF D8 FF … and the end-of-image marker FF D9 near the end
 * - PNG:  8-byte signature followed by an IHDR chunk
 * - WebP: "RIFF" <size> "WEBP" with a VP8/VP8L/VP8X chunk and a consistent RIFF size
 */
export function detectImageKind(data: Buffer): ImageKind | null {
  if (data.length < 16) return null;

  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    // Allow trailing padding after the EOI marker, as some encoders add it.
    const tail = data.subarray(Math.max(0, data.length - 64));
    for (let i = tail.length - 2; i >= 0; i -= 1) {
      if (tail[i] === 0xff && tail[i + 1] === 0xd9) return 'jpeg';
    }
    return null;
  }

  if (data.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return data.toString('latin1', 12, 16) === 'IHDR' ? 'png' : null;
  }

  if (data.toString('latin1', 0, 4) === 'RIFF' && data.toString('latin1', 8, 12) === 'WEBP') {
    const riffSize = data.readUInt32LE(4);
    const chunk = data.toString('latin1', 12, 16);
    const sizeOk = riffSize + 8 === data.length || riffSize + 9 === data.length; // odd padding
    return sizeOk && ['VP8 ', 'VP8L', 'VP8X'].includes(chunk) ? 'webp' : null;
  }

  return null;
}

/** Storage keys we generate: <uuid>.<ext>. Anything else is rejected before touching the disk. */
export const IMAGE_KEY_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpg|png|webp)$/;

export function mimeForKey(key: string): string | null {
  const match = IMAGE_KEY_PATTERN.exec(key);
  if (!match) return null;
  return Object.values(IMAGE_TYPES).find((t) => t.ext === match[1])!.mime;
}
