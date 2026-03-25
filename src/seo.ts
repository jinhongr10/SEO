import { GoogleGenAI } from '@google/genai';
import fs from 'node:fs';
import path from 'node:path';

export type LLMProvider = 'none' | 'openai' | 'gemini' | 'custom';

export interface SEOInput {
  filename: string;
  currentTitle: string;
  currentAlt: string;
  currentCaption: string;
  currentDescription: string;
  defaultKeywords: string[];
  postTitle?: string;
  altMaxChars: number;
  imagePath?: string;
  /** Language code for multilingual SEO generation (e.g. 'en', 'zh', 'es') */
  language?: string;
  /** Sibling images from the same product/post for batch-aware context */
  siblingFilenames?: string[];
  /** 1-based index of this image among siblings (for series-aware alt text) */
  siblingIndex?: number;
}

export interface SEOOutput {
  alt_text: string;
  title: string;
  caption: string;
  description: string;
  /** Quality score 0-100 assigned by the scoring system */
  qualityScore?: number;
}

export interface SEOGenerator {
  generate(input: SEOInput): Promise<SEOOutput>;
}

const normalizeText = (value: string) => value.replace(/\s+/g, ' ').trim();

const slugToWords = (name: string) =>
  name
    .replace(/\.[^.]+$/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const dedupeKeywords = (parts: string[]) => {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const part of parts.map(normalizeText)) {
    if (!part) continue;
    const lowered = part.toLowerCase();
    if (seen.has(lowered)) continue;
    seen.add(lowered);
    output.push(part);
  }
  return output;
};

const truncate = (value: string, max: number) => {
  const normalized = normalizeText(value);
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
};

// ---------------------------------------------------------------------------
// SEO Quality Scoring
// ---------------------------------------------------------------------------

export interface ScoreBreakdown {
  total: number;
  lengthScore: number;
  keywordScore: number;
  uniquenessScore: number;
  readabilityScore: number;
}

/**
 * Score SEO metadata quality on a 0-100 scale.
 * Checks keyword presence, field length, uniqueness across fields, and readability.
 */
export const scoreSeoOutput = (output: SEOOutput, keywords: string[]): ScoreBreakdown => {
  const fields = [output.title, output.alt_text, output.caption, output.description];
  const joined = fields.join(' ').toLowerCase();

  // 1) Length score (25 pts) – reward fields in ideal range
  const idealRanges: Array<[string, number, number]> = [
    [output.title, 20, 60],
    [output.alt_text, 30, 125],
    [output.caption, 20, 120],
    [output.description, 50, 160],
  ];
  let lengthScore = 0;
  for (const [text, min, max] of idealRanges) {
    const len = (text as string).length;
    if (len >= min && len <= max) lengthScore += 6.25;
    else if (len > 0) lengthScore += 3;
  }

  // 2) Keyword score (30 pts) – how many target keywords appear
  let keywordHits = 0;
  for (const kw of keywords.slice(0, 5)) {
    if (joined.includes(kw.toLowerCase())) keywordHits += 1;
  }
  const keywordScore = keywords.length ? Math.min(30, (keywordHits / Math.min(keywords.length, 5)) * 30) : 15;

  // 3) Uniqueness score (25 pts) – fields should not be identical to each other
  const unique = new Set(fields.map(f => f.trim().toLowerCase()));
  const uniquenessScore = Math.min(25, (unique.size / 4) * 25);

  // 4) Readability score (20 pts) – no excessive caps, no raw slugs
  let readabilityScore = 20;
  for (const f of fields) {
    if (/[A-Z]{10,}/.test(f)) readabilityScore -= 5;
    if (/[-_]{2,}/.test(f)) readabilityScore -= 5;
  }
  readabilityScore = Math.max(0, readabilityScore);

  return {
    total: Math.round(lengthScore + keywordScore + uniquenessScore + readabilityScore),
    lengthScore: Math.round(lengthScore),
    keywordScore: Math.round(keywordScore),
    uniquenessScore: Math.round(uniquenessScore),
    readabilityScore: Math.round(readabilityScore),
  };
};

// ---------------------------------------------------------------------------
// Language helpers
// ---------------------------------------------------------------------------

const LANGUAGE_PROMPTS: Record<string, string> = {
  en: 'Generate all text in English.',
  zh: 'Generate all text in Simplified Chinese (简体中文).',
  'zh-tw': 'Generate all text in Traditional Chinese (繁體中文).',
  es: 'Generate all text in Spanish (Español).',
  fr: 'Generate all text in French (Français).',
  de: 'Generate all text in German (Deutsch).',
  ja: 'Generate all text in Japanese (日本語).',
  ko: 'Generate all text in Korean (한국어).',
  pt: 'Generate all text in Portuguese (Português).',
  ar: 'Generate all text in Arabic (العربية).',
};

const getLanguageInstruction = (lang?: string): string => {
  if (!lang) return '';
  return LANGUAGE_PROMPTS[lang.toLowerCase()] ?? `Generate all text in the language with code: ${lang}.`;
};

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

class DeterministicSeoGenerator implements SEOGenerator {
  async generate(input: SEOInput): Promise<SEOOutput> {
    const filenamePhrase = slugToWords(input.filename);
    const seeds = dedupeKeywords([
      input.postTitle ?? '',
      input.currentTitle,
      input.currentAlt,
      input.defaultKeywords[0] ?? '',
      input.defaultKeywords[1] ?? '',
      filenamePhrase,
      'commercial restroom product',
    ]);

    const primary = seeds[0] || 'Commercial restroom product';
    const secondary = seeds[1] || input.defaultKeywords[0] || 'hygiene equipment';

    // Add series context if this image is part of a sibling group
    const seriesSuffix = input.siblingIndex && input.siblingFilenames && input.siblingFilenames.length > 1
      ? ` (${input.siblingIndex} of ${input.siblingFilenames.length})`
      : '';

    const title = truncate(`${primary} - ${secondary}${seriesSuffix}`, 70);
    const caption = truncate(`${primary} for professional hygiene spaces.`, 120);
    const description = truncate(
      `${primary} is optimized for durability and daily commercial restroom use. Suitable for facility upgrades that require reliable hygiene performance.`,
      260,
    );
    const altText = truncate(`${primary}, ${secondary}${seriesSuffix}`, input.altMaxChars);

    const result: SEOOutput = { alt_text: altText, title, caption, description };
    const score = scoreSeoOutput(result, input.defaultKeywords);
    result.qualityScore = score.total;
    return result;
  }
}

class GeminiSeoGenerator implements SEOGenerator {
  private genAI: GoogleGenAI;
  private scoreThreshold: number;
  private maxRetries: number;

  constructor(apiKey: string, scoreThreshold = 60, maxRetries = 2) {
    this.genAI = new GoogleGenAI({ apiKey });
    this.scoreThreshold = scoreThreshold;
    this.maxRetries = maxRetries;
  }

  async generate(input: SEOInput): Promise<SEOOutput> {
    if (!input.imagePath || !fs.existsSync(input.imagePath)) {
      throw new Error(`Image file not found at ${input.imagePath}`);
    }

    const ext = path.extname(input.imagePath).toLowerCase().replace('.', '');
    const mimeType = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
    const imageData = fs.readFileSync(input.imagePath).toString("base64");

    const languageInstruction = getLanguageInstruction(input.language);

    const siblingContext = input.siblingFilenames && input.siblingFilenames.length > 1
      ? `\n      - This image is ${input.siblingIndex ?? '?'} of ${input.siblingFilenames.length} images for the same product/post.
      - Sibling filenames: ${input.siblingFilenames.join(', ')}
      - Generate alt text that is unique within the series (e.g. mention angle, detail, or variation).`
      : '';

    const prompt = `
      Analyze this image and generate SEO metadata in JSON format.
      ${languageInstruction}

      Context:
      - Filename: ${input.filename}
      - Post Title: ${input.postTitle || 'N/A'}
      - Current Title: ${input.currentTitle}
      - Current Alt: ${input.currentAlt}
      - Keywords: ${input.defaultKeywords.join(', ')}${siblingContext}

      Requirements:
      1. title: Concise, descriptive title (max 60 chars)
      2. alt_text: Detailed description for accessibility (max ${input.altMaxChars} chars)
      3. caption: Short caption for display (max 120 chars)
      4. description: Full coherent description (max 160 chars)
      5. Strict JSON output: { "title": "...", "alt_text": "...", "caption": "...", "description": "..." }
    `;

    let bestResult: SEOOutput | null = null;
    let bestScore = 0;

    let retries = 3;
    let qualityAttempts = 0;

    while (retries > 0) {
      try {
        const response = await this.genAI.models.generateContent({
          model: "gemini-2.0-flash",
          contents: {
            parts: [
              { inlineData: { data: imageData, mimeType } },
              { text: prompt }
            ]
          },
          config: { responseMimeType: "application/json" }
        });

        const text = response.text;
        if (!text) throw new Error('Empty response from Gemini');

        let json: any;
        try {
          json = JSON.parse(text);
        } catch (e) {
          const cleanText = text.replace(/```json\n?|\n?```/g, '').trim();
          json = JSON.parse(cleanText);
        }

        const candidate: SEOOutput = {
          title: truncate(json.title || '', 60),
          alt_text: truncate(json.alt_text || json.alt || '', input.altMaxChars),
          caption: truncate(json.caption || '', 120),
          description: truncate(json.description || '', 160),
        };

        const score = scoreSeoOutput(candidate, input.defaultKeywords);
        candidate.qualityScore = score.total;

        if (score.total > bestScore) {
          bestScore = score.total;
          bestResult = candidate;
        }

        // If quality is good enough, return immediately
        if (score.total >= this.scoreThreshold) {
          return candidate;
        }

        // Otherwise retry if we have quality retries left
        qualityAttempts += 1;
        if (qualityAttempts >= this.maxRetries) {
          return bestResult!;
        }
        retries--;
        continue;
      } catch (error: any) {
        const status = error.status || error.code;
        const isQuota = status === 429 || status === 503 || String(error).includes('429');
        if (isQuota && retries > 1) {
          await new Promise(r => setTimeout(r, 2000 * (4 - retries)));
          retries--;
          continue;
        }
        console.error('Gemini verification failed, falling back to deterministic:', error);
        return new DeterministicSeoGenerator().generate(input);
      }
    }

    return bestResult ?? new DeterministicSeoGenerator().generate(input);
  }
}

export const createSeoGenerator = (provider: LLMProvider, apiKey?: string): SEOGenerator => {
  if (provider === 'gemini' && apiKey) {
    return new GeminiSeoGenerator(apiKey);
  }
  if (provider === 'none') {
    return new DeterministicSeoGenerator();
  }

  // Pluggable point for OpenAI/custom providers. For now we return deterministic
  // output to keep the tool runnable without external API dependencies.
  return new DeterministicSeoGenerator();
};
