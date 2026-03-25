import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';

export type MediaStatus =
  | 'scanned'
  | 'downloaded'
  | 'optimized'
  | 'uploaded'
  | 'updated'
  | 'dry_run'
  | 'skipped'
  | 'error'
  | 'rolled_back';

export interface MediaRow {
  id: number;
  source_url: string;
  relative_path: string;
  filename: string;
  mime_type: string | null;
  title: string;
  alt_text: string;
  caption: string;
  description: string;
  post_id: number | null;
  bytes_original: number | null;
  bytes_optimized: number | null;
  status: MediaStatus;
  error_reason: string | null;
  updated_at: string;
  last_scanned_at: string;
}

export interface ScanMediaInput {
  id: number;
  sourceUrl: string;
  relativePath: string;
  filename: string;
  mimeType?: string | null;
  title: string;
  altText: string;
  caption: string;
  description: string;
  postId?: number | null;
  bytesOriginal?: number | null;
}

export interface MediaFilter {
  since?: string;
  mime?: string;
  minSizeKb?: number;
  ids?: number[];
  limit?: number;
}

export interface BackupRecord {
  media_id: number;
  remote_path: string;
  local_backup_path: string;
  backup_size: number;
  created_at: string;
}

export interface GeneratedSeoRow {
  id: number;
  media_id: number;
  run_id: string | null;
  title: string;
  alt_text: string;
  caption: string;
  description: string;
  keywords_matched: string | null;
  category_detected: string | null;
  generator: string;
  review_status: string;
  created_at: string;
}

export interface GeneratedSeoInput {
  mediaId: number;
  runId?: string | null;
  title: string;
  altText: string;
  caption: string;
  description: string;
  keywordsMatched?: string[];
  categoryDetected?: string | null;
  generator: string;
}

export interface KeywordCategoryRow {
  id: number;
  slug: string;
  display_name: string;
  filename_patterns: string;
  keywords: string;
  created_at: string;
}

export type ProductStatus =
  | 'scanned'
  | 'processing'
  | 'generated'
  | 'updated'
  | 'error';

export interface ProductRow {
  id: number;
  name: string;
  slug: string;
  permalink: string;
  category_slugs: string;
  category_names: string;
  image_urls: string;
  short_ref_images: string;
  full_ref_images: string;
  status: ProductStatus;
  short_description: string;
  description: string;
  acf_seo_extra_info: string;
  aioseo_title: string;
  aioseo_title_raw: string;
  aioseo_description: string;
  aioseo_description_raw: string;
  raw_meta_scanned: number;
  error_reason: string | null;
  updated_at: string;
  last_scanned_at: string;
}

export interface ScanProductInput {
  id: number;
  name: string;
  slug: string;
  permalink: string;
  categorySlugs: string;
  categoryNames: string;
  imageUrls: string;
  shortDescription: string;
  description: string;
  acfSeoExtraInfo: string;
  aioseoTitle: string;
  aioseoTitleRaw: string;
  aioseoDescription: string;
  aioseoDescriptionRaw: string;
}

export interface GeneratedProductSeoRow {
  id: number;
  product_id: number;
  run_id: string | null;
  short_description: string;
  description: string;
  acf_seo_extra_info: string;
  aioseo_title: string;
  aioseo_description: string;
  generator: string;
  review_status: string;
  created_at: string;
}

export interface GeneratedProductSeoInput {
  productId: number;
  runId?: string | null;
  shortDescription: string;
  description: string;
  acfSeoExtraInfo: string;
  aioseoTitle: string;
  aioseoDescription: string;
  generator: string;
}


export class StateDB {
  private db: Database.Database;

  constructor(dbPath: string) {
    const fullPath = path.resolve(dbPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    this.db = new Database(fullPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.init();
  }

  private init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS media_items (
        id INTEGER PRIMARY KEY,
        source_url TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        filename TEXT NOT NULL,
        mime_type TEXT,
        title TEXT NOT NULL DEFAULT '',
        alt_text TEXT NOT NULL DEFAULT '',
        caption TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        post_id INTEGER,
        bytes_original INTEGER,
        bytes_optimized INTEGER,
        status TEXT NOT NULL DEFAULT 'scanned',
        error_reason TEXT,
        updated_at TEXT NOT NULL,
        last_scanned_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS metadata_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        media_id INTEGER NOT NULL,
        old_title TEXT NOT NULL DEFAULT '',
        old_alt_text TEXT NOT NULL DEFAULT '',
        old_caption TEXT NOT NULL DEFAULT '',
        old_description TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        FOREIGN KEY (media_id) REFERENCES media_items(id)
      );

      CREATE TABLE IF NOT EXISTS backup_records (
        media_id INTEGER PRIMARY KEY,
        remote_path TEXT NOT NULL,
        local_backup_path TEXT NOT NULL,
        backup_size INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (media_id) REFERENCES media_items(id)
      );

      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        dry_run INTEGER NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        total_processed INTEGER NOT NULL DEFAULT 0,
        total_optimized INTEGER NOT NULL DEFAULT 0,
        bytes_saved INTEGER NOT NULL DEFAULT 0,
        failures INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_media_status ON media_items(status);
      CREATE INDEX IF NOT EXISTS idx_media_updated_at ON media_items(updated_at);

      CREATE TABLE IF NOT EXISTS generated_seo (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        media_id INTEGER NOT NULL,
        run_id TEXT,
        title TEXT NOT NULL DEFAULT '',
        alt_text TEXT NOT NULL DEFAULT '',
        caption TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        keywords_matched TEXT,
        category_detected TEXT,
        generator TEXT NOT NULL DEFAULT 'none',
        review_status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        FOREIGN KEY (media_id) REFERENCES media_items(id)
      );
      CREATE INDEX IF NOT EXISTS idx_generated_seo_media ON generated_seo(media_id);
      CREATE INDEX IF NOT EXISTS idx_generated_seo_review ON generated_seo(review_status);

      -- File hash for change detection
      CREATE TABLE IF NOT EXISTS file_hashes (
        media_id INTEGER PRIMARY KEY,
        hash TEXT NOT NULL,
        size INTEGER NOT NULL,
        checked_at TEXT NOT NULL,
        FOREIGN KEY (media_id) REFERENCES media_items(id)
      );

      CREATE TABLE IF NOT EXISTS keyword_categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        filename_patterns TEXT NOT NULL,
        keywords TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS product_items (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT NOT NULL,
        permalink TEXT NOT NULL,
        category_slugs TEXT NOT NULL DEFAULT '',
        category_names TEXT NOT NULL DEFAULT '',
        image_urls TEXT NOT NULL DEFAULT '',
        short_ref_images TEXT NOT NULL DEFAULT '',
        full_ref_images TEXT NOT NULL DEFAULT '',
        short_description TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        acf_seo_extra_info TEXT NOT NULL DEFAULT '',
        aioseo_title TEXT NOT NULL DEFAULT '',
        aioseo_title_raw TEXT NOT NULL DEFAULT '',
        aioseo_description TEXT NOT NULL DEFAULT '',
        aioseo_description_raw TEXT NOT NULL DEFAULT '',
        raw_meta_scanned INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'scanned',
        error_reason TEXT,
        updated_at TEXT NOT NULL,
        last_scanned_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_product_status ON product_items(status);

      CREATE TABLE IF NOT EXISTS generated_product_seo (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER NOT NULL,
        run_id TEXT,
        short_description TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        acf_seo_extra_info TEXT NOT NULL DEFAULT '',
        aioseo_title TEXT NOT NULL DEFAULT '',
        aioseo_description TEXT NOT NULL DEFAULT '',
        generator TEXT NOT NULL DEFAULT 'none',
        review_status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        FOREIGN KEY (product_id) REFERENCES product_items(id)
      );
      CREATE INDEX IF NOT EXISTS idx_generated_product_seo_pid ON generated_product_seo(product_id);
    `);

    // Auto-migrate older product_items schema to include SEO columns.
    try { this.db.exec("ALTER TABLE product_items ADD COLUMN category_slugs TEXT NOT NULL DEFAULT ''"); } catch {}
    try { this.db.exec("ALTER TABLE product_items ADD COLUMN category_names TEXT NOT NULL DEFAULT ''"); } catch {}
    try { this.db.exec("ALTER TABLE product_items ADD COLUMN acf_seo_extra_info TEXT NOT NULL DEFAULT ''"); } catch {}
    try { this.db.exec("ALTER TABLE product_items ADD COLUMN aioseo_title TEXT NOT NULL DEFAULT ''"); } catch {}
    try { this.db.exec("ALTER TABLE product_items ADD COLUMN aioseo_title_raw TEXT NOT NULL DEFAULT ''"); } catch {}
    try { this.db.exec("ALTER TABLE product_items ADD COLUMN aioseo_description TEXT NOT NULL DEFAULT ''"); } catch {}
    try { this.db.exec("ALTER TABLE product_items ADD COLUMN aioseo_description_raw TEXT NOT NULL DEFAULT ''"); } catch {}
    try { this.db.exec("ALTER TABLE product_items ADD COLUMN raw_meta_scanned INTEGER NOT NULL DEFAULT 0"); } catch {}
    try { this.db.exec("ALTER TABLE product_items ADD COLUMN image_urls TEXT NOT NULL DEFAULT ''"); } catch {}
    try { this.db.exec("ALTER TABLE product_items ADD COLUMN short_ref_images TEXT NOT NULL DEFAULT ''"); } catch {}
    try { this.db.exec("ALTER TABLE product_items ADD COLUMN full_ref_images TEXT NOT NULL DEFAULT ''"); } catch {}
    try { this.db.exec("ALTER TABLE product_items ADD COLUMN description_alt_texts TEXT NOT NULL DEFAULT ''"); } catch {}
  }

  upsertScannedMedia(item: ScanMediaInput) {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO media_items (
        id, source_url, relative_path, filename, mime_type, title, alt_text, caption, description,
        post_id, bytes_original, bytes_optimized, status, error_reason, updated_at, last_scanned_at
      ) VALUES (
        @id, @source_url, @relative_path, @filename, @mime_type, @title, @alt_text, @caption, @description,
        @post_id, @bytes_original, NULL, 'scanned', NULL, @updated_at, @last_scanned_at
      )
      ON CONFLICT(id) DO UPDATE SET
        source_url = excluded.source_url,
        relative_path = excluded.relative_path,
        filename = excluded.filename,
        mime_type = excluded.mime_type,
        title = excluded.title,
        alt_text = excluded.alt_text,
        caption = excluded.caption,
        description = excluded.description,
        post_id = excluded.post_id,
        bytes_original = excluded.bytes_original,
        last_scanned_at = excluded.last_scanned_at,
        updated_at = excluded.updated_at
    `);
    stmt.run({
      id: item.id,
      source_url: item.sourceUrl,
      relative_path: item.relativePath,
      filename: item.filename,
      mime_type: item.mimeType ?? null,
      title: item.title,
      alt_text: item.altText,
      caption: item.caption,
      description: item.description,
      post_id: item.postId ?? null,
      bytes_original: item.bytesOriginal ?? null,
      updated_at: now,
      last_scanned_at: now,
    });
  }

  setMediaStatus(mediaId: number, status: MediaStatus, fields?: Partial<Pick<MediaRow, 'bytes_original' | 'bytes_optimized' | 'error_reason'>>) {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      UPDATE media_items
      SET status = @status,
          bytes_original = COALESCE(@bytes_original, bytes_original),
          bytes_optimized = COALESCE(@bytes_optimized, bytes_optimized),
          error_reason = @error_reason,
          updated_at = @updated_at
      WHERE id = @id
    `);
    stmt.run({
      id: mediaId,
      status,
      bytes_original: fields?.bytes_original ?? null,
      bytes_optimized: fields?.bytes_optimized ?? null,
      error_reason: fields?.error_reason ?? null,
      updated_at: now,
    });
  }

  saveMetadataSnapshot(mediaId: number, oldMeta: { title: string; altText: string; caption: string; description: string }) {
    const stmt = this.db.prepare(`
      INSERT INTO metadata_snapshots (media_id, old_title, old_alt_text, old_caption, old_description, created_at)
      VALUES (@media_id, @old_title, @old_alt_text, @old_caption, @old_description, @created_at)
    `);
    stmt.run({
      media_id: mediaId,
      old_title: oldMeta.title,
      old_alt_text: oldMeta.altText,
      old_caption: oldMeta.caption,
      old_description: oldMeta.description,
      created_at: new Date().toISOString(),
    });
  }

  getLatestMetadataSnapshot(mediaId: number) {
    const stmt = this.db.prepare(`
      SELECT old_title, old_alt_text, old_caption, old_description
      FROM metadata_snapshots
      WHERE media_id = ?
      ORDER BY id DESC
      LIMIT 1
    `);
    return stmt.get(mediaId) as
      | {
        old_title: string;
        old_alt_text: string;
        old_caption: string;
        old_description: string;
      }
      | undefined;
  }

  saveBackupRecord(record: BackupRecord) {
    const stmt = this.db.prepare(`
      INSERT INTO backup_records (media_id, remote_path, local_backup_path, backup_size, created_at)
      VALUES (@media_id, @remote_path, @local_backup_path, @backup_size, @created_at)
      ON CONFLICT(media_id) DO UPDATE SET
        remote_path = excluded.remote_path,
        local_backup_path = excluded.local_backup_path,
        backup_size = excluded.backup_size,
        created_at = excluded.created_at
    `);
    stmt.run(record);
  }

  getBackupRecord(mediaId: number) {
    const stmt = this.db.prepare(`SELECT * FROM backup_records WHERE media_id = ? LIMIT 1`);
    return stmt.get(mediaId) as BackupRecord | undefined;
  }

  getMediaById(mediaId: number) {
    const stmt = this.db.prepare(`SELECT * FROM media_items WHERE id = ?`);
    return stmt.get(mediaId) as MediaRow | undefined;
  }

  listMediaForRun(filters: MediaFilter, includeDone = false) {
    const where: string[] = [];
    const params: Record<string, unknown> = {};

    if (!includeDone) {
      where.push(`status NOT IN ('updated', 'rolled_back')`);
    }

    if (filters.since) {
      where.push('last_scanned_at >= @since');
      params.since = filters.since;
    }

    if (filters.mime) {
      where.push("LOWER(COALESCE(mime_type, '')) LIKE @mime");
      params.mime = `%${filters.mime.toLowerCase()}%`;
    }

    if (typeof filters.minSizeKb === 'number' && Number.isFinite(filters.minSizeKb)) {
      where.push('(bytes_original IS NULL OR bytes_original >= @minBytes)');
      params.minBytes = Math.floor(filters.minSizeKb * 1024);
    }

    if (filters.ids?.length) {
      const names = filters.ids.map((id, index) => {
        const key = `id${index}`;
        params[key] = id;
        return `@${key}`;
      });
      where.push(`id IN (${names.join(',')})`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limitSql = filters.limit ? `LIMIT ${Math.max(1, filters.limit)}` : '';

    const stmt = this.db.prepare(`
      SELECT * FROM media_items
      ${whereSql}
      ORDER BY id ASC
      ${limitSql}
    `);

    return stmt.all(params) as MediaRow[];
  }

  startRun(runId: string, dryRun: boolean) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO runs (run_id, dry_run, started_at, finished_at, total_processed, total_optimized, bytes_saved, failures)
      VALUES (@run_id, @dry_run, @started_at, NULL, 0, 0, 0, 0)
    `);
    stmt.run({
      run_id: runId,
      dry_run: dryRun ? 1 : 0,
      started_at: new Date().toISOString(),
    });
  }

  finishRun(runId: string, summary: { totalProcessed: number; totalOptimized: number; bytesSaved: number; failures: number }) {
    const stmt = this.db.prepare(`
      UPDATE runs
      SET finished_at = @finished_at,
          total_processed = @total_processed,
          total_optimized = @total_optimized,
          bytes_saved = @bytes_saved,
          failures = @failures
      WHERE run_id = @run_id
    `);
    stmt.run({
      run_id: runId,
      finished_at: new Date().toISOString(),
      total_processed: summary.totalProcessed,
      total_optimized: summary.totalOptimized,
      bytes_saved: summary.bytesSaved,
      failures: summary.failures,
    });
  }

  getReport() {
    const counts = this.db.prepare(`
      SELECT status, COUNT(*) AS total
      FROM media_items
      GROUP BY status
    `).all() as Array<{ status: string; total: number }>;

    const totals = this.db.prepare(`
      SELECT
        COUNT(*) AS total_media,
        SUM(CASE WHEN bytes_original IS NOT NULL AND bytes_optimized IS NOT NULL AND bytes_original > bytes_optimized THEN bytes_original - bytes_optimized ELSE 0 END) AS bytes_saved,
        SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS failures
      FROM media_items
    `).get() as { total_media: number; bytes_saved: number; failures: number };

    const lastRuns = this.db.prepare(`
      SELECT run_id, dry_run, started_at, finished_at, total_processed, total_optimized, bytes_saved, failures
      FROM runs
      ORDER BY started_at DESC
      LIMIT 10
    `).all() as Array<{
      run_id: string;
      dry_run: number;
      started_at: string;
      finished_at: string | null;
      total_processed: number;
      total_optimized: number;
      bytes_saved: number;
      failures: number;
    }>;

    const failures = this.db.prepare(`
      SELECT id, filename, error_reason, updated_at
      FROM media_items
      WHERE status = 'error'
      ORDER BY updated_at DESC
      LIMIT 50
    `).all() as Array<{
      id: number;
      filename: string;
      error_reason: string | null;
      updated_at: string;
    }>;

    return {
      totals: {
        totalMedia: totals.total_media ?? 0,
        bytesSaved: totals.bytes_saved ?? 0,
        failures: totals.failures ?? 0,
      },
      byStatus: counts,
      lastRuns,
      failures,
    };
  }

  // --- Generated SEO methods ---

  saveGeneratedSeo(input: GeneratedSeoInput) {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO generated_seo (media_id, run_id, title, alt_text, caption, description, keywords_matched, category_detected, generator, review_status, created_at)
      VALUES (@media_id, @run_id, @title, @alt_text, @caption, @description, @keywords_matched, @category_detected, @generator, 'pending', @created_at)
    `);
    stmt.run({
      media_id: input.mediaId,
      run_id: input.runId ?? null,
      title: input.title,
      alt_text: input.altText,
      caption: input.caption,
      description: input.description,
      keywords_matched: input.keywordsMatched ? JSON.stringify(input.keywordsMatched) : null,
      category_detected: input.categoryDetected ?? null,
      generator: input.generator,
      created_at: now,
    });
  }

  getLatestGeneratedSeo(mediaId: number): GeneratedSeoRow | undefined {
    return this.db.prepare(`
      SELECT * FROM generated_seo WHERE media_id = ? ORDER BY id DESC LIMIT 1
    `).get(mediaId) as GeneratedSeoRow | undefined;
  }

  listGeneratedSeoForReview(reviewStatus = 'pending', limit = 100, offset = 0) {
    return this.db.prepare(`
      SELECT gs.*, m.filename, m.source_url, m.mime_type,
             m.title AS orig_title, m.alt_text AS orig_alt_text,
             m.caption AS orig_caption, m.description AS orig_description,
             m.bytes_original, m.bytes_optimized
      FROM generated_seo gs
      JOIN media_items m ON m.id = gs.media_id
      WHERE gs.review_status = @review_status
        AND gs.id = (SELECT MAX(g2.id) FROM generated_seo g2 WHERE g2.media_id = gs.media_id)
      ORDER BY gs.id DESC
      LIMIT @limit OFFSET @offset
    `).all({ review_status: reviewStatus, limit, offset }) as Array<GeneratedSeoRow & Record<string, unknown>>;
  }

  countGeneratedSeoForReview(reviewStatus = 'pending'): number {
    const row = this.db.prepare(`
      SELECT COUNT(DISTINCT media_id) AS cnt FROM generated_seo WHERE review_status = @review_status
    `).get({ review_status: reviewStatus }) as { cnt: number };
    return row.cnt;
  }

  updateGeneratedSeo(id: number, fields: { title?: string; alt_text?: string; caption?: string; description?: string; review_status?: string }) {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id };
    if (fields.title !== undefined) { sets.push('title = @title'); params.title = fields.title; }
    if (fields.alt_text !== undefined) { sets.push('alt_text = @alt_text'); params.alt_text = fields.alt_text; }
    if (fields.caption !== undefined) { sets.push('caption = @caption'); params.caption = fields.caption; }
    if (fields.description !== undefined) { sets.push('description = @description'); params.description = fields.description; }
    if (fields.review_status !== undefined) { sets.push('review_status = @review_status'); params.review_status = fields.review_status; }
    if (!sets.length) return;
    this.db.prepare(`UPDATE generated_seo SET ${sets.join(', ')} WHERE id = @id`).run(params);
  }

  batchUpdateReviewStatus(ids: number[], status: string) {
    const stmt = this.db.prepare(`UPDATE generated_seo SET review_status = ? WHERE id = ?`);
    const tx = this.db.transaction((items: number[]) => {
      for (const id of items) stmt.run(status, id);
    });
    tx(ids);
  }

  // --- Keyword categories ---

  upsertKeywordCategory(slug: string, displayName: string, patterns: string[], keywords: string[]) {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO keyword_categories (slug, display_name, filename_patterns, keywords, created_at)
      VALUES (@slug, @display_name, @filename_patterns, @keywords, @created_at)
      ON CONFLICT(slug) DO UPDATE SET
        display_name = excluded.display_name,
        filename_patterns = excluded.filename_patterns,
        keywords = excluded.keywords
    `).run({
      slug,
      display_name: displayName,
      filename_patterns: JSON.stringify(patterns),
      keywords: JSON.stringify(keywords),
      created_at: now,
    });
  }

  listKeywordCategories(): KeywordCategoryRow[] {
    return this.db.prepare(`SELECT * FROM keyword_categories ORDER BY slug`).all() as KeywordCategoryRow[];
  }

  // --- File hash change detection ---

  saveFileHash(mediaId: number, hash: string, size: number) {
    this.db.prepare(`
      INSERT INTO file_hashes (media_id, hash, size, checked_at)
      VALUES (@media_id, @hash, @size, @checked_at)
      ON CONFLICT(media_id) DO UPDATE SET
        hash = excluded.hash,
        size = excluded.size,
        checked_at = excluded.checked_at
    `).run({
      media_id: mediaId,
      hash,
      size,
      checked_at: new Date().toISOString(),
    });
  }

  getFileHash(mediaId: number): { hash: string; size: number } | undefined {
    return this.db.prepare(`SELECT hash, size FROM file_hashes WHERE media_id = ?`).get(mediaId) as
      | { hash: string; size: number }
      | undefined;
  }

  // --- Product SEO methods ---

  upsertScannedProduct(item: ScanProductInput) {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO product_items (
        id, name, slug, permalink, category_slugs, category_names, image_urls, short_description, description,
        acf_seo_extra_info, aioseo_title, aioseo_title_raw, aioseo_description, aioseo_description_raw, raw_meta_scanned,
        status, error_reason, updated_at, last_scanned_at
      ) VALUES (
        @id, @name, @slug, @permalink, @category_slugs, @category_names, @image_urls, @short_description, @description,
        @acf_seo_extra_info, @aioseo_title, @aioseo_title_raw, @aioseo_description, @aioseo_description_raw, 1,
        'scanned', NULL, @updated_at, @last_scanned_at
      )
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        slug = excluded.slug,
        permalink = excluded.permalink,
        category_slugs = excluded.category_slugs,
        category_names = excluded.category_names,
        image_urls = excluded.image_urls,
        short_description = excluded.short_description,
        description = excluded.description,
        acf_seo_extra_info = excluded.acf_seo_extra_info,
        aioseo_title = excluded.aioseo_title,
        aioseo_title_raw = excluded.aioseo_title_raw,
        aioseo_description = excluded.aioseo_description,
        aioseo_description_raw = excluded.aioseo_description_raw,
        raw_meta_scanned = excluded.raw_meta_scanned,
        last_scanned_at = excluded.last_scanned_at,
        updated_at = excluded.updated_at
    `);
    stmt.run({
      id: item.id,
      name: item.name,
      slug: item.slug,
      permalink: item.permalink,
      category_slugs: item.categorySlugs,
      category_names: item.categoryNames,
      image_urls: item.imageUrls,
      short_description: item.shortDescription,
      description: item.description,
      acf_seo_extra_info: item.acfSeoExtraInfo,
      aioseo_title: item.aioseoTitle,
      aioseo_title_raw: item.aioseoTitleRaw,
      aioseo_description: item.aioseoDescription,
      aioseo_description_raw: item.aioseoDescriptionRaw,
      updated_at: now,
      last_scanned_at: now,
    });
  }

  setProductStatus(productId: number, status: ProductStatus, errorReason?: string | null) {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE product_items
      SET status = @status,
          error_reason = COALESCE(@error_reason, error_reason),
          updated_at = @updated_at
      WHERE id = @id
    `).run({
      id: productId,
      status,
      error_reason: errorReason ?? null,
      updated_at: now,
    });
  }

  getProductById(productId: number): ProductRow | undefined {
    return this.db.prepare(`SELECT * FROM product_items WHERE id = ?`).get(productId) as ProductRow | undefined;
  }

  listProductsForRun(ids?: number[], includeDone = false): ProductRow[] {
    let query = `SELECT * FROM product_items`;
    const where: string[] = [];
    const params: Record<string, unknown> = {};

    if (!includeDone) {
      where.push(`status NOT IN ('updated')`);
    }

    if (ids?.length) {
      const names = ids.map((id, index) => {
        const key = `id${index}`;
        params[key] = id;
        return `@${key}`;
      });
      where.push(`id IN (${names.join(',')})`);
    }

    if (where.length) {
      query += ` WHERE ${where.join(' AND ')}`;
    }
    query += ` ORDER BY id ASC`;

    return this.db.prepare(query).all(params) as ProductRow[];
  }

  saveGeneratedProductSeo(input: GeneratedProductSeoInput) {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO generated_product_seo(
          product_id, run_id, short_description, description, acf_seo_extra_info,
          aioseo_title, aioseo_description, generator, review_status, created_at
        ) VALUES(
          @product_id, @run_id, @short_description, @description, @acf_seo_extra_info,
          @aioseo_title, @aioseo_description, @generator, 'pending', @created_at
        )
          `).run({
      product_id: input.productId,
      run_id: input.runId ?? null,
      short_description: input.shortDescription,
      description: input.description,
      acf_seo_extra_info: input.acfSeoExtraInfo,
      aioseo_title: input.aioseoTitle,
      aioseo_description: input.aioseoDescription,
      generator: input.generator,
      created_at: now,
    });
  }

  listGeneratedProductSeoForReview(reviewStatus = 'pending', limit = 100, offset = 0) {
    return this.db.prepare(`
      SELECT gs.*, p.name, p.slug, p.permalink,
          p.short_description AS orig_short_description,
            p.description AS orig_description
      FROM generated_product_seo gs
      JOIN product_items p ON p.id = gs.product_id
      WHERE gs.review_status = @review_status
        AND gs.id = (SELECT MAX(g2.id) FROM generated_product_seo g2 WHERE g2.product_id = gs.product_id)
      ORDER BY gs.id DESC
      LIMIT @limit OFFSET @offset
        `).all({ review_status: reviewStatus, limit, offset }) as Array<GeneratedProductSeoRow & Record<string, unknown>>;
  }

  countGeneratedProductSeoForReview(reviewStatus = 'pending'): number {
    const row = this.db.prepare(`
      SELECT COUNT(DISTINCT product_id) AS cnt FROM generated_product_seo WHERE review_status = @review_status
        `).get({ review_status: reviewStatus }) as { cnt: number };
    return row.cnt;
  }

  updateGeneratedProductSeo(id: number, fields: Partial<Omit<GeneratedProductSeoRow, 'id' | 'product_id' | 'run_id' | 'created_at'>>) {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id };
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) {
        sets.push(`${key} = @${key}`);
        params[key] = value;
      }
    }
    if (!sets.length) return;
    this.db.prepare(`UPDATE generated_product_seo SET ${sets.join(', ')} WHERE id = @id`).run(params);
  }

  batchUpdateProductReviewStatus(ids: number[], status: string) {
    const stmt = this.db.prepare(`UPDATE generated_product_seo SET review_status = ? WHERE id = ?`);
    const tx = this.db.transaction((items: number[]) => {
      for (const id of items) stmt.run(status, id);
    });
    tx(ids);
  }

  close() {
    this.db.close();
  }
}
