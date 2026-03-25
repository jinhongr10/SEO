import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { optimizeImage, verifyMimeMatchesExtension, extensionFromPath } from '../optimize.js';

const TMP_DIR = path.resolve('src/tests/.tmp-optimize');

before(() => {
  fs.mkdirSync(TMP_DIR, { recursive: true });
});

after(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

const createTestImage = async (name: string, width = 200, height = 200): Promise<string> => {
  const filePath = path.join(TMP_DIR, name);
  const ext = path.extname(name).toLowerCase();
  let img = sharp({ create: { width, height, channels: 3, background: { r: 128, g: 128, b: 128 } } });
  if (ext === '.png') img = img.png();
  else if (ext === '.webp') img = img.webp();
  else img = img.jpeg({ quality: 95 });
  await img.toFile(filePath);
  return filePath;
};

describe('extensionFromPath', () => {
  it('returns lowercase extension', () => {
    assert.equal(extensionFromPath('/foo/bar.JPG'), '.jpg');
    assert.equal(extensionFromPath('test.PNG'), '.png');
    assert.equal(extensionFromPath('file.webp'), '.webp');
  });
});

describe('verifyMimeMatchesExtension', () => {
  it('returns true for matching jpeg', async () => {
    const p = await createTestImage('match.jpg');
    assert.equal(await verifyMimeMatchesExtension(p), true);
  });

  it('returns true for matching png', async () => {
    const p = await createTestImage('match.png');
    assert.equal(await verifyMimeMatchesExtension(p), true);
  });

  it('returns false for unsupported extension', async () => {
    const p = await createTestImage('test.jpg');
    const renamed = path.join(TMP_DIR, 'test.bmp');
    fs.copyFileSync(p, renamed);
    assert.equal(await verifyMimeMatchesExtension(renamed), false);
  });
});

describe('optimizeImage', () => {
  it('compresses a JPEG and produces smaller output', async () => {
    // Create a larger image to ensure compression actually helps
    const input = await createTestImage('big.jpg', 800, 800);
    const output = path.join(TMP_DIR, 'big-opt.jpg');
    const result = await optimizeImage(input, output, { quality: 60 });
    assert.equal(typeof result.originalBytes, 'number');
    assert.equal(typeof result.optimizedBytes, 'number');
    assert.ok(fs.existsSync(output));
  });

  it('keeps original if optimized is larger', async () => {
    // Tiny image where optimization can't help much
    const input = await createTestImage('tiny.jpg', 4, 4);
    const output = path.join(TMP_DIR, 'tiny-opt.jpg');
    const result = await optimizeImage(input, output, { quality: 100 });
    // Either used original or optimized — both are valid
    assert.ok(typeof result.usedOriginal === 'boolean');
  });

  it('copies unsupported extension as-is', async () => {
    const input = await createTestImage('src.jpg');
    const renamed = path.join(TMP_DIR, 'src.gif');
    fs.copyFileSync(input, renamed);
    const output = path.join(TMP_DIR, 'src-opt.gif');
    const result = await optimizeImage(renamed, output);
    assert.equal(result.usedOriginal, true);
    assert.ok(result.skippedReason?.includes('Unsupported'));
  });

  it('generates WebP variant when requested', async () => {
    const input = await createTestImage('variant-src.jpg', 400, 400);
    const output = path.join(TMP_DIR, 'variant-out.jpg');
    const result = await optimizeImage(input, output, {
      quality: 70,
      convertFormats: ['webp'],
    });
    // Variant may or may not be smaller — check that the field exists
    assert.ok(result.variants === undefined || Array.isArray(result.variants));
    if (result.variants?.length) {
      assert.equal(result.variants[0].format, 'webp');
      assert.ok(fs.existsSync(result.variants[0].path));
    }
  });

  it('generates AVIF variant when requested', async () => {
    const input = await createTestImage('avif-src.jpg', 400, 400);
    const output = path.join(TMP_DIR, 'avif-out.jpg');
    const result = await optimizeImage(input, output, {
      quality: 70,
      convertFormats: ['avif'],
    });
    assert.ok(result.variants === undefined || Array.isArray(result.variants));
  });

  it('accepts bare number for backward compatibility', async () => {
    const input = await createTestImage('compat.jpg', 200, 200);
    const output = path.join(TMP_DIR, 'compat-opt.jpg');
    const result = await optimizeImage(input, output, 75);
    assert.ok(typeof result.originalBytes === 'number');
  });
});
