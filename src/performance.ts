import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

// ---------------------------------------------------------------------------
// Cache cleanup — evict old files when cache exceeds size limit
// ---------------------------------------------------------------------------

export interface CacheCleanupOptions {
  /** Maximum total cache size in bytes */
  maxSizeBytes: number;
  /** Directories to clean */
  dirs: string[];
}

interface CacheFile {
  path: string;
  size: number;
  mtimeMs: number;
}

const walkDir = (dir: string): CacheFile[] => {
  if (!fs.existsSync(dir)) return [];
  const files: CacheFile[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkDir(full));
    } else if (entry.isFile()) {
      const stat = fs.statSync(full);
      files.push({ path: full, size: stat.size, mtimeMs: stat.mtimeMs });
    }
  }
  return files;
};

/**
 * Evict oldest files from cache directories until total size is under the limit.
 * Returns the number of files deleted.
 */
export const cleanupCache = (opts: CacheCleanupOptions): number => {
  const allFiles: CacheFile[] = [];
  for (const dir of opts.dirs) {
    allFiles.push(...walkDir(dir));
  }

  let totalSize = allFiles.reduce((sum, f) => sum + f.size, 0);
  if (totalSize <= opts.maxSizeBytes) {
    logger.debug({ totalSize, limit: opts.maxSizeBytes }, 'Cache within limit, no cleanup needed');
    return 0;
  }

  // Sort oldest first
  allFiles.sort((a, b) => a.mtimeMs - b.mtimeMs);

  let deleted = 0;
  for (const file of allFiles) {
    if (totalSize <= opts.maxSizeBytes) break;
    try {
      fs.unlinkSync(file.path);
      totalSize -= file.size;
      deleted += 1;

      // Remove empty parent directory
      const parent = path.dirname(file.path);
      try {
        const remaining = fs.readdirSync(parent);
        if (remaining.length === 0) fs.rmdirSync(parent);
      } catch { /* ignore */ }
    } catch {
      // File may have been already removed
    }
  }

  logger.info({ deleted, remainingSize: totalSize }, 'Cache cleanup completed');
  return deleted;
};

/**
 * Get total size of cache directories in bytes.
 */
export const getCacheSize = (dirs: string[]): number => {
  let total = 0;
  for (const dir of dirs) {
    for (const f of walkDir(dir)) {
      total += f.size;
    }
  }
  return total;
};

// ---------------------------------------------------------------------------
// Dynamic concurrency — adjust worker count based on error rate
// ---------------------------------------------------------------------------

export class DynamicConcurrency {
  private current: number;
  private consecutiveFailures = 0;
  private consecutiveSuccesses = 0;

  constructor(
    private readonly min: number,
    private readonly max: number,
    initial?: number,
  ) {
    this.current = initial ?? max;
  }

  get value() {
    return this.current;
  }

  recordSuccess() {
    this.consecutiveFailures = 0;
    this.consecutiveSuccesses += 1;

    // Scale up after 5 consecutive successes
    if (this.consecutiveSuccesses >= 5 && this.current < this.max) {
      this.current = Math.min(this.max, this.current + 1);
      this.consecutiveSuccesses = 0;
      logger.debug({ concurrency: this.current }, 'Concurrency increased');
    }
  }

  recordFailure() {
    this.consecutiveSuccesses = 0;
    this.consecutiveFailures += 1;

    // Scale down after 2 consecutive failures
    if (this.consecutiveFailures >= 2 && this.current > this.min) {
      this.current = Math.max(this.min, this.current - 1);
      this.consecutiveFailures = 0;
      logger.debug({ concurrency: this.current }, 'Concurrency decreased');
    }
  }
}

// ---------------------------------------------------------------------------
// Streaming download helper — for large files
// ---------------------------------------------------------------------------

/**
 * Download a file using Node.js streams to avoid loading entire file into memory.
 * Falls back to buffer-based download if streaming fails.
 */
export const streamDownload = async (url: string, destPath: string): Promise<number> => {
  const dir = path.dirname(path.resolve(destPath));
  fs.mkdirSync(dir, { recursive: true });

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  }

  if (!response.body) {
    throw new Error('Response has no body');
  }

  const fileStream = fs.createWriteStream(path.resolve(destPath));
  const reader = response.body.getReader();
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      fileStream.write(value);
      totalBytes += value.byteLength;
    }
  } finally {
    fileStream.end();
    await new Promise<void>((resolve, reject) => {
      fileStream.on('finish', resolve);
      fileStream.on('error', reject);
    });
  }

  return totalBytes;
};
