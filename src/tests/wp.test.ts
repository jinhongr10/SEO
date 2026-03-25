import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveRelativePath,
  isCloudflareChallengeResponse,
  normalizeReplaceMediaError,
  parseWpRenderedText,
  shouldBypassProxyAfterError,
  WPRequestError,
} from '../wp.js';

describe('deriveRelativePath', () => {
  it('uses media_details.file when available', () => {
    const result = deriveRelativePath({
      id: 1,
      source_url: 'https://example.com/wp-content/uploads/2024/01/image.jpg',
      media_details: { file: '2024/01/image.jpg' },
    });
    assert.equal(result, '2024/01/image.jpg');
  });

  it('strips leading slashes from media_details.file', () => {
    const result = deriveRelativePath({
      id: 2,
      source_url: 'https://example.com/wp-content/uploads/2024/01/image.jpg',
      media_details: { file: '/2024/01/image.jpg' },
    });
    assert.equal(result, '2024/01/image.jpg');
  });

  it('falls back to parsing source_url', () => {
    const result = deriveRelativePath({
      id: 3,
      source_url: 'https://example.com/wp-content/uploads/2024/02/photo.png',
    });
    assert.equal(result, '2024/02/photo.png');
  });

  it('throws for unparseable URL', () => {
    assert.throws(() => {
      deriveRelativePath({
        id: 4,
        source_url: 'https://example.com/random/path/image.jpg',
      });
    }, /Unable to derive/);
  });
});

describe('parseWpRenderedText', () => {
  it('strips HTML tags', () => {
    assert.equal(parseWpRenderedText('<p>Hello <strong>world</strong></p>'), 'Hello world');
  });

  it('decodes HTML entities', () => {
    assert.equal(parseWpRenderedText('Tom &amp; Jerry'), 'Tom & Jerry');
  });

  it('handles undefined input', () => {
    assert.equal(parseWpRenderedText(undefined), '');
  });

  it('normalizes whitespace', () => {
    assert.equal(parseWpRenderedText('  hello   world  '), 'hello world');
  });
});

describe('shouldBypassProxyAfterError', () => {
  it('detects ECONNREFUSED from error code', () => {
    const error = Object.assign(new Error('socket hangup'), { code: 'ECONNREFUSED' });
    assert.equal(shouldBypassProxyAfterError(error), true);
  });

  it('detects nested connection refused messages', () => {
    const error = new Error('proxy failure', { cause: new Error('connect ECONNREFUSED 127.0.0.1:7897') });
    assert.equal(shouldBypassProxyAfterError(error), true);
  });

  it('ignores unrelated network errors', () => {
    assert.equal(shouldBypassProxyAfterError(new Error('socket timeout')), false);
  });
});

describe('isCloudflareChallengeResponse', () => {
  it('detects cf-mitigated challenge responses', () => {
    assert.equal(
      isCloudflareChallengeResponse({
        status: 403,
        headers: { 'cf-mitigated': 'challenge' },
        data: '<html><title>Just a moment...</title></html>',
      }),
      true,
    );
  });

  it('ignores ordinary wordpress json errors', () => {
    assert.equal(
      isCloudflareChallengeResponse({
        status: 403,
        headers: { 'content-type': 'application/json' },
        data: { message: 'Sorry, you are not allowed to do that.' },
      }),
      false,
    );
  });
});

describe('normalizeReplaceMediaError', () => {
  it('rewrites cloudflare challenge errors with actionable guidance', () => {
    const error = normalizeReplaceMediaError({
      response: {
        status: 403,
        headers: { 'cf-mitigated': 'challenge' },
        data: '<html><title>Just a moment...</title></html>',
      },
      message: 'Request failed with status code 403',
    });

    assert.equal(error instanceof WPRequestError, true);
    assert.equal((error as WPRequestError).status, 403);
    assert.match(error.message, /Cloudflare challenge blocked REST media replacement/);
  });

  it('rewrites missing route errors', () => {
    const error = normalizeReplaceMediaError({
      response: {
        status: 404,
        headers: { 'content-type': 'application/json' },
        data: { code: 'rest_no_route', message: 'No route was found matching the URL and request method.' },
      },
      message: 'Request failed with status code 404',
    });

    assert.equal(error instanceof WPRequestError, true);
    assert.equal((error as WPRequestError).status, 404);
    assert.match(error.message, /endpoint is unavailable/);
  });

  it('rewrites generic forbidden errors with actionable guidance', () => {
    const error = normalizeReplaceMediaError({
      response: {
        status: 403,
        headers: { 'content-type': 'application/json' },
        data: { code: 'rest_forbidden', message: 'Sorry, you are not allowed to do that.' },
      },
      message: 'Request failed with status code 403',
    });

    assert.equal(error instanceof WPRequestError, true);
    assert.equal((error as WPRequestError).status, 403);
    assert.match(error.message, /use SFTP replacement/i);
  });
});
