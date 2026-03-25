import fs from 'node:fs';
import path from 'node:path';
import axios, { AxiosError, AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';

export interface WPMediaItem {
  id: number;
  date?: string;
  media_type?: string;
  mime_type?: string;
  source_url: string;
  post?: number;
  title?: { rendered?: string };
  alt_text?: string;
  caption?: { rendered?: string };
  description?: { rendered?: string };
  media_details?: {
    file?: string;
    filesize?: number;
  };
}

export interface WPProductItem {
  id: number;
  name: string;
  slug: string;
  permalink: string;
  type: string;
  status: string;
  categories?: Array<{
    id: number;
    name: string;
    slug: string;
  }>;
  description: string;
  short_description: string;
  meta_data: Array<{
    id?: number;
    key: string;
    value: string | any;
  }>;
  images?: Array<{
    id?: number;
    src?: string;
    alt?: string;
    name?: string;
  }>;
}

export interface ProductSeoPreview {
  title: string;
  description: string;
}


export interface WPClientOptions {
  baseUrl: string;
  user?: string;
  appPassword?: string;
  jwt?: string;
  wcConsumerKey?: string;
  wcConsumerSecret?: string;
  timeoutMs?: number;
  retries?: number;
  rateLimitMs?: number;
}

interface MediaMetadataUpdate {
  alt_text: string;
  title: string;
  caption: string;
  description: string;
}

type HttpHeadersLike = Record<string, unknown> | undefined;

interface HttpErrorDetails {
  status?: number;
  headers?: HttpHeadersLike;
  data?: unknown;
}

export class WPRequestError extends Error {
  status?: number;
  code?: string;
  headers?: HttpHeadersLike;
  responseData?: unknown;

  constructor(
    message: string,
    opts?: {
      status?: number;
      code?: string;
      headers?: HttpHeadersLike;
      responseData?: unknown;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = 'WPRequestError';
    this.status = opts?.status;
    this.code = opts?.code;
    this.headers = opts?.headers;
    this.responseData = opts?.responseData;
    if (opts?.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = opts.cause;
    }
  }
}

export interface ProductMetadataUpdate {
  short_description: string;
  description: string;
  meta_data: Array<{
    id?: number;
    key: string;
    value: string;
  }>;
}

const RETRYABLE_HTTP = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const getProxyUrl = () =>
  process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const headerValue = (headers: HttpHeadersLike, name: string): string => {
  if (!headers) return '';
  const candidate = headers as Record<string, unknown> & { get?: (key: string) => unknown };
  const viaGetter = typeof candidate.get === 'function'
    ? candidate.get(name) ?? candidate.get(name.toLowerCase())
    : undefined;
  const direct = viaGetter ?? candidate[name] ?? candidate[name.toLowerCase()];
  return direct === undefined || direct === null ? '' : String(direct);
};

const bodySnippet = (data: unknown): string => {
  if (typeof data === 'string') return data;
  try {
    return JSON.stringify(data);
  } catch {
    return '';
  }
};

const getHttpErrorDetails = (error: unknown): HttpErrorDetails => {
  const response = (error as AxiosError | { response?: HttpErrorDetails })?.response;
  if (!response) {
    return {
      status: typeof (error as any)?.status === 'number' ? (error as any).status : undefined,
      headers: (error as any)?.headers,
      data: (error as any)?.responseData,
    };
  }
  return {
    status: response.status,
    headers: response.headers,
    data: response.data,
  };
};

export const isCloudflareChallengeResponse = (details: HttpErrorDetails): boolean => {
  const cfMitigated = headerValue(details.headers, 'cf-mitigated').toLowerCase();
  if (cfMitigated === 'challenge') return true;

  const status = details.status;
  if (status !== 403 && status !== 503) return false;

  const body = bodySnippet(details.data).toLowerCase();
  return (
    body.includes('just a moment') ||
    body.includes('enable javascript and cookies to continue') ||
    body.includes('/cdn-cgi/challenge-platform/') ||
    body.includes('_cf_chl_opt')
  );
};

const responseMessage = (data: unknown): string => {
  if (!data) return '';
  if (typeof data === 'string') return data.trim();
  if (typeof data === 'object') {
    const message = (data as Record<string, unknown>).message;
    if (typeof message === 'string') return message.trim();
  }
  return '';
};

const responseCode = (data: unknown): string => {
  if (!data || typeof data !== 'object') return '';
  const code = (data as Record<string, unknown>).code;
  return typeof code === 'string' ? code.trim() : '';
};

export const normalizeReplaceMediaError = (error: unknown): Error => {
  const { status, headers, data } = getHttpErrorDetails(error);

  if (isCloudflareChallengeResponse({ status, headers, data })) {
    return new WPRequestError(
      'Cloudflare challenge blocked REST media replacement. Configure SFTP fallback or bypass /wp-json/lenscraft/v1/media/* in Cloudflare.',
      {
        status: status ?? 403,
        code: 'CF_CHALLENGE',
        headers,
        responseData: data,
        cause: error,
      },
    );
  }

  if (status === 404) {
    return new WPRequestError(
      'LensCraft REST media replace endpoint is unavailable (HTTP 404). Install/activate the LensCraft Direct Sync plugin or use SFTP replacement.',
      {
        status,
        code: 'REST_REPLACE_ROUTE_MISSING',
        headers,
        responseData: data,
        cause: error,
      },
    );
  }

  if (status === 401 || status === 403) {
    const message = responseMessage(data);
    const code = responseCode(data).toLowerCase();
    const isForbidden = status === 403;
    const fallbackMessage = isForbidden
      ? 'REST media replacement was rejected by WordPress (HTTP 403). Check the LensCraft Direct Sync plugin permissions or use SFTP replacement.'
      : 'REST media replacement requires valid WordPress credentials (HTTP 401). Recheck the application password or use SFTP replacement.';

    if (message) {
      const shouldUseGenericMessage =
        (isForbidden && message.toLowerCase() === 'sorry, you are not allowed to do that.') ||
        code === 'rest_forbidden' ||
        code === 'rest_cannot_create';
      return new WPRequestError(
        shouldUseGenericMessage ? fallbackMessage : `${fallbackMessage} Detail: ${message}`,
        {
          status,
          code: isForbidden ? 'REST_REPLACE_FORBIDDEN' : 'REST_REPLACE_UNAUTHORIZED',
          headers,
          responseData: data,
          cause: error,
        },
      );
    }

    return new WPRequestError(fallbackMessage, {
      status,
      code: isForbidden ? 'REST_REPLACE_FORBIDDEN' : 'REST_REPLACE_UNAUTHORIZED',
      headers,
      responseData: data,
      cause: error,
    });
  }

  if (error instanceof Error) return error;

  return new WPRequestError(String(error ?? 'Unknown error'), {
    status,
    headers,
    responseData: data,
  });
};

export const shouldBypassProxyAfterError = (error: unknown): boolean => {
  const queue: unknown[] = [error];
  const seen = new Set<unknown>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || seen.has(current)) continue;
    seen.add(current);

    const code = String((current as any)?.code || '').toUpperCase();
    if (code === 'ECONNREFUSED') {
      return true;
    }

    const message = String((current as any)?.message || current).toLowerCase();
    if (message.includes('connection refused') || message.includes('econnrefused')) {
      return true;
    }

    const cause = (current as any)?.cause;
    if (cause) {
      queue.push(cause);
    }
  }

  return false;
};

const sanitizePlainText = (input: string): string => {
  const withoutHtml = input
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
  return withoutHtml.replace(/\s+/g, ' ').trim();
};

class RateLimiter {
  private readonly gapMs: number;
  private last = 0;

  constructor(gapMs: number) {
    this.gapMs = Math.max(0, gapMs);
  }

  async waitTurn() {
    if (!this.gapMs) return;
    const now = Date.now();
    const wait = this.last + this.gapMs - now;
    if (wait > 0) {
      await sleep(wait);
    }
    this.last = Date.now();
  }
}

export class WPClient {
  private http: AxiosInstance;
  private readonly retries: number;
  private readonly limiter: RateLimiter;
  private readonly wcConsumerKey?: string;
  private readonly wcConsumerSecret?: string;
  private readonly baseUrl: string;
  private readonly authHeader: string;
  private readonly timeoutMs: number;
  private readonly proxyUrl?: string;
  private useProxy: boolean;

  constructor(options: WPClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.authHeader = options.jwt
      ? `Bearer ${options.jwt}`
      : `Basic ${Buffer.from(`${options.user ?? ''}:${options.appPassword ?? ''}`).toString('base64')}`;
    this.timeoutMs = options.timeoutMs ?? 30000;
    this.proxyUrl = getProxyUrl();
    this.useProxy = Boolean(this.proxyUrl);
    this.http = this.createHttpClient();

    this.retries = Math.max(0, options.retries ?? 3);
    this.limiter = new RateLimiter(options.rateLimitMs ?? 120);
    this.wcConsumerKey = options.wcConsumerKey;
    this.wcConsumerSecret = options.wcConsumerSecret;
  }

  private createHttpClient(): AxiosInstance {
    const proxyAgent = this.useProxy && this.proxyUrl ? new HttpsProxyAgent(this.proxyUrl) : undefined;

    return axios.create({
      baseURL: this.baseUrl,
      timeout: this.timeoutMs,
      headers: {
        Accept: 'application/json',
        Authorization: this.authHeader,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 LensCraft/1.0',
      },
      proxy: false,
      httpAgent: proxyAgent,
      httpsAgent: proxyAgent,
    });
  }

  private switchToDirectConnection() {
    if (!this.useProxy) return;
    this.useProxy = false;
    this.http = this.createHttpClient();
  }

  private async requestRaw<T>(config: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    let attempt = 0;
    while (true) {
      attempt += 1;
      await this.limiter.waitTurn();
      try {
        return await this.http.request<T>(config);
      } catch (error) {
        if (this.useProxy && this.proxyUrl && shouldBypassProxyAfterError(error)) {
          console.warn(`[WPClient] Proxy ${this.proxyUrl} refused connection. Retrying direct.`);
          this.switchToDirectConnection();
          attempt -= 1;
          continue;
        }
        const err = error as AxiosError;
        const status = err.response?.status;
        const retriable = !status || RETRYABLE_HTTP.has(status);
        if (!retriable || attempt > this.retries + 1) {
          throw error;
        }
        const backoff = Math.min(4000, 300 * 2 ** (attempt - 1));
        await sleep(backoff);
      }
    }
  }

  private async requestWithRetry<T>(config: AxiosRequestConfig): Promise<T> {
    const response = await this.requestRaw<T>(config);
    return response.data;
  }

  async fetchMediaPage(page: number, perPage: number): Promise<WPMediaItem[]> {
    const data = await this.requestWithRetry<WPMediaItem[]>({
      method: 'GET',
      url: '/wp-json/wp/v2/media',
      params: {
        per_page: perPage,
        page,
        media_type: 'image',
      },
    });

    return (data || []).filter(item => item.media_type === 'image');
  }

  async fetchPostTitle(postId: number): Promise<string> {
    const data = await this.requestWithRetry<{ title?: { rendered?: string } }>({
      method: 'GET',
      url: `/wp-json/wp/v2/posts/${postId}`,
      params: { context: 'view' },
    });
    return sanitizePlainText(data?.title?.rendered ?? '');
  }

  async updateMediaMetadata(id: number, metadata: MediaMetadataUpdate): Promise<void> {
    const payload = {
      alt_text: sanitizePlainText(metadata.alt_text),
      title: sanitizePlainText(metadata.title),
      caption: sanitizePlainText(metadata.caption),
      description: sanitizePlainText(metadata.description),
    };
    console.log(`[WP-UPDATE] media #${id} sending:`, JSON.stringify(payload, null, 2));
    const result = await this.requestWithRetry<any>({
      method: 'POST',
      url: `/wp-json/wp/v2/media/${id}`,
      headers: {
        'Content-Type': 'application/json',
      },
      data: payload,
    });
    console.log(`[WP-UPDATE] media #${id} response title="${result?.title?.raw ?? result?.title?.rendered}" alt="${result?.alt_text}"`);
  }

  async fetchProductsPage(page: number, perPage: number): Promise<WPProductItem[]> {
    const params: Record<string, any> = {
      per_page: perPage,
      page,
    };
    // WooCommerce REST API uses consumer_key/consumer_secret for auth
    if (this.wcConsumerKey && this.wcConsumerSecret) {
      params.consumer_key = this.wcConsumerKey;
      params.consumer_secret = this.wcConsumerSecret;
    }
    const data = await this.requestWithRetry<WPProductItem[]>({
      method: 'GET',
      url: '/wp-json/wc/v3/products',
      params,
    });
    return data || [];
  }

  async fetchProductSeoFromPage(permalink: string): Promise<ProductSeoPreview> {
    const html = await this.requestWithRetry<string>({
      method: 'GET',
      url: permalink,
      responseType: 'text',
      headers: {
        Accept: 'text/html,application/xhtml+xml',
      },
    });

    const source = String(html || '');
    const extractMeta = (names: string[]) => {
      for (const name of names) {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const byName = new RegExp(
          `<meta[^>]+name=["']${escaped}["'][^>]+content=["']([^"']*)["'][^>]*>`,
          'i',
        );
        const byProp = new RegExp(
          `<meta[^>]+property=["']${escaped}["'][^>]+content=["']([^"']*)["'][^>]*>`,
          'i',
        );
        const matchName = source.match(byName);
        if (matchName?.[1]) return sanitizePlainText(matchName[1]);
        const matchProp = source.match(byProp);
        if (matchProp?.[1]) return sanitizePlainText(matchProp[1]);
      }
      return '';
    };

    const titleMatch = source.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = extractMeta(['og:title', 'twitter:title']) || sanitizePlainText(titleMatch?.[1] || '');
    const description =
      extractMeta(['description', 'og:description', 'twitter:description']) || '';

    return { title, description };
  }

  async updateProductMetadata(id: number, metadata: ProductMetadataUpdate): Promise<void> {
    console.log(`[WC-UPDATE] product #${id} sending update...`);
    const params: Record<string, any> = {};
    if (this.wcConsumerKey && this.wcConsumerSecret) {
      params.consumer_key = this.wcConsumerKey;
      params.consumer_secret = this.wcConsumerSecret;
    }
    let payload: ProductMetadataUpdate = metadata;
    try {
      const current = await this.requestWithRetry<WPProductItem>({
        method: 'GET',
        url: `/wp-json/wc/v3/products/${id}`,
        params,
      });
      const existing = Array.isArray(current?.meta_data) ? current.meta_data : [];
      const byKey = new Map<string, number[]>();
      for (const row of existing) {
        if (!row?.key || typeof row.id !== 'number') continue;
        const arr = byKey.get(row.key) || [];
        arr.push(row.id);
        byKey.set(row.key, arr);
      }
      const merged: Array<{ id?: number; key: string; value: string }> = [];
      for (const row of metadata.meta_data || []) {
        if (!row?.key) continue;
        const ids = byKey.get(row.key) || [];
        if (ids.length) {
          for (const metaId of ids) {
            merged.push({ id: metaId, key: row.key, value: row.value });
          }
        } else {
          merged.push({ key: row.key, value: row.value });
        }
      }
      payload = { ...metadata, meta_data: merged };
    } catch {
      // If prefetch fails, keep original payload to avoid blocking sync.
    }
    const result = await this.requestWithRetry<any>({
      method: 'PUT',
      url: `/wp-json/wc/v3/products/${id}`,
      headers: {
        'Content-Type': 'application/json',
      },
      params,
      data: payload,
    });
    console.log(`[WC-UPDATE] product #${id} response name="${result?.name}" status="${result?.status}"`);
  }

  async replaceMediaFile(id: number, filePath: string): Promise<void> {
    const fileBuffer = fs.readFileSync(filePath);
    const formData = new FormData();
    // In Node environment with axios/form-data, this is slightly different than browser,
    // but axios handles Buffer data if passed correctly or we use 'form-data' package.
    // However, since we are in Node 18+ environment (likely), we have global FormData/Blob.
    // Let's stick to simple Buffer upload or specific multipart handling.
    // Since axios in Node requires 'form-data' package for multipart/form-data with streams/buffers usually,
    // but we can try sending as raw binary if the endpoint supported it, but our PHP expects $_FILES.
    // So we need to construct a multipart request properly.

    // Instead of importing 'form-data', let's use the native fetch or dynamic import if axios struggles,
    // but actually, we can just use the axios request with a Blob/File object if available or just `form-data` package if installed.
    // Based on package.json, we don't see 'form-data' explicitly but 'axios' usually depends on 'follow-redirects' etc.
    // Wait, recent Node.js has native FormData.

    const blob = new Blob([fileBuffer]);
    formData.append('file', blob, path.basename(filePath));

    try {
      await this.requestWithRetry({
        method: 'POST',
        url: `/wp-json/lenscraft/v1/media/${id}/replace`,
        data: formData,
      });
    } catch (error) {
      throw normalizeReplaceMediaError(error);
    }
  }

  async probeReplaceMediaRoute(id: number): Promise<void> {
    const formData = new FormData();
    const response = await this.requestRaw({
      method: 'POST',
      url: `/wp-json/lenscraft/v1/media/${id}/replace`,
      data: formData,
      validateStatus: () => true,
    });

    if (response.status >= 200 && response.status < 300) {
      return;
    }
    if (response.status === 400) {
      return;
    }

    throw normalizeReplaceMediaError({
      status: response.status,
      headers: response.headers as HttpHeadersLike,
      responseData: response.data,
    });
  }

  async downloadToFile(url: string, localPath: string, mediaId?: number): Promise<number> {
    const fullPath = path.resolve(localPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });

    // Strategy 1: Download via REST API proxy (bypasses Cloudflare JS challenge)
    if (mediaId) {
      try {
        const data = await this.requestWithRetry<ArrayBuffer>({
          method: 'GET',
          url: `/wp-json/lenscraft/v1/media/${mediaId}/download`,
          responseType: 'arraybuffer',
          timeout: 60000,
        });
        const buf = Buffer.from(data);
        if (buf.byteLength > 0) {
          fs.writeFileSync(fullPath, buf);
          return buf.byteLength;
        }
      } catch (proxyErr) {
        const status = (proxyErr as any)?.response?.status;
        // Only fall back if endpoint not found (plugin not installed); otherwise throw
        if (status !== 404) {
          throw proxyErr;
        }
        // 404 means plugin not installed, try direct download below
      }
    }

    // Strategy 2: Direct URL download (may fail if Cloudflare blocks it)
    const data = await this.requestWithRetry<ArrayBuffer>({
      method: 'GET',
      url,
      responseType: 'arraybuffer',
      timeout: 30000,
    });
    const buf = Buffer.from(data);
    fs.writeFileSync(fullPath, buf);
    return buf.byteLength;
  }
}

export const deriveRelativePath = (item: WPMediaItem): string => {
  const direct = item.media_details?.file;
  if (direct && direct.trim()) {
    return direct.replace(/^\/+/, '');
  }

  try {
    const url = new URL(item.source_url);
    const marker = '/uploads/';
    const index = url.pathname.lastIndexOf(marker);
    if (index >= 0) {
      return url.pathname.slice(index + marker.length).replace(/^\/+/, '');
    }
  } catch {
    // Ignore parse failure and fall through.
  }

  throw new Error(`Unable to derive uploads relative path for media #${item.id}`);
};

export const parseWpRenderedText = (value?: string): string => sanitizePlainText(value ?? '');
