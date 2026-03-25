import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { StateDB } from '../db.js';

const TMP_DIR = path.resolve('src/tests/.tmp-db');
let db: StateDB;

before(() => {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  db = new StateDB(path.join(TMP_DIR, 'test.db'));
});

after(() => {
  db.close();
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

describe('StateDB', () => {
  it('upserts and retrieves media', () => {
    db.upsertScannedMedia({
      id: 1,
      sourceUrl: 'https://example.com/1.jpg',
      relativePath: '2024/01/1.jpg',
      filename: '1.jpg',
      mimeType: 'image/jpeg',
      title: 'Test Image',
      altText: 'Alt text',
      caption: 'Caption',
      description: 'Description',
      postId: 10,
      bytesOriginal: 50000,
    });

    const row = db.getMediaById(1);
    assert.ok(row);
    assert.equal(row.filename, '1.jpg');
    assert.equal(row.title, 'Test Image');
    assert.equal(row.status, 'scanned');
  });

  it('updates media status', () => {
    db.setMediaStatus(1, 'optimized', { bytes_optimized: 30000 });
    const row = db.getMediaById(1);
    assert.ok(row);
    assert.equal(row.status, 'optimized');
    assert.equal(row.bytes_optimized, 30000);
  });

  it('saves and retrieves metadata snapshot', () => {
    db.saveMetadataSnapshot(1, {
      title: 'Old Title',
      altText: 'Old Alt',
      caption: 'Old Caption',
      description: 'Old Description',
    });

    const snap = db.getLatestMetadataSnapshot(1);
    assert.ok(snap);
    assert.equal(snap.old_title, 'Old Title');
    assert.equal(snap.old_alt_text, 'Old Alt');
  });

  it('saves and retrieves backup records', () => {
    db.saveBackupRecord({
      media_id: 1,
      remote_path: '/var/www/uploads/2024/01/1.jpg',
      local_backup_path: '/tmp/backup/1/1.jpg',
      backup_size: 50000,
      created_at: new Date().toISOString(),
    });

    const rec = db.getBackupRecord(1);
    assert.ok(rec);
    assert.equal(rec.backup_size, 50000);
  });

  it('runs and finishes a run', () => {
    db.startRun('test-run-1', false);
    db.finishRun('test-run-1', {
      totalProcessed: 10,
      totalOptimized: 8,
      bytesSaved: 100000,
      failures: 2,
    });

    const report = db.getReport();
    assert.ok(report.lastRuns.length > 0);
    const run = report.lastRuns.find(r => r.run_id === 'test-run-1');
    assert.ok(run);
    assert.equal(run.total_processed, 10);
    assert.equal(run.bytes_saved, 100000);
  });

  it('saves and retrieves generated SEO', () => {
    db.saveGeneratedSeo({
      mediaId: 1,
      runId: 'test-run-1',
      title: 'SEO Title',
      altText: 'SEO Alt',
      caption: 'SEO Caption',
      description: 'SEO Description',
      keywordsMatched: ['soap dispenser'],
      categoryDetected: 'soap-dispenser',
      generator: 'none',
    });

    const seo = db.getLatestGeneratedSeo(1);
    assert.ok(seo);
    assert.equal(seo.title, 'SEO Title');
    assert.equal(seo.review_status, 'pending');
  });

  it('lists SEO for review', () => {
    const items = db.listGeneratedSeoForReview('pending', 100, 0);
    assert.ok(items.length > 0);
  });

  it('batch updates review status', () => {
    const seo = db.getLatestGeneratedSeo(1);
    assert.ok(seo);
    db.batchUpdateReviewStatus([seo.id], 'approved');
    const updated = db.getLatestGeneratedSeo(1);
    assert.ok(updated);
    assert.equal(updated.review_status, 'approved');
  });

  it('saves and retrieves file hashes', () => {
    db.saveFileHash(1, 'abc123hash', 50000);
    const hash = db.getFileHash(1);
    assert.ok(hash);
    assert.equal(hash.hash, 'abc123hash');
    assert.equal(hash.size, 50000);
  });

  it('lists media for run with filters', () => {
    db.upsertScannedMedia({
      id: 2,
      sourceUrl: 'https://example.com/2.png',
      relativePath: '2024/02/2.png',
      filename: '2.png',
      mimeType: 'image/png',
      title: 'PNG Image',
      altText: '',
      caption: '',
      description: '',
      bytesOriginal: 200000,
    });

    const filtered = db.listMediaForRun({ mime: 'png' }, true);
    assert.ok(filtered.some(r => r.filename === '2.png'));
  });

  it('generates a valid report', () => {
    const report = db.getReport();
    assert.ok(typeof report.totals.totalMedia === 'number');
    assert.ok(typeof report.totals.bytesSaved === 'number');
    assert.ok(Array.isArray(report.byStatus));
    assert.ok(Array.isArray(report.lastRuns));
    assert.ok(Array.isArray(report.failures));
  });
});
