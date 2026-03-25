import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { computeFileHash, hasFileChanged, IntervalScheduler } from '../scheduler.js';

const TMP_DIR = path.resolve('src/tests/.tmp-scheduler');

describe('computeFileHash', () => {
  it('returns consistent hash for same content', () => {
    fs.mkdirSync(TMP_DIR, { recursive: true });
    const p = path.join(TMP_DIR, 'hash-test.txt');
    fs.writeFileSync(p, 'hello world');
    const h1 = computeFileHash(p);
    const h2 = computeFileHash(p);
    assert.equal(h1, h2);
    assert.equal(h1.length, 64); // SHA-256 hex
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  });

  it('returns different hash for different content', () => {
    fs.mkdirSync(TMP_DIR, { recursive: true });
    const p1 = path.join(TMP_DIR, 'a.txt');
    const p2 = path.join(TMP_DIR, 'b.txt');
    fs.writeFileSync(p1, 'hello');
    fs.writeFileSync(p2, 'world');
    assert.notEqual(computeFileHash(p1), computeFileHash(p2));
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  });
});

describe('hasFileChanged', () => {
  it('returns true when no previous hash', () => {
    assert.equal(hasFileChanged('/nonexistent', undefined), true);
  });

  it('returns true when file does not exist', () => {
    assert.equal(hasFileChanged('/nonexistent/file.jpg', 'somehash'), true);
  });

  it('returns false when hash matches', () => {
    fs.mkdirSync(TMP_DIR, { recursive: true });
    const p = path.join(TMP_DIR, 'same.txt');
    fs.writeFileSync(p, 'test content');
    const hash = computeFileHash(p);
    assert.equal(hasFileChanged(p, hash), false);
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  });

  it('returns true when hash differs', () => {
    fs.mkdirSync(TMP_DIR, { recursive: true });
    const p = path.join(TMP_DIR, 'changed.txt');
    fs.writeFileSync(p, 'original');
    const hash = computeFileHash(p);
    fs.writeFileSync(p, 'modified');
    assert.equal(hasFileChanged(p, hash), true);
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  });
});

describe('IntervalScheduler', () => {
  it('runs task on schedule', async () => {
    let count = 0;
    const scheduler = new IntervalScheduler(
      async () => { count += 1; },
      { intervalMs: 50, runImmediately: true },
    );

    scheduler.start();
    await new Promise(r => setTimeout(r, 180));
    scheduler.stop();

    // Should have run at least 2 times (immediate + at least 1 interval)
    assert.ok(count >= 2, `Expected at least 2 runs, got ${count}`);
  });

  it('skips overlapping runs', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;

    const scheduler = new IntervalScheduler(
      async () => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise(r => setTimeout(r, 100));
        concurrent -= 1;
      },
      { intervalMs: 30, runImmediately: true },
    );

    scheduler.start();
    await new Promise(r => setTimeout(r, 250));
    scheduler.stop();

    assert.equal(maxConcurrent, 1, 'Should never have concurrent runs');
  });
});
