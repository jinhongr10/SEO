import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

// ---------------------------------------------------------------------------
// Cron-like interval scheduler
// ---------------------------------------------------------------------------

export interface SchedulerOptions {
  /** Interval in milliseconds between runs */
  intervalMs: number;
  /** Whether to run immediately on start */
  runImmediately?: boolean;
}

export class IntervalScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly task: () => Promise<void>,
    private readonly opts: SchedulerOptions,
  ) {}

  start() {
    if (this.timer) return;
    logger.info({ intervalMs: this.opts.intervalMs }, 'Scheduler started');

    if (this.opts.runImmediately) {
      this.execute();
    }

    this.timer = setInterval(() => this.execute(), this.opts.intervalMs);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info('Scheduler stopped');
    }
  }

  get isRunning() {
    return this.running;
  }

  private async execute() {
    if (this.running) {
      logger.debug('Skipping scheduled run — previous run still in progress');
      return;
    }
    this.running = true;
    try {
      await this.task();
    } catch (err) {
      logger.error({ err }, 'Scheduled task failed');
    } finally {
      this.running = false;
    }
  }
}

// ---------------------------------------------------------------------------
// File hash-based change detection
// ---------------------------------------------------------------------------

export interface FileHashRecord {
  filePath: string;
  hash: string;
  size: number;
  checkedAt: string;
}

/**
 * Compute SHA-256 hash of a file for change detection.
 */
export const computeFileHash = (filePath: string): string => {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
};

/**
 * Compare a file's current hash against a stored hash.
 * Returns true if the file has changed (or was never hashed before).
 */
export const hasFileChanged = (filePath: string, previousHash?: string): boolean => {
  if (!previousHash) return true;
  if (!fs.existsSync(filePath)) return true;
  try {
    const currentHash = computeFileHash(filePath);
    return currentHash !== previousHash;
  } catch {
    return true;
  }
};

// ---------------------------------------------------------------------------
// Express middleware for WordPress webhook receiver
// ---------------------------------------------------------------------------

export interface WebhookPayload {
  action: string;
  attachment_id?: number;
  post_id?: number;
  source_url?: string;
}

/**
 * Create an Express route handler for WordPress webhook events.
 * Expects the WordPress site to POST to /api/webhook when media is uploaded.
 *
 * WordPress side can use:
 *   add_action('add_attachment', function($post_id) {
 *     wp_remote_post('http://your-server:8787/api/webhook', [
 *       'body' => json_encode(['action' => 'add_attachment', 'attachment_id' => $post_id]),
 *       'headers' => ['Content-Type' => 'application/json'],
 *     ]);
 *   });
 */
export const createWebhookHandler = (
  onMedia: (payload: WebhookPayload) => void,
  secret?: string,
) => {
  return (req: any, res: any) => {
    // Optional HMAC verification
    if (secret) {
      const sig = req.headers['x-webhook-signature'] as string | undefined;
      if (!sig) {
        res.status(401).json({ error: 'Missing signature' });
        return;
      }
      const body = JSON.stringify(req.body);
      const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
      if (sig !== expected) {
        res.status(403).json({ error: 'Invalid signature' });
        return;
      }
    }

    const payload = req.body as WebhookPayload;
    if (!payload.action) {
      res.status(400).json({ error: 'Missing action field' });
      return;
    }

    logger.info({ payload }, 'Webhook received');
    onMedia(payload);
    res.json({ ok: true });
  };
};
