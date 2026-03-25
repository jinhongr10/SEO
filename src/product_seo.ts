import { GoogleGenAI } from '@google/genai';
import { LLMProvider } from './seo.js';

export interface ProductSeoInput {
    productId: number;
    productName: string;
    currentShortDescription: string;
    currentDescription: string;
    template: string; // The template the user uploaded
    language?: string;
}

export interface ProductSeoOutput {
    short_description: string;
    description: string;
    acf_seo_extra_info: string;
    aioseo_title: string;
    aioseo_description: string;
}

const cleanText = (value: string) => value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

const truncate = (value: string, max: number) => {
    if (value.length <= max) return value;
    return value.slice(0, max).trim();
};

const ensureHtml = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return '';
    return /<[^>]+>/.test(trimmed) ? trimmed : `<p>${trimmed}</p>`;
};

const parseJsonSafe = (raw: string) => {
    try {
        return JSON.parse(raw);
    } catch {
        const cleaned = raw.replace(/```json\n?|\n?```/g, '').trim();
        return JSON.parse(cleaned);
    }
};

const normalizeOutput = (input: ProductSeoInput, raw: any): ProductSeoOutput => {
    const shortDescription = String(raw?.short_description || '').trim() || input.currentShortDescription.trim();
    const description = String(raw?.description || '').trim() || input.currentDescription.trim();
    const sourceText = cleanText(`${shortDescription} ${description}`.trim());

    const fallbackAcf = sourceText || `${input.productName} is suitable for commercial use.`;
    const fallbackTitle = input.productName.trim() || truncate(sourceText, 60) || 'Commercial Product';
    const fallbackMeta = sourceText || `${input.productName} is designed for reliable daily use and easy maintenance.`;

    return {
        short_description: shortDescription,
        description,
        acf_seo_extra_info: ensureHtml(String(raw?.acf_seo_extra_info || '').trim() || fallbackAcf),
        aioseo_title: truncate(String(raw?.aioseo_title || '').trim() || fallbackTitle, 60),
        aioseo_description: truncate(String(raw?.aioseo_description || '').trim() || fallbackMeta, 160),
    };
};

export class GeminiProductSeoGenerator {
    private genAI: GoogleGenAI;

    constructor(apiKey: string) {
        this.genAI = new GoogleGenAI({ apiKey });
    }

    async generate(input: ProductSeoInput): Promise<ProductSeoOutput> {
        const langInstructions = input.language ? `Please generate the content in ${input.language}.` : '';
        const contextShort = input.currentShortDescription?.trim() || '(empty)';
        const contextFull = input.currentDescription?.trim() || '(empty)';

        const prompt = `
      You are an expert SEO copywriter for e-commerce products.
      Generate WooCommerce product descriptions and SEO metadata based on the product details and template.
      ${langInstructions}

      Product Name: ${input.productName}
      Existing WooCommerce Short Description (must be used as context):
      """
      ${contextShort}
      """
      Existing WooCommerce Full Description (must be used as context):
      """
      ${contextFull}
      """

      User Template / Instructions:
      ${input.template}

      Requirements:
      1. Use BOTH existing short description and existing full description as the factual source.
      2. short_description: rewrite/improve the short description (1-2 paragraphs).
      3. description: rewrite/improve full description in HTML.
      4. acf_seo_extra_info: must be derived from short_description + description and NOT be empty (HTML allowed).
      5. aioseo_title: must be derived from short_description + description and NOT be empty (max 60 chars).
      6. aioseo_description: must be derived from short_description + description and NOT be empty (max 160 chars).
      7. Keep content consistent with product facts. Do not invent unsupported specs.
      
      Output ONLY valid JSON matching this schema:
      {
        "short_description": "...",
        "description": "...",
        "acf_seo_extra_info": "...",
        "aioseo_title": "...",
        "aioseo_description": "..."
      }
    `;

        const response = await this.genAI.models.generateContent({
            model: "gemini-2.0-flash",
            contents: prompt,
            config: { responseMimeType: "application/json" }
        });

        const text = response.text;
        if (!text) throw new Error('Empty response from Gemini');

        const json = parseJsonSafe(text);
        return normalizeOutput(input, json);
    }
}

export const createProductSeoGenerator = (provider: LLMProvider, apiKey?: string) => {
    if (provider === 'gemini' && apiKey) {
        return new GeminiProductSeoGenerator(apiKey);
    }
    throw new Error(`Product SEO generation requires Gemini API key. Requested provider: ${provider}`);
};
