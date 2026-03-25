import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

export type ConvertFormat = 'original' | 'webp' | 'avif';

export interface OptimizeResult {
  originalBytes: number;
  optimizedBytes: number;
  usedOriginal: boolean;
  skippedReason?: string;
  /** If a WebP/AVIF variant was generated alongside the main output */
  variants?: Array<{ format: ConvertFormat; path: string; bytes: number }>;
}

export interface OptimizeOptions {
  quality?: number;
  /** Generate additional format variants (webp/avif) alongside the original-format output */
  convertFormats?: ConvertFormat[];
}

const SUPPORTED_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif']);

export const extensionFromPath = (filePath: string) => path.extname(filePath).toLowerCase();

const EXT_FORMAT_MAP: Record<string, string> = {
  '.jpg': 'jpeg', '.jpeg': 'jpeg', '.png': 'png', '.webp': 'webp', '.avif': 'avif',
};

export const verifyMimeMatchesExtension = async (localPath: string): Promise<boolean> => {
  const expected = EXT_FORMAT_MAP[extensionFromPath(localPath)];
  if (!expected) return false;
  const meta = await sharp(localPath).metadata();
  return (meta.format || '').toLowerCase() === expected;
};

const qualityBySize = (bytes: number, min: number, mid: number, max: number) => {
  if (bytes > 4 * 1024 * 1024) return min;
  if (bytes > 2 * 1024 * 1024) return mid;
  return max;
};

/**
 * Generate a WebP or AVIF variant of the source image.
 * Returns the output path and byte size, or null if the variant is larger than the source.
 */
const generateVariant = async (
  inputPath: string,
  outputDir: string,
  format: 'webp' | 'avif',
  quality: number,
): Promise<{ format: ConvertFormat; path: string; bytes: number } | null> => {
  const baseName = path.basename(inputPath, path.extname(inputPath));
  const variantPath = path.join(outputDir, `${baseName}.${format}`);
  const image = sharp(inputPath, { animated: false });

  if (format === 'webp') {
    await image.webp({ quality, effort: 5 }).toFile(variantPath);
  } else {
    await image.avif({ quality, effort: 4 }).toFile(variantPath);
  }

  const variantBytes = fs.statSync(variantPath).size;
  const originalBytes = fs.statSync(inputPath).size;

  // Only keep the variant if it's actually smaller
  if (variantBytes >= originalBytes) {
    fs.unlinkSync(variantPath);
    return null;
  }

  return { format, path: variantPath, bytes: variantBytes };
};

export const optimizeImage = async (
  inputPath: string,
  outputPath: string,
  optionsOrQuality?: OptimizeOptions | number,
): Promise<OptimizeResult> => {
  // Backwards-compatible: accept bare number as quality
  const opts: OptimizeOptions = typeof optionsOrQuality === 'number'
    ? { quality: optionsOrQuality }
    : optionsOrQuality ?? {};

  const ext = extensionFromPath(inputPath);
  const originalBytes = fs.statSync(inputPath).size;
  const outDir = path.dirname(path.resolve(outputPath));
  fs.mkdirSync(outDir, { recursive: true });

  if (!SUPPORTED_EXT.has(ext)) {
    fs.copyFileSync(inputPath, outputPath);
    return {
      originalBytes,
      optimizedBytes: originalBytes,
      usedOriginal: true,
      skippedReason: `Unsupported extension: ${ext}`,
    };
  }

  const quality = opts.quality;
  const image = sharp(inputPath, { animated: false });

  if (ext === '.webp') {
    await image
      .webp({ quality: quality || qualityBySize(originalBytes, 70, 78, 85), effort: 5 })
      .toFile(outputPath);
  } else if (ext === '.avif') {
    await image
      .avif({ quality: quality || qualityBySize(originalBytes, 60, 70, 80), effort: 4 })
      .toFile(outputPath);
  } else if (ext === '.jpg' || ext === '.jpeg') {
    await image
      .jpeg({ quality: quality || qualityBySize(originalBytes, 75, 80, 85), mozjpeg: true })
      .toFile(outputPath);
  } else {
    await image
      .png({
        palette: true,
        quality: quality || 80,
        effort: 8,
        compressionLevel: 9,
      })
      .toFile(outputPath);
  }

  const optimizedBytes = fs.statSync(outputPath).size;

  let usedOriginal = false;
  let skippedReason: string | undefined;

  if (optimizedBytes > originalBytes) {
    fs.copyFileSync(inputPath, outputPath);
    usedOriginal = true;
    skippedReason = 'Optimized file is larger than original, keeping original';
  }

  // Generate additional format variants if requested
  const variants: Array<{ format: ConvertFormat; path: string; bytes: number }> = [];
  const convertFormats = (opts.convertFormats ?? []).filter(f => f !== 'original');
  const effectiveQuality = quality || qualityBySize(originalBytes, 70, 78, 85);

  for (const fmt of convertFormats) {
    if (fmt !== 'webp' && fmt !== 'avif') continue;
    // Don't convert to the same format
    if ((fmt === 'webp' && ext === '.webp') || (fmt === 'avif' && ext === '.avif')) continue;
    try {
      const variant = await generateVariant(inputPath, outDir, fmt, effectiveQuality);
      if (variant) variants.push(variant);
    } catch {
      // Variant generation is best-effort; skip on failure
    }
  }

  return {
    originalBytes,
    optimizedBytes: usedOriginal ? originalBytes : optimizedBytes,
    usedOriginal,
    skippedReason,
    variants: variants.length ? variants : undefined,
  };
};
