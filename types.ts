
export enum ProcessingStatus {
  IDLE = 'IDLE',
  PROCESSING = 'PROCESSING', // Resizing/Converting
  GENERATING_SEO = 'GENERATING_SEO', // AI
  UPLOADING = 'UPLOADING', // WordPress
  COMPLETED = 'COMPLETED',
  ERROR = 'ERROR',
}

export enum BlogStatus {
  IDLE = 'IDLE',
  GENERATING_OUTLINE = 'GENERATING_OUTLINE',
  OUTLINE_READY = 'OUTLINE_READY', // Waiting for user approval/edits
  GENERATING_POST = 'GENERATING_POST',
  REFINING = 'REFINING', // New status for refinement
  GENERATING_SEO = 'GENERATING_SEO', // New status for Blog SEO
  COMPLETED = 'COMPLETED',
  ERROR = 'ERROR',
}

export interface SEOData {
  filename: string;
  title: string;
  alt: string;
  caption: string;
  description: string;
}

export interface WPData {
  id: number;
  source_url: string;
  link: string;
}

export interface WorkImage {
  id: string; // Unique UI ID
  file: File;
  previewUrl: string;

  // Configuration
  targetWidth: number;
  quality: number; // WebP quality (0-1)
  mainKeyword: string;
  extraDesc: string;

  // Result State
  processedBlob?: Blob;
  processedUrl?: string;
  originalSize?: number;
  processedSize?: number;
  originalDimensions?: { width: number; height: number };
  processedDimensions?: { width: number; height: number };
  lastProcessedQuality?: number;
  lastProcessedTargetWidth?: number;

  // AI & Remote
  seoData?: SEOData;
  seoSource?: 'gemini' | 'fallback';
  wpData?: WPData;

  status: ProcessingStatus;
  errorMessage?: string;
}

export interface BlogSEO {
  seoTitle: string;
  seoDescription: string;
}

export interface BlogState {
  topic: string;
  keywords: string;
  keywordContext?: string; // Content from Excel/CSV
  keywordFileName?: string; // Display name of uploaded file
  referenceContent: string;
  outline: string;
  content: string;
  refineInstruction: string; // New field for feedback
  seo?: BlogSEO; // New field for Blog SEO
  status: BlogStatus;
  errorMessage?: string;
}

export interface Settings {
  googleApiKey: string;
  wpUrl: string;
  wpUser: string;
  wpAppPass: string;
  sftpHost: string;
  sftpPort: number;
  sftpUser: string;
  sftpPass: string;
  remoteWpRoot: string;
  useProxy: boolean;
  backendUrl: string;
}

export interface TargetWidthOption {
  value: number;
  label: string;
  hint: string;
}

export const TARGET_WIDTH_OPTIONS: TargetWidthOption[] = [
  { value: 0, label: '原尺寸', hint: '保持原图宽度' },
  { value: 1200, label: '1200px', hint: 'Banner / 大图' },
  { value: 800, label: '800px', hint: '详情页主图' },
  { value: 600, label: '600px', hint: '内容配图' },
  { value: 450, label: '450px', hint: '缩略图 / 列表' },
];
