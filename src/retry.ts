import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

export type ErrorKind = 'transient' | 'permanent' | 'unknown';

const TRANSIENT_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN',
  'ENOTFOUND', 'ERR_SOCKET_TIMEOUT',
]);

const TRANSIENT_HTTP = new Set([408, 425, 429, 500, 502, 503, 504]);

const PERMANENT_HTTP = new Set([400, 401, 403, 404, 405, 410, 422]);

export const classifyError = (error: unknown): ErrorKind => {
  if (!error) return 'unknown';

  const err = error as any;

  // Axios-style HTTP errors
  const status = err.response?.status ?? err.status ?? err.code;
  if (typeof status === 'number') {
    if (TRANSIENT_HTTP.has(status)) return 'transient';
    if (PERMANENT_HTTP.has(status)) return 'permanent';
  }

  // Node.js system errors
  const code = err.code ?? err.errno;
  if (typeof code === 'string' && TRANSIENT_CODES.has(code)) return 'transient';

  // Timeout patterns
  const msg = String(err.message ?? err);
  if (/timeout|timed?\s*out|ETIMEDOUT/i.test(msg)) return 'transient';
  if (/rate.?limit|too many requests|429/i.test(msg)) return 'transient';

  // File not found, permission denied → permanent
  if (/ENOENT|EACCES|EPERM/i.test(msg)) return 'permanent';
  if (/not found|404/i.test(msg)) return 'permanent';

  return 'unknown';
};

// ---------------------------------------------------------------------------
// Smart retry with exponential backoff + jitter
// ---------------------------------------------------------------------------

export interface RetryOptions {
  maxRetries: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Only retry transient errors. Permanent errors fail immediately. */
  classifyErrors?: boolean;
}

const jitter = (ms: number) => ms + Math.random() * ms * 0.3;

export const withRetry = async <T>(
  fn: () => Promise<T>,
  opts: RetryOptions,
): Promise<T> => {
  const { maxRetries, baseDelayMs = 500, maxDelayMs = 15000, classifyErrors = true } = opts;
  let attempt = 0;

  while (true) {
    attempt += 1;
    try {
      return await fn();
    } catch (error) {
      const kind = classifyErrors ? classifyError(error) : 'transient';

      if (kind === 'permanent') {
        logger.warn({ attempt, kind }, 'Permanent error, no retry');
        throw error;
      }

      if (attempt > maxRetries) {
        logger.warn({ attempt, kind, maxRetries }, 'Max retries exceeded');
        throw error;
      }

      const delay = Math.min(maxDelayMs, jitter(baseDelayMs * 2 ** (attempt - 1)));
      logger.info({ attempt, kind, delayMs: Math.round(delay) }, 'Retrying after error');
      await new Promise(r => setTimeout(r, delay));
    }
  }
};

// ---------------------------------------------------------------------------
// Alert / notification system
// ---------------------------------------------------------------------------

export type AlertChannel = 'console' | 'webhook';

export interface AlertConfig {
  channel: AlertChannel;
  /** Webhook URL for posting alerts (used when channel = 'webhook') */
  webhookUrl?: string;
  /** Number of failures before triggering an alert */
  threshold: number;
}

export class AlertManager {
  private failureCount = 0;
  private lastAlertAt = 0;
  private readonly cooldownMs = 5 * 60 * 1000; // 5 min cooldown between alerts

  constructor(private readonly config: AlertConfig) {}

  recordFailure(mediaId: number, error: string) {
    this.failureCount += 1;
    if (this.failureCount >= this.config.threshold) {
      this.maybeSendAlert(mediaId, error);
    }
  }

  recordSuccess() {
    this.failureCount = Math.max(0, this.failureCount - 1);
  }

  reset() {
    this.failureCount = 0;
  }

  private maybeSendAlert(mediaId: number, error: string) {
    const now = Date.now();
    if (now - this.lastAlertAt < this.cooldownMs) return;
    this.lastAlertAt = now;

    const message = `[WP Media Optimizer] Alert: ${this.failureCount} failures reached threshold (${this.config.threshold}). Latest: media #${mediaId} — ${error}`;

    if (this.config.channel === 'webhook' && this.config.webhookUrl) {
      this.sendWebhookAlert(message);
    } else {
      logger.error(message);
    }
  }

  private async sendWebhookAlert(message: string) {
    try {
      const response = await fetch(this.config.webhookUrl!, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: message }),
      });
      if (!response.ok) {
        logger.warn({ status: response.status }, 'Alert webhook failed');
      }
    } catch (err) {
      logger.warn({ err }, 'Alert webhook request failed');
    }
  }
}
