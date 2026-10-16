/**
 * Image compression for model context: a 4K screenshot enters the context
 * at full resolution and costs thousands of tokens for detail that is lost
 * at any realistic rendering size anyway. Before an image goes in:
 *
 *   - scale down so the LONGER edge is at most 1200px (aspect preserved);
 *   - keep PNG only when the bitmap actually uses alpha; convert everything
 *     else to JPEG at quality 95;
 *   - return the full before/after metadata so the caller can show the
 *     compression ratio.
 *
 * The decoder/encoder is abstracted and loaded lazily: with the optional
 * `jimp` dependency absent, compression degrades gracefully to "original
 * image passes through" and nothing fails. Parameters follow the
 * documented command-code sharing-compression mechanism; all wording is
 * original.
 */

export const MAX_IMAGE_EDGE = 1200;
export const JPEG_QUALITY = 95;

export interface ImageBitmap {
  width: number;
  height: number;
  /** RGBA bytes, length = width * height * 4. */
  rgba: Uint8Array;
}

export interface ImageProcessor {
  decode(bytes: Buffer): Promise<ImageBitmap | undefined>;
  resizeEncode(
    bitmap: ImageBitmap,
    options: { width: number; height: number; format: "png" | "jpeg"; quality?: number },
  ): Promise<Buffer>;
}

export interface CompressionOutcome {
  compressedBase64: string;
  mediaType: "image/png" | "image/jpeg";
  originalBytes: number;
  compressedBytes: number;
  ratio: number;
  originalWidth: number;
  originalHeight: number;
  width: number;
  height: number;
  /** Human note for the user, set whenever anything actually shrank. */
  note?: string | undefined;
}

/** True when any pixel's alpha channel is below full opacity. */
export function bitmapHasAlpha(rgba: Uint8Array): boolean {
  for (let index = 3; index < rgba.length; index += 4) {
    if (rgba[index]! < 255) return true;
  }
  return false;
}

/** Fit the longer edge to the cap, preserving aspect ratio. */
export function fitLongerEdge(width: number, height: number, cap = MAX_IMAGE_EDGE): { width: number; height: number } {
  if (width <= cap && height <= cap) return { width, height };
  if (width >= height) {
    return { width: cap, height: Math.max(1, Math.round((height * cap) / width)) };
  }
  return { width: Math.max(1, Math.round((width * cap) / height)), height: cap };
}

export function pickOutputFormat(mediaType: string, hasAlpha: boolean): "png" | "jpeg" {
  if (mediaType.includes("png") && hasAlpha) return "png";
  return "jpeg";
}

/**
 * Compress one base64 image for context. Any failure resolves to
 * undefined and the caller passes the original through unchanged.
 */
export async function compressImageForContext(
  input: { base64: string; mediaType: string },
  processor: ImageProcessor | undefined,
  options?: { maxEdge?: number | undefined; jpegQuality?: number | undefined },
): Promise<CompressionOutcome | undefined> {
  if (!processor) return undefined;
  try {
    const bytes = Buffer.from(input.base64, "base64");
    const originalBytes = bytes.length;
    const bitmap = await processor.decode(bytes);
    if (!bitmap || bitmap.width <= 0 || bitmap.height <= 0) return undefined;

    const hasAlpha = bitmapHasAlpha(bitmap.rgba);
    const format = pickOutputFormat(input.mediaType, hasAlpha);
    const fitted = fitLongerEdge(bitmap.width, bitmap.height, options?.maxEdge ?? MAX_IMAGE_EDGE);
    const quality = options?.jpegQuality ?? JPEG_QUALITY;
    const encoded = await processor.resizeEncode(bitmap, {
      width: fitted.width,
      height: fitted.height,
      format,
      ...(format === "jpeg" ? { quality } : {}),
    });
    const compressedBytes = encoded.length;
    if (compressedBytes === 0) return undefined;
    const mediaTypeOut = format === "png" ? "image/png" : "image/jpeg";
    const note =
      compressedBytes < originalBytes
        ? `Image compressed ${Math.round((originalBytes / compressedBytes) * 10) / 10}x (${formatBytes(originalBytes)} → ${formatBytes(compressedBytes)}; ${bitmap.width}x${bitmap.height} → ${fitted.width}x${fitted.height}).`
        : undefined;
    return {
      compressedBase64: encoded.toString("base64"),
      mediaType: mediaTypeOut,
      originalBytes,
      compressedBytes,
      ratio: originalBytes / compressedBytes,
      originalWidth: bitmap.width,
      originalHeight: bitmap.height,
      width: fitted.width,
      height: fitted.height,
      note,
    };
  } catch {
    return undefined;
  }
}

/** True when compression is worth it: meaningful byte savings only. */
export function shouldCompress(outcome: CompressionOutcome): boolean {
  return outcome.compressedBytes < outcome.originalBytes && outcome.ratio >= 1.2;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * Lazy Jimp processor. Undefined when the optional dependency is absent —
 * callers pass the original image through, nothing fails.
 */
export async function loadJimpProcessor(): Promise<ImageProcessor | undefined> {
  try {
    const jimp = (await import("jimp")) as unknown as {
      default: {
        read(input: Buffer): Promise<{
          bitmap: { width: number; height: number; data: Uint8Array };
          resize(w: number, h: number): unknown;
          quality(q: number): unknown;
          getBufferAsync(mime: string): Promise<Buffer>;
        }>;
      };
    };
    const Jimp = jimp.default;
    if (!Jimp?.read) return undefined;
    return {
      async decode(bytes) {
        const image = await Jimp.read(bytes);
        return { width: image.bitmap.width, height: image.bitmap.height, rgba: image.bitmap.data };
      },
      async resizeEncode(bitmap, options) {
        const image = await Jimp.read(Buffer.from(bitmap.rgba));
        // Reuse raw pixels without a second decode round-trip.
        image.bitmap.width = bitmap.width;
        image.bitmap.height = bitmap.height;
        image.bitmap.data = bitmap.rgba;
        image.resize(options.width, options.height);
        if (options.format === "jpeg") image.quality(options.quality ?? JPEG_QUALITY);
        const mime = options.format === "png" ? "image/png" : "image/jpeg";
        return image.getBufferAsync(mime);
      },
    };
  } catch {
    return undefined;
  }
}
