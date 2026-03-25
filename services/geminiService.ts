import { GoogleGenAI } from "@google/genai";
import { SEOData, BlogSEO } from "../types";

const blobToBase64 = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });

async function retryOperation<T>(operation: () => Promise<T>, retries = 3, delay = 1000): Promise<T> {
  try {
    return await operation();
  } catch (error: any) {
    const status = error?.status || error?.response?.status;
    const shouldRetry = status === 429 || status === 503 || error?.message?.includes('429') || error?.message?.includes('quota');
    if (retries > 0 && shouldRetry) {
      console.warn(`Gemini API Error (${status}). Retrying in ${delay}ms... (${retries} retries left)`);
      await new Promise(r => setTimeout(r, delay));
      return retryOperation(operation, retries - 1, delay * 2);
    }
    throw error;
  }
}

type GeminiModel = 'gemini-3-flash-preview' | 'gemini-3-pro-preview';

async function callGemini<T>(
  apiKey: string,
  model: GeminiModel,
  prompt: string,
  options?: { imageBlob?: Blob; jsonResponse?: boolean }
): Promise<T> {
  if (!apiKey) throw new Error("API Key is missing");
  const ai = new GoogleGenAI({ apiKey });

  const text = await retryOperation(async () => {
    const contents = options?.imageBlob
      ? { parts: [{ inlineData: { mimeType: options.imageBlob.type || 'image/webp', data: await blobToBase64(options.imageBlob) } }, { text: prompt }] }
      : prompt;
    const response = await ai.models.generateContent({
      model,
      contents,
      ...(options?.jsonResponse && { config: { responseMimeType: "application/json" } })
    });
    return response.text;
  });

  if (!text) throw new Error("Empty response from AI");
  return options?.jsonResponse ? JSON.parse(text) : text as T;
}

export const generateSEO = async (
  apiKey: string, imageBlob: Blob, mainKeyword: string, extraDesc?: string, keywordContext?: string
): Promise<SEOData> => {
  const prompt = `You are an expert SEO specialist. Analyze the provided image.
Main Keyword to target: "${mainKeyword}".
${extraDesc ? `Additional Context: ${extraDesc}` : ''}
${keywordContext ? `KEYWORD DATABASE:\n"""\n${keywordContext.substring(0, 50000)}\n"""\nUse vocabulary from this database to optimize metadata.` : ''}

Generate optimized SEO metadata in JSON. Follow these STRICT character limits:
1. title: SEO-friendly title, max 60 characters.
2. alt: Detailed accessibility text, max 125 characters.
3. caption: Brief display caption, max 120 characters.
4. description: Meta description for search results, max 160 characters.

Output JSON:
{"filename": "string (hyphen-separated, lowercase, .webp)", "title": "string", "alt": "string", "caption": "string", "description": "string"}`;

  return callGemini<SEOData>(apiKey, 'gemini-3-flash-preview', prompt, { imageBlob, jsonResponse: true });
};

export const generateSEOFromTextContext = async (
  apiKey: string,
  context: {
    filename: string;
    mainKeyword: string;
    currentTitle?: string;
    currentAlt?: string;
    currentCaption?: string;
    currentDescription?: string;
    extraDesc?: string;
    keywordContext?: string;
  }
): Promise<SEOData> => {
  const prompt = `You are an expert SEO specialist.
The original image bytes are temporarily unavailable because the site blocks automated image downloads.
Infer likely image intent from the filename, current metadata, and keyword context, then generate improved SEO metadata.

Main Keyword to target: "${context.mainKeyword}".
Filename: "${context.filename}".
Current Title: "${context.currentTitle || ''}".
Current Alt: "${context.currentAlt || ''}".
Current Caption: "${context.currentCaption || ''}".
Current Description: "${context.currentDescription || ''}".
${context.extraDesc ? `Additional Context: ${context.extraDesc}` : ''}
${context.keywordContext ? `KEYWORD DATABASE:\n"""\n${context.keywordContext.substring(0, 50000)}\n"""\nUse vocabulary from this database to optimize metadata.` : ''}

Generate optimized SEO metadata in JSON. Follow these STRICT character limits:
1. title: SEO-friendly title, max 60 characters.
2. alt: Detailed accessibility text, max 125 characters.
3. caption: Brief display caption, max 120 characters.
4. description: Meta description for search results, max 160 characters.

Output JSON:
{"filename": "string (hyphen-separated, lowercase, .webp)", "title": "string", "alt": "string", "caption": "string", "description": "string"}`;

  return callGemini<SEOData>(apiKey, 'gemini-3-flash-preview', prompt, { jsonResponse: true });
};

export const generateBlogOutline = async (
  apiKey: string, topic: string, keywords: string, referenceContent?: string, keywordContext?: string
): Promise<string> => {
  const prompt = `You are a professional blog editor. Create a structured blog post OUTLINE.
Topic: "${topic}"
Target Keywords: "${keywords}"
${keywordContext ? `KEYWORD DATABASE:\n"""\n${keywordContext.substring(0, 50000)}\n"""` : ''}
${referenceContent ? `Reference Material:\n"""\n${referenceContent}\n"""` : ''}

Requirements:
1. Use Markdown headers (H1 Title, H2 Sections, H3 sub-points)
2. Include SEO-friendly Title
3. Structure: Introduction, Body (3-5 points), Conclusion
4. Integrate keywords naturally
5. Only outline, not full content`;

  return callGemini<string>(apiKey, 'gemini-3-flash-preview', prompt);
};

export const generateFullPost = async (
  apiKey: string, topic: string, approvedOutline: string, referenceContent?: string, keywordContext?: string
): Promise<string> => {
  const prompt = `You are a professional blog writer. Write a complete blog post based on the outline.
Topic: "${topic}"
${keywordContext ? `KEYWORD DATABASE:\n"""\n${keywordContext.substring(0, 50000)}\n"""` : ''}
${referenceContent ? `Reference Material:\n"""\n${referenceContent}\n"""` : ''}

Outline:
${approvedOutline}

Requirements:
1. Full sentences and paragraphs with Markdown formatting
2. Engaging, informative, professional tone
3. SEO optimized, ready-to-publish`;

  return callGemini<string>(apiKey, 'gemini-3-pro-preview', prompt);
};

export const refineBlogPost = async (apiKey: string, currentContent: string, instruction: string): Promise<string> => {
  const prompt = `You are a blog editor.
Current Draft:
"""
${currentContent}
"""

Revision Instructions: "${instruction}"

Rewrite to address feedback, maintain Markdown, output full updated article.`;

  return callGemini<string>(apiKey, 'gemini-3-pro-preview', prompt);
};

export const generateBlogSEO = async (apiKey: string, content: string, keywordContext?: string): Promise<BlogSEO> => {
  const prompt = `You are an SEO specialist. Generate metadata for this blog:
${keywordContext ? `Keyword Database:\n"""\n${keywordContext.substring(0, 10000)}\n"""` : ''}

Blog Content:
"""
${content.substring(0, 10000)}
"""

Output JSON: {"seoTitle": "max 60 chars", "seoDescription": "max 160 chars"}`;

  return callGemini<BlogSEO>(apiKey, 'gemini-3-flash-preview', prompt, { jsonResponse: true });
};
