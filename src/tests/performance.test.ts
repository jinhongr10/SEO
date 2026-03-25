import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { cleanupCache, getCacheSize, DynamicConcurrency } from '../performance.js';

const TMP_DIR = path.resolve('src/tests/.tmp-perf');

before(() => {
  fs.mkdirSync(TMP_DIR, { recursive: true });
});

after(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

const createFile = (name: string, sizeBytes: number, ageMs = 0) => {
  const filePath = path.join(TMP_DIR, name);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.alloc(sizeBytes, 0x42));
  if (ageMs) {
    const mtime = new Date(Date.now() - ageMs);
    fs.utimesSync(filePath, mtime, mtime);
  }
  return filePath;
};

describe('getCacheSize', () => {
  it('returns total size of all files', () => {
    createFile('size/a.dat', 1000);
    createFile('size/b.dat', 2000);
    const size = getCacheSize([path.join(TMP_DIR, 'size')]);
    assert.equal(size, 3000);
  });

  it('returns 0 for nonexistent directory', () => {
    assert.equal(getCacheSize(['/nonexistent/path/12345']), 0);
  });
});

describe('cleanupCache', () => {
  it('deletes oldest files to meet size limit', () => {
    const dir = path.join(TMP_DIR, 'cleanup');
    fs.mkdirSync(dir, { recursive: true });
    createFile('cleanup/old.dat', 5000, 100000);
    createFile('cleanup/mid.dat', 5000, 50000);
    createFile('cleanup/new.dat', 5000, 1000);

    // Total is 15000, limit to 6000 => should delete old + mid
    const deleted = cleanupCache({ maxSizeBytes: 6000, dirs: [dir] });
    assert.ok(deleted >= 1);
    assert.ok(getCacheSize([dir]) <= 6000);
    // The newest file should still exist
    assert.ok(fs.existsSync(path.join(TMP_DIR, 'cleanup/new.dat')));
  });

  it('does nothing when under limit', () => {
    const dir = path.join(TMP_DIR, 'noop');
    fs.mkdirSync(dir, { recursive: true });
    createFile('noop/a.dat', 100);
    const deleted = cleanupCache({ maxSizeBytes: 99999, dirs: [dir] });
    assert.equal(deleted, 0);
  });
});

describe('DynamicConcurrency', () => {
  it('starts at initial value', () => {
    const dc = new DynamicConcurrency(1, 10, 5);
    assert.equal(dc.value, 5);
  });

  it('defaults to max when no initial', () => {
    const dc = new DynamicConcurrency(1, 8);
    assert.equal(dc.value, 8);
  });

  it('increases after consecutive successes', () => {
    const dc = new DynamicConcurrency(1, 10, 3);
    for (let i = 0; i < 5; i++) dc.recordSuccess();
    assert.equal(dc.value, 4);
  });

  it('does not exceed max', () => {
    const dc = new DynamicConcurrency(1, 3, 3);
    for (let i = 0; i < 20; i++) dc.recordSuccess();
    assert.equal(dc.value, 3);
  });

  it('decreases after consecutive failures', () => {
    const dc = new DynamicConcurrency(1, 10, 5);
    dc.recordFailure();
    dc.recordFailure();
    assert.equal(dc.value, 4);
  });

  it('does not go below min', () => {
    const dc = new DynamicConcurrency(2, 10, 3);
    for (let i = 0; i < 20; i++) dc.recordFailure();
    assert.equal(dc.value, 2);
  });

  it('resets failure count on success', () => {
    const dc = new DynamicConcurrency(1, 10, 5);
    dc.recordFailure();
    dc.recordSuccess(); // resets consecutive failures
    dc.recordFailure(); // only 1 failure, not enough to decrease
    assert.equal(dc.value, 5);
  });
});
