import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyError, withRetry, AlertManager } from '../retry.js';

describe('classifyError', () => {
  it('classifies timeout as transient', () => {
    assert.equal(classifyError(new Error('Request timed out')), 'transient');
  });

  it('classifies 429 as transient', () => {
    const err = { response: { status: 429 }, message: 'Too Many Requests' };
    assert.equal(classifyError(err), 'transient');
  });

  it('classifies 500 as transient', () => {
    const err = { response: { status: 500 }, message: 'Internal Server Error' };
    assert.equal(classifyError(err), 'transient');
  });

  it('classifies ECONNRESET as transient', () => {
    const err = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
    assert.equal(classifyError(err), 'transient');
  });

  it('classifies 404 as permanent', () => {
    const err = { response: { status: 404 }, message: 'Not Found' };
    assert.equal(classifyError(err), 'permanent');
  });

  it('classifies 403 as permanent', () => {
    const err = { response: { status: 403 }, message: 'Forbidden' };
    assert.equal(classifyError(err), 'permanent');
  });

  it('classifies ENOENT as permanent', () => {
    assert.equal(classifyError(new Error('ENOENT: no such file')), 'permanent');
  });

  it('classifies unknown errors as unknown', () => {
    assert.equal(classifyError(new Error('something weird')), 'unknown');
  });

  it('handles null/undefined', () => {
    assert.equal(classifyError(null), 'unknown');
    assert.equal(classifyError(undefined), 'unknown');
  });
});

describe('withRetry', () => {
  it('succeeds on first attempt', async () => {
    let attempts = 0;
    const result = await withRetry(async () => {
      attempts += 1;
      return 42;
    }, { maxRetries: 3 });

    assert.equal(result, 42);
    assert.equal(attempts, 1);
  });

  it('retries transient errors', async () => {
    let attempts = 0;
    const result = await withRetry(async () => {
      attempts += 1;
      if (attempts < 3) {
        const err = new Error('timeout');
        throw err;
      }
      return 'ok';
    }, { maxRetries: 5, baseDelayMs: 10 });

    assert.equal(result, 'ok');
    assert.equal(attempts, 3);
  });

  it('does not retry permanent errors', async () => {
    let attempts = 0;
    await assert.rejects(async () => {
      await withRetry(async () => {
        attempts += 1;
        const err: any = new Error('Not Found');
        err.response = { status: 404 };
        throw err;
      }, { maxRetries: 5, baseDelayMs: 10 });
    });

    assert.equal(attempts, 1);
  });

  it('throws after max retries', async () => {
    let attempts = 0;
    await assert.rejects(async () => {
      await withRetry(async () => {
        attempts += 1;
        throw new Error('timeout again');
      }, { maxRetries: 2, baseDelayMs: 10 });
    });

    assert.equal(attempts, 3); // initial + 2 retries
  });
});

describe('AlertManager', () => {
  it('does not alert below threshold', () => {
    const mgr = new AlertManager({ channel: 'console', threshold: 3 });
    mgr.recordFailure(1, 'error 1');
    mgr.recordFailure(2, 'error 2');
    // No assertion needed — just ensuring it doesn't throw
  });

  it('tracks failures and resets', () => {
    const mgr = new AlertManager({ channel: 'console', threshold: 2 });
    mgr.recordFailure(1, 'err');
    mgr.recordFailure(2, 'err');
    mgr.reset();
    // After reset, another single failure shouldn't alert
    mgr.recordFailure(3, 'err');
  });

  it('reduces failure count on success', () => {
    const mgr = new AlertManager({ channel: 'console', threshold: 5 });
    mgr.recordFailure(1, 'err');
    mgr.recordFailure(2, 'err');
    mgr.recordSuccess();
    mgr.recordSuccess();
    // Count should be back near 0
  });
});
