import React, { useState, useEffect, useCallback } from 'react';
import * as XLSX from 'xlsx';
import { marked } from 'marked';
import { ProcessingStatus, TARGET_WIDTH_OPTIONS, WorkImage, Settings, BlogStatus, BlogState, SEOData } from './types';
import { loadImage, processImageToWebP, formatBytes } from './services/imageUtils';
import { generateSEO, generateSEOFromTextContext, generateBlogOutline, generateFullPost, refineBlogPost, generateBlogSEO } from './services/geminiService';
import { parseExcelFile } from './services/excelUtils';
import { uploadToWordPress } from './services/wpService';
import { ComparisonSlider } from './components/ComparisonSlider';
import {
  IconUpload, IconDownload, IconCopy, IconPlus, IconX, IconCloudUpload,
  IconSun, IconMoon, IconCheck, IconPhoto, IconDocumentText, IconImport, IconSparkles, IconWord, IconTable, IconPlay, IconStop, IconRefresh, IconSettings
} from './components/Icons';
import { ProductSeoDashboard } from './components/ProductSeoDashboard';

const DEFAULT_SETTINGS: Settings = {
  googleApiKey: '',
  wpUrl: '',
  wpUser: '',
  wpAppPass: '',
  sftpHost: '',
  sftpPort: 22,
  sftpUser: '',
  sftpPass: '',
  remoteWpRoot: '',
  useProxy: true,
  backendUrl: '/api',
};

const normalizeBackendUrl = (value?: string) => (value || '/api').trim() || '/api';

const CopyButton: React.FC<{ text: string; className?: string; label?: string }> = ({ text, className = "", label = "复制" }) => {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); };
  return (
    <button onClick={handleCopy} className={`text-xs flex items-center gap-1 transition-colors ${className} ${copied ? 'text-green-500' : 'text-slate-400 hover:text-blue-500'}`}>
      {copied ? <><IconCheck className="w-3 h-3" />已复制</> : <><IconCopy className="w-3 h-3" />{label}</>}
    </button>
  );
};


interface MediaOpsReport {
  totals: { totalMedia: number; totalProcessed: number; totalOptimized: number; bytesSaved: number; failures: number };
  status: { isRunning: boolean; operation: string | null; lastError: string | null };
  failures: { id: number; filename: string; error_reason: string; updated_at: string }[];
  byStatus: { status: string; total: number }[];
}

interface MediaItem {
  id: number;
  filename: string;
  mime_type: string;
  status: string;
  bytes_original: number;
  bytes_optimized: number;
  updated_at: string;
  error_reason?: string;
  source_url?: string;
  gen_seo_id?: number;
  gen_title?: string;
  gen_alt_text?: string;
  gen_caption?: string;
  gen_description?: string;
  gen_category?: string;
  gen_review_status?: string;
  gen_generator?: string;
}

interface RestReplaceStatus {
  available: boolean;
  code: string;
  detail: string;
  httpStatus?: number;
  sftpConfigured: boolean;
  canFallbackToSftp: boolean;
}

interface ReviewItem {
  id: number;
  media_id: number;
  title: string;
  alt_text: string;
  caption: string;
  description: string;
  category_detected: string | null;
  generator: string;
  review_status: string;
  filename: string;
  source_url: string;
  orig_title: string;
  orig_alt_text: string;
  orig_caption: string;
  orig_description: string;
}

const SettingsModal: React.FC<{
  isOpen: boolean;
  onClose: () => void;
  settings: Settings;
  onSave: (s: Settings) => void;
  theme: any;
}> = ({ isOpen, onClose, settings, onSave, theme }) => {
  const [local, setLocal] = useState(settings);
  useEffect(() => { if (isOpen) setLocal(settings); }, [isOpen, settings]);
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[200] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className={`${theme.cardBg} rounded-2xl shadow-2xl max-w-2xl w-full max-h-[90vh] overflow-hidden flex flex-col border ${theme.cardBorder}`}>
        <div className={`flex justify-between items-center p-6 border-b ${theme.cardBorder}`}>
          <h3 className={`font-bold text-xl flex items-center gap-2 ${theme.heading}`}><IconSettings /> 系统配置</h3>
          <button onClick={onClose} className={`p-2 rounded-full hover:bg-black/5 dark:hover:bg-white/5 ${theme.subText}`}><IconX /></button>
        </div>
        <div className="flex-1 overflow-auto p-6 space-y-8">
          {/* Section: Gemini */}
          <section className="space-y-4">
            <h4 className={`text-sm font-bold uppercase tracking-widest ${theme.subText} border-l-4 border-blue-500 pl-2`}>AI 配置 (Gemini)</h4>
            <div>
              <label className={`block text-xs font-medium mb-1 ${theme.subText}`}>Google API Key</label>
              <input type="password" value={local.googleApiKey} onChange={e => setLocal({ ...local, googleApiKey: e.target.value })} className={`w-full ${theme.inputBg} border ${theme.inputBorder} rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-blue-500 ${theme.heading}`} placeholder="AIzaSy..." />
            </div>
          </section>

          {/* Section: WordPress */}
          <section className="space-y-4">
            <h4 className={`text-sm font-bold uppercase tracking-widest ${theme.subText} border-l-4 border-blue-500 pl-2`}>WordPress 站点配置</h4>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="md:col-span-2">
                <label className={`block text-xs font-medium mb-1 ${theme.subText}`}>WordPress 网址 (需包含 https://)</label>
                <input value={local.wpUrl} onChange={e => setLocal({ ...local, wpUrl: e.target.value })} className={`w-full ${theme.inputBg} border ${theme.inputBorder} rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-blue-500 ${theme.heading}`} placeholder="https://your-site.com" />
              </div>
              <div>
                <label className={`block text-xs font-medium mb-1 ${theme.subText}`}>WP 用户名</label>
                <input value={local.wpUser} onChange={e => setLocal({ ...local, wpUser: e.target.value })} className={`w-full ${theme.inputBg} border ${theme.inputBorder} rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-blue-500 ${theme.heading}`} />
              </div>
              <div>
                <label className={`block text-xs font-medium mb-1 ${theme.subText}`}>应用密码 (Application Password)</label>
                <input type="password" value={local.wpAppPass} onChange={e => setLocal({ ...local, wpAppPass: e.target.value })} className={`w-full ${theme.inputBg} border ${theme.inputBorder} rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-blue-500 ${theme.heading}`} placeholder="xxxx xxxx xxxx xxxx" />
              </div>
            </div>
          </section>

          {/* Section: SFTP */}
          <section className="space-y-4">
            <h4 className={`text-sm font-bold uppercase tracking-widest ${theme.subText} border-l-4 border-blue-500 pl-2`}>SFTP 服务器配置 (用于媒体库直接同步)</h4>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="md:col-span-2">
                <label className={`block text-xs font-medium mb-1 ${theme.subText}`}>SFTP 主机地址</label>
                <input value={local.sftpHost} onChange={e => setLocal({ ...local, sftpHost: e.target.value })} className={`w-full ${theme.inputBg} border ${theme.inputBorder} rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-blue-500 ${theme.heading}`} />
              </div>
              <div>
                <label className={`block text-xs font-medium mb-1 ${theme.subText}`}>端口</label>
                <input type="number" value={local.sftpPort} onChange={e => setLocal({ ...local, sftpPort: parseInt(e.target.value) || 22 })} className={`w-full ${theme.inputBg} border ${theme.inputBorder} rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-blue-500 ${theme.heading}`} />
              </div>
              <div>
                <label className={`block text-xs font-medium mb-1 ${theme.subText}`}>SFTP 用户名</label>
                <input value={local.sftpUser} onChange={e => setLocal({ ...local, sftpUser: e.target.value })} className={`w-full ${theme.inputBg} border ${theme.inputBorder} rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-blue-500 ${theme.heading}`} />
              </div>
              <div>
                <label className={`block text-xs font-medium mb-1 ${theme.subText}`}>SFTP 密码</label>
                <input type="password" value={local.sftpPass} onChange={e => setLocal({ ...local, sftpPass: e.target.value })} className={`w-full ${theme.inputBg} border ${theme.inputBorder} rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-blue-500 ${theme.heading}`} />
              </div>
              <div className="md:col-span-3">
                <label className={`block text-xs font-medium mb-1 ${theme.subText}`}>WordPress 根目录远程路径</label>
                <input value={local.remoteWpRoot} onChange={e => setLocal({ ...local, remoteWpRoot: e.target.value })} className={`w-full ${theme.inputBg} border ${theme.inputBorder} rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-blue-500 ${theme.heading}`} placeholder="/home/master/applications/xyz/public_html" />
              </div>
            </div>
          </section>
        </div>
        <div className={`p-6 border-t ${theme.cardBorder} flex justify-end gap-3`}>
          <button onClick={onClose} className={`px-4 py-2 rounded-lg border ${theme.cardBorder} ${theme.heading} hover:bg-slate-100 dark:hover:bg-slate-800`}>取消</button>
          <button onClick={() => { onSave(local); onClose(); }} className="bg-blue-600 hover:bg-blue-500 text-white font-bold px-8 py-2 rounded-lg shadow-lg">保存配置</button>
        </div>
      </div>
    </div>
  );
};

const MediaOpsDashboard: React.FC<{
  theme: any;
  settings: Settings;
  getApiKey: () => string;
  requireApiKey: (cb: () => void) => void;
  onNotice: (msg: string | null) => void;
}> = ({ theme, settings, getApiKey, requireApiKey, onNotice }) => {
  const [report, setReport] = useState<MediaOpsReport | null>(null);
  const [mediaItems, setMediaItems] = useState<MediaItem[]>([]);
  const [totalMedia, setTotalMedia] = useState(0);
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(10);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [config, setConfig] = useState({ dryRun: true, force: false, skipScan: true, quality: 80, useRestReplace: false });
  const [isLoadingList, setIsLoadingList] = useState(false);
  const [modalItem, setModalItem] = useState<MediaItem | null>(null);
  const [reviewItems, setReviewItems] = useState<ReviewItem[]>([]);
  const [reviewTotal, setReviewTotal] = useState(0);
  const [showReview, setShowReview] = useState(false);
  const [editedSeo, setEditedSeo] = useState<Record<number, Partial<ReviewItem>>>({});
  const [isApplying, setIsApplying] = useState(false);
  const [regeneratingId, setRegeneratingId] = useState<number | null>(null);
  const [regenerateStatus, setRegenerateStatus] = useState<Record<number, string>>({});

  const [manualKeywords, setManualKeywords] = useState<Record<number, string>>({});
  const [selectedReviewIds, setSelectedReviewIds] = useState<number[]>([]);
  // Track the media IDs from the last "AI 生成预览" batch so the review panel only shows those items
  const lastBatchRef = React.useRef<number[] | null>(null);
  const reportTotals = report?.totals ?? { totalMedia: 0, totalProcessed: 0, totalOptimized: 0, bytesSaved: 0, failures: 0 };
  const reportStatus = report?.status ?? { isRunning: false, operation: null, lastError: null };
  const reportByStatus = report?.byStatus ?? [];
  const [keywordCount, setKeywordCount] = useState(0);
  const [restReplaceStatus, setRestReplaceStatus] = useState<RestReplaceStatus | null>(null);
  const keywordFileRef = React.useRef<HTMLInputElement>(null);

  const fetchReport = useCallback(async () => {
    try {
      const res = await fetch('/api/media/report');
      if (res.ok) { setReport(await res.json()); setIsConnected(true); }
      else { setIsConnected(false); }
    } catch { setIsConnected(false); }
  }, []);

  const fetchRestReplaceStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/media/rest-replace-status');
      if (!res.ok) return;
      setRestReplaceStatus(await res.json());
    } catch (e) {
      console.error(e);
    }
  }, []);

  const fetchList = useCallback(async () => {
    setIsLoadingList(true);
    try {
      const res = await fetch(`/api/media/list?page=${page}&limit=${limit}&sort=id_desc`);
      if (res.ok) { const data = await res.json(); setMediaItems(data.items); setTotalMedia(data.total); }
    } catch (e) { console.error(e); }
    finally { setIsLoadingList(false); }
  }, [page, limit]);

  const fetchReviewItems = useCallback(async () => {
    try {
      let url = '/api/media/seo-review?review_status=pending&limit=100';
      // When a batch filter is active, only fetch items for those media IDs
      if (lastBatchRef.current && lastBatchRef.current.length > 0) {
        url += `&media_ids=${lastBatchRef.current.join(',')}`;
      }
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        setReviewItems(data.items || []);
        setReviewTotal(data.total || 0);
        if (data.total > 0) setShowReview(true);
      }
    } catch (e) { console.error(e); }
  }, []);

  useEffect(() => {
    fetchReport(); fetchList();
    const timer = setInterval(() => fetchReport(), 3000);
    return () => clearInterval(timer);
  }, [fetchReport, fetchList]);

  useEffect(() => {
    fetchRestReplaceStatus();
  }, [
    fetchRestReplaceStatus,
    settings.wpUrl,
    settings.wpUser,
    settings.wpAppPass,
    settings.sftpHost,
    settings.sftpUser,
    settings.sftpPass,
    settings.remoteWpRoot,
  ]);

  // Fetch keyword count on mount
  const fetchKeywordCount = useCallback(async () => {
    try {
      const res = await fetch('/api/media/keywords');
      if (res.ok) { const data = await res.json(); setKeywordCount(data.count || 0); }
    } catch { /* ignore */ }
  }, []);
  useEffect(() => { fetchKeywordCount(); }, [fetchKeywordCount]);

  // Handle keyword spreadsheet upload
  const handleKeywordUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const data = await file.arrayBuffer();
      const workbook = XLSX.read(data, { type: 'array' });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows: any[] = XLSX.utils.sheet_to_json(sheet, { defval: '' });

      // Auto-detect column names (support Google Keyword Planner, SEMrush, Ahrefs, generic)
      const findCol = (row: any, patterns: string[]): string | null => {
        for (const key of Object.keys(row)) {
          const lk = key.toLowerCase().trim();
          if (patterns.some(p => lk.includes(p))) return key;
        }
        return null;
      };

      const sample = rows[0] || {};
      const kwCol = findCol(sample, ['keyword', '关键词', '关键字', 'query', 'search term', 'term']);
      const volCol = findCol(sample, ['volume', 'avg. monthly', '搜索量', 'search vol', 'monthly']);
      const intentCol = findCol(sample, ['intent', '意图', 'search intent']);
      const cpcCol = findCol(sample, ['cpc', 'cost per click', '点击价格']);
      const compCol = findCol(sample, ['competition', '竞争', 'difficulty', 'kd']);

      if (!kwCol) {
        onNotice('❌ 未找到关键词列（需包含 "keyword" 或 "关键词" 列名）');
        return;
      }

      const keywords = rows
        .map(r => ({
          keyword: String(r[kwCol] || '').trim(),
          volume: volCol ? (parseInt(String(r[volCol]).replace(/[^0-9]/g, ''), 10) || 0) : undefined,
          intent: intentCol ? String(r[intentCol] || '').trim().toLowerCase() : undefined,
          cpc: cpcCol ? parseFloat(String(r[cpcCol]).replace(/[^0-9.]/g, '')) || undefined : undefined,
          competition: compCol ? String(r[compCol] || '').trim() : undefined,
        }))
        .filter(k => k.keyword.length > 0);

      if (keywords.length === 0) {
        onNotice('❌ 词表中没有找到有效关键词');
        return;
      }

      const res = await fetch('/api/media/keywords', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keywords }),
      });
      if (res.ok) {
        const result = await res.json();
        setKeywordCount(result.count || keywords.length);
        if (result.categorized) {
          const catSummary = result.categorySummary || {};
          const catParts = Object.entries(catSummary)
            .filter(([k]) => k !== 'other')
            .map(([k, v]) => `${k}: ${v}`)
            .slice(0, 4);
          const summaryStr = catParts.length > 0 ? `\n📊 分类: ${catParts.join(', ')}` : '';
          onNotice(`✅ 已上传 ${result.count} 个关键词，AI 已归类完成！\n🏷️ B2B 关键词: ${result.b2bCount} 个${summaryStr}`);
        } else {
          onNotice(`✅ 已上传 ${keywords.length} 个关键词（未归类，缺少 API Key）`);
        }
      } else {
        onNotice('❌ 上传关键词失败');
      }
    } catch (err: any) {
      onNotice('❌ 解析词表失败: ' + (err?.message || String(err)));
    } finally {
      // Reset file input so same file can be re-uploaded
      if (keywordFileRef.current) keywordFileRef.current.value = '';
    }
  };

  const handleClearKeywords = async () => {
    try {
      await fetch('/api/media/keywords', { method: 'DELETE' });
      setKeywordCount(0);
      onNotice('已清除关键词数据');
    } catch { /* ignore */ }
  };

  // Clear selection when page or limit changes so only current-page items are selected
  useEffect(() => {
    setSelectedIds([]);
  }, [page, limit]);

  // When task stops running, refresh list + check for review items
  const prevRunning = React.useRef(false);
  useEffect(() => {
    if (prevRunning.current && !reportStatus.isRunning) {
      fetchList();
      fetchReviewItems();
    }
    prevRunning.current = reportStatus.isRunning;
  }, [reportStatus.isRunning, fetchList, fetchReviewItems]);

  useEffect(() => {
    if (reportStatus.isRunning) {
      const timer = setInterval(fetchList, 5000);
      return () => clearInterval(timer);
    }
  }, [reportStatus.isRunning, fetchList]);

  const apiCall = async (endpoint: string, body: any, successMsg?: string) => {
    try {
      const res = await fetch(`/api/media/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) {
        let detail = `HTTP ${res.status}`;
        try { const data = await res.json(); detail = data?.detail || data?.error || detail; } catch { const text = await res.text(); if (text.trim()) detail = text; }
        throw new Error(detail);
      }
      if (successMsg) onNotice(successMsg);
      fetchReport();
      setTimeout(fetchList, 1000);
    } catch (e: any) { onNotice('❌ 操作失败: ' + (e?.message || String(e))); }
  };

  const handleScan = () => { lastBatchRef.current = null; apiCall('scan', { limit: 0 }); };

  const handleBatchRun = () => {
    if (selectedIds.length === 0) return alert("请先选择图片");
    apiCall('run', { ...config, ids: selectedIds });
    setSelectedIds([]);
  };

  const handleSelectAll = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.checked) setSelectedIds(mediaItems.map(i => i.id));
    else setSelectedIds([]);
  };

  const toggleSelect = (id: number) => {
    if (selectedIds.includes(id)) setSelectedIds(selectedIds.filter(i => i !== id));
    else setSelectedIds([...selectedIds, id]);
  };

  const updateReviewField = (genSeoId: number, field: string, value: string) => {
    setEditedSeo(prev => ({ ...prev, [genSeoId]: { ...prev[genSeoId], [field]: value } }));
  };

  const getReviewValue = (item: ReviewItem, field: keyof ReviewItem) => {
    return (editedSeo[item.id] as any)?.[field] ?? item[field];
  };

  const isItemValid = (item: ReviewItem) => {
    const fields = [
      { key: 'title', max: 60 },
      { key: 'alt_text', max: 125 },
      { key: 'caption', max: 100 },
      { key: 'description', max: 160 }
    ];
    return fields.every(f => {
      const val = getReviewValue(item, f.key as keyof ReviewItem) || '';
      return val.length <= f.max;
    });
  };

  const handleApproveItem = async (genSeoId: number) => {
    const edits = editedSeo[genSeoId] || {};
    await fetch(`/api/media/seo-review/${genSeoId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...edits, review_status: 'approved' }),
    });
    fetchReviewItems();
  };

  const handleRejectItem = async (genSeoId: number) => {
    await fetch(`/api/media/seo-review/${genSeoId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ review_status: 'rejected' }),
    });
    fetchReviewItems();
  };

  const handleBatchApprove = async (andApply = false) => {
    const itemsToApprove = selectedReviewIds.length > 0
      ? reviewItems.filter(r => selectedReviewIds.includes(r.id))
      : reviewItems;

    const validItems = itemsToApprove.filter(isItemValid);
    const invalidItems = itemsToApprove.filter(i => !isItemValid(i));

    if (itemsToApprove.length === 0) {
      onNotice("请先选择要批准的项目");
      return;
    }

    if (invalidItems.length > 0) {
      if (!confirm(`选中的项目中有 ${invalidItems.length} 个超过字数限制，将被自动截断。是否继续？`)) return;
    }

    const ids = itemsToApprove.map(r => r.id);

    // First save any edits
    for (const item of itemsToApprove) {
      const edits = editedSeo[item.id];
      if (edits) {
        await fetch(`/api/media/seo-review/${item.id}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(edits),
        });
      }
    }

    await fetch('/api/media/seo-review/batch', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, review_status: 'approved' }),
    });

    setEditedSeo({});
    setSelectedReviewIds([]);

    if (andApply) {
      onNotice(`已批准 ${ids.length} 个条目，正在同步到 WordPress...`);
      setIsApplying(true);
      try {
        const res = await fetch('/api/media/apply-seo', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids }),
        });
        if (res.ok) {
          const data = await res.json();
          onNotice(`成功同步 ${data.applied} 条 SEO 数据到 WordPress!`);
          fetchList();
          fetchReport();
        } else {
          let detail = '未知错误';
          try { const err = await res.json(); detail = err.detail || err.message || detail; } catch { /* ignore */ }
          onNotice(`同步失败: ${detail}`);
        }
      } catch (e: any) { onNotice('同步请求失败: ' + e.message); }
      finally {
        setIsApplying(false);
        fetchReviewItems();
      }
    } else {
      onNotice(`已批准 ${ids.length} 个 SEO 条目`);
      fetchReviewItems();
    }
  };

  const handleRegenerate = async (item: ReviewItem) => {
    requireApiKey(async () => {
      try {
        setRegeneratingId(item.id);
        setRegenerateStatus(prev => ({ ...prev, [item.id]: '生成中...' }));
        const apiKey = getApiKey();
        const customKeyword = manualKeywords[item.id]?.trim() || item.category_detected || '';
        if (!customKeyword) throw new Error("请输入核心关键词");

        // Try image-based regeneration first. Some sites block automated media downloads
        // behind Cloudflare, so we fall back to text-context generation when needed.
        let generated;
        try {
          const proxyUrl = `/api/media/proxy-image?url=${encodeURIComponent(item.source_url)}`;
          const imgRes = await fetch(proxyUrl);
          if (!imgRes.ok) {
            let detail = imgRes.statusText || `HTTP ${imgRes.status}`;
            try {
              const err = await imgRes.json();
              detail = err?.detail || err?.message || detail;
            } catch {
              // Ignore JSON parse failure and keep the HTTP status text.
            }
            throw new Error(detail);
          }
          const blob = await imgRes.blob();
          generated = await generateSEO(apiKey, blob, customKeyword, '', '');
        } catch (fetchErr: any) {
          console.warn('proxy-image failed, falling back to text-context regeneration', fetchErr);
          onNotice(`图片代理抓取失败，已切换为文本上下文生成：${fetchErr?.message || String(fetchErr)}`);
          setRegenerateStatus(prev => ({ ...prev, [item.id]: '原图被 Cloudflare 拦截，已切换文本生成...' }));
          generated = await generateSEOFromTextContext(apiKey, {
            filename: item.filename,
            mainKeyword: customKeyword,
            currentTitle: getReviewValue(item, 'title') || item.orig_title,
            currentAlt: getReviewValue(item, 'alt_text') || item.orig_alt_text,
            currentCaption: getReviewValue(item, 'caption') || item.orig_caption,
            currentDescription: getReviewValue(item, 'description') || item.orig_description,
          });
        }

        const seoDataKeyMap = {
          title: generated.title,
          alt_text: generated.alt,
          caption: generated.caption,
          description: generated.description
        };
        const hadChanges = (
          (getReviewValue(item, 'title') || '') !== seoDataKeyMap.title ||
          (getReviewValue(item, 'alt_text') || '') !== seoDataKeyMap.alt_text ||
          (getReviewValue(item, 'caption') || '') !== seoDataKeyMap.caption ||
          (getReviewValue(item, 'description') || '') !== seoDataKeyMap.description
        );

        // Persist regenerated data to database immediately (prevents loss on page refresh)
        try {
          await fetch(`/api/media/seo-review/${item.id}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(seoDataKeyMap),
          });
        } catch (saveErr) {
          console.warn('Failed to persist regenerated SEO to database:', saveErr);
        }

        // Update local state with new generated values
        setEditedSeo(prev => ({ ...prev, [item.id]: { ...prev[item.id], ...seoDataKeyMap } }));
        const successMessage = hadChanges ? "重新生成成功！请检查并批准。" : "生成完成，但结果与当前内容一致。";
        setRegenerateStatus(prev => ({ ...prev, [item.id]: successMessage }));
        onNotice(successMessage);
      } catch (e: any) {
        setRegenerateStatus(prev => ({ ...prev, [item.id]: `生成失败：${e.message}` }));
        onNotice("生成失败: " + e.message);
      } finally {
        setRegeneratingId(null);
      }
    });
  };



  const isRunning = reportStatus.isRunning;
  const restReplaceStateLabel = !restReplaceStatus
    ? '检测中'
    : restReplaceStatus.available
      ? 'REST 可用'
      : restReplaceStatus.canFallbackToSftp
        ? '将回退 SFTP'
        : 'REST 不可用';
  const restReplaceStateClass = !restReplaceStatus
    ? 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'
    : restReplaceStatus.available
      ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300'
      : restReplaceStatus.canFallbackToSftp
        ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
        : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300';

  return (
    <div className="w-full max-w-6xl space-y-6 pb-20">
      {/* Image Modal */}
      {modalItem && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4" onClick={() => setModalItem(null)}>
          <div className={`${theme.cardBg} rounded-2xl shadow-2xl max-w-4xl w-full max-h-[90vh] overflow-hidden flex flex-col`} onClick={e => e.stopPropagation()}>
            <div className={`flex justify-between items-center p-4 border-b ${theme.cardBorder}`}>
              <div>
                <h3 className={`font-bold text-lg ${theme.heading}`}>{modalItem.filename}</h3>
                <div className="flex items-center gap-2 mt-1">
                  <span className={`text-xs ${theme.subText}`}>ID: {modalItem.id}</span>
                  <span className={`text-xs ${theme.subText}`}>{modalItem.mime_type}</span>
                  {modalItem.gen_category && <span className="text-xs bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300 px-1.5 py-0.5 rounded">{modalItem.gen_category}</span>}
                </div>
              </div>
              <button onClick={() => setModalItem(null)} className={`p-2 rounded-full hover:bg-black/5 dark:hover:bg-white/5 ${theme.subText}`}><IconX /></button>
            </div>
            <div className="flex-1 overflow-auto p-4">
              {modalItem.source_url && <img src={modalItem.source_url} className="max-w-full h-auto mx-auto rounded-lg" alt={modalItem.filename} style={{ maxHeight: '50vh' }} />}
            </div>
            <div className={`border-t ${theme.cardBorder} p-4 grid grid-cols-1 md:grid-cols-2 gap-6`}>
              <div>
                <h4 className={`font-medium mb-2 text-sm ${theme.subText}`}>Original Metadata</h4>
                <div className="space-y-1 text-sm">
                  <div><span className={`text-xs ${theme.subText}`}>Title:</span> <span className={theme.heading}>{(modalItem as any).title || '-'}</span></div>
                  <div><span className={`text-xs ${theme.subText}`}>Alt:</span> <span className={theme.heading}>{(modalItem as any).alt_text || '-'}</span></div>
                </div>
              </div>
              {modalItem.gen_seo_id && (
                <div>
                  <h4 className="font-medium mb-2 text-sm text-blue-500">Generated SEO ({modalItem.gen_generator})</h4>
                  <div className="space-y-1 text-sm">
                    <div><span className={`text-xs ${theme.subText}`}>Title:</span> <span className={theme.heading}>{modalItem.gen_title || '-'}</span></div>
                    <div><span className={`text-xs ${theme.subText}`}>Alt:</span> <span className={theme.heading}>{modalItem.gen_alt_text || '-'}</span></div>
                    <div><span className={`text-xs ${theme.subText}`}>Caption:</span> <span className={theme.heading}>{modalItem.gen_caption || '-'}</span></div>
                    <div><span className={`text-xs ${theme.subText}`}>Description:</span> <span className={theme.heading}>{modalItem.gen_description || '-'}</span></div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Status Header */}
      <div className={`rounded-xl border ${theme.cardBorder} ${theme.cardBg} p-6 shrink-0`}>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className={`text-xl font-bold ${theme.heading}`}>WordPress 媒体库批量优化</h2>
            <div className={`text-sm mt-1 flex items-center gap-2 ${theme.subText}`}>
              <span className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-500' : 'bg-red-500'}`}></span>
              {isConnected ? 'Backend Connected' : 'Disconnected'}
              {isRunning && (
                <span className="text-green-600 animate-pulse font-bold ml-2 flex items-center gap-1">
                  <IconPlay className="w-3 h-3" />
                  正在运行: {reportStatus.operation === 'scan' ? '扫描媒体库' : reportStatus.operation === 'run' ? '批量优化' : reportStatus.operation || '任务'}...
                </span>
              )}
              {reportStatus.lastError && (
                <div className="text-red-500 text-xs font-medium ml-2 bg-red-50 dark:bg-red-900/20 px-2 py-1 rounded border border-red-100 dark:border-red-800">
                  错误: {reportStatus.lastError}
                </div>
              )}
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={() => apiCall('stop', {})} disabled={!isRunning} className="px-3 py-1 text-xs border border-red-200 text-red-600 rounded hover:bg-red-50 disabled:opacity-50">Stop Task</button>
            <button onClick={() => { fetchReport(); fetchList(); fetchRestReplaceStatus(); }} className={`p-2 rounded-full hover:bg-black/5 dark:hover:bg-white/5 ${theme.subText}`}><IconRefresh /></button>
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
          {[
            ['TOTAL MEDIA', reportTotals.totalMedia || 0],
            ['BYTES SAVED', formatBytes(reportTotals.bytesSaved || 0)],
            ['FAILURES', reportTotals.failures || 0],
            ['OPTIMIZED', (reportByStatus.find(s => s.status === 'optimized' || s.status === 'updated')?.total || 0)]
          ].map(([k, v]) => (
            <div key={k as string} className={`p-3 rounded-lg bg-slate-50 dark:bg-slate-800/50 border ${theme.cardBorder}`}>
              <div className={`text-xs uppercase tracking-wider ${theme.subText}`}>{k}</div>
              <div className={`text-lg font-bold mt-1 ${theme.heading}`}>{v}</div>
            </div>
          ))}
        </div>

        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-3 bg-slate-50 dark:bg-slate-900/50 p-4 rounded-lg border border-slate-200 dark:border-slate-700">
          <button onClick={handleScan} disabled={isRunning} className="bg-slate-800 hover:bg-black text-white text-sm font-bold py-2 px-4 rounded-lg disabled:opacity-50 flex items-center gap-2 shadow-sm">
            <IconRefresh className="w-4 h-4" /> 扫描媒体库
          </button>

          <div className="h-8 w-px bg-slate-300 dark:bg-slate-600 mx-1"></div>

          {/* B2B Keyword Upload */}
          <div className="flex items-center gap-1">
            <input
              ref={keywordFileRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              className="hidden"
              onChange={handleKeywordUpload}
            />
            <button
              onClick={() => keywordFileRef.current?.click()}
              className={`text-sm font-bold py-2 px-4 rounded-lg flex items-center gap-2 shadow-sm transition-all ${keywordCount > 0
                ? 'bg-emerald-600 hover:bg-emerald-500 text-white'
                : 'bg-slate-200 hover:bg-slate-300 dark:bg-slate-700 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-200'
                }`}
              title="上传谷歌词表(Excel/CSV)，AI生成SEO时自动匹配B2B关键词"
            >
              <IconDocumentText className="w-4 h-4" />
              {keywordCount > 0 ? `B2B词表 (${keywordCount})` : '上传B2B词表'}
            </button>
            {keywordCount > 0 && (
              <button
                onClick={handleClearKeywords}
                className="text-xs text-red-500 hover:text-red-700 px-1"
                title="清除已上传的关键词"
              >
                ✕
              </button>
            )}
          </div>

          <div className="h-8 w-px bg-slate-300 dark:bg-slate-600 mx-1"></div>

          <button
            onClick={() => {
              if (selectedIds.length === 0) return alert("请先选择图片");
              lastBatchRef.current = [...selectedIds]; // Remember this batch for review filtering
              apiCall('run', { ...config, ids: selectedIds, dryRun: true });
              setSelectedIds([]);
            }}
            disabled={isRunning || selectedIds.length === 0}
            className="bg-blue-600 hover:bg-blue-500 text-white text-sm font-bold py-2 px-5 rounded-lg disabled:opacity-50 flex items-center gap-2 shadow-lg transition-all transform active:scale-95"
            title="AI根据图片内容生成SEO信息和压缩预览，不修改线上文件"
          >
            <IconSparkles className="w-4 h-4" /> 1. AI 生成预览 ({selectedIds.length})
          </button>

          <button
            onClick={() => {
              if (selectedIds.length === 0) return onNotice("请先选择图片");
              if (config.useRestReplace && restReplaceStatus && !restReplaceStatus.available && !restReplaceStatus.canFallbackToSftp) {
                return onNotice(`❌ ${restReplaceStatus.detail}`);
              }
              lastBatchRef.current = null; // Not a preview operation, clear batch filter
              const mode = config.useRestReplace ? "免 SFTP 替换" : "SFTP 替换";
              onNotice(`🚀 开始执行 ${mode} 同步，共 ${selectedIds.length} 张图片...`);
              apiCall('run', { ...config, ids: selectedIds, dryRun: false, force: true }, `✅ 同步任务已启动`);
              setSelectedIds([]);
            }}
            disabled={isRunning || selectedIds.length === 0}
            className="bg-amber-600 hover:bg-amber-500 text-white text-sm font-bold py-2 px-5 rounded-lg disabled:opacity-50 flex items-center gap-2 shadow-lg transition-all transform active:scale-95"
            title={config.useRestReplace ? (restReplaceStatus?.detail || "使用 REST API 直接替换原图 (需安装插件)") : "使用 SFTP 替换原图"}
          >
            <IconCloudUpload className="w-4 h-4" /> 直接同步上线
          </button>

          <label className="flex items-center gap-1 text-xs text-slate-600 dark:text-slate-400 cursor-pointer select-none" title={restReplaceStatus?.detail || "需要安装配套插件，无需 SFTP"}>
            <input
              type="checkbox"
              checked={config.useRestReplace || false}
              onChange={e => {
                const checked = e.target.checked;
                setConfig(prev => ({ ...prev, useRestReplace: checked }));
                if (checked && restReplaceStatus && !restReplaceStatus.available) {
                  const suffix = restReplaceStatus.canFallbackToSftp ? ' 当前会自动回退到 SFTP。' : '';
                  onNotice(`⚠️ ${restReplaceStatus.detail}${suffix}`);
                }
              }}
              className="rounded border-slate-300"
            />
            免SFTP模式
          </label>

          <span className={`text-[11px] px-2 py-1 rounded-full font-medium ${restReplaceStateClass}`}>
            {restReplaceStateLabel}
          </span>

          <button
            onClick={async () => {
              if (selectedIds.length === 0) return onNotice("请先勾选要更新的图片");
              lastBatchRef.current = null;
              const count = selectedIds.length;
              onNotice(`🚀 正在为 ${count} 张图片上传已有 SEO 元数据到 WordPress...`);
              const idsToApply = [...selectedIds];
              setSelectedIds([]);
              try {
                const res = await fetch('/api/media/apply-seo', {
                  method: 'POST', headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ media_ids: idsToApply }),
                });
                if (res.ok) {
                  const data = await res.json();
                  if (data.applied > 0) {
                    onNotice(`✅ 成功同步 ${data.applied} 条 SEO 数据到 WordPress${data.skipped ? `，跳过 ${data.skipped} 条空数据` : ''}`);
                  } else {
                    onNotice('⚠️ 所选图片暂无已生成的 SEO 数据，请先用「AI 生成预览」生成后再同步');
                  }
                  fetchList();
                  fetchReport();
                } else {
                  let detail = '未知错误';
                  try { const err = await res.json(); detail = err.detail || err.message || detail; } catch { /* ignore */ }
                  onNotice(`❌ 同步失败: ${detail}`);
                }
              } catch (e: any) { onNotice('❌ 网络请求失败: ' + e.message); }
            }}
            disabled={isRunning || selectedIds.length === 0}
            className="bg-teal-600 hover:bg-teal-500 text-white text-sm font-bold py-2 px-5 rounded-lg disabled:opacity-50 flex items-center gap-2 shadow-lg transition-all transform active:scale-95"
            title="将数据库中已生成的 SEO 直接推送到 WordPress (无需重新生成)"
          >
            <IconDocumentText className="w-4 h-4" /> 仅更新 SEO
          </button>

          {restReplaceStatus && !restReplaceStatus.available && (
            <div className={`w-full text-xs rounded-lg border px-3 py-2 ${
              restReplaceStatus.canFallbackToSftp
                ? 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/40 dark:bg-amber-950/20 dark:text-amber-300'
                : 'border-red-200 bg-red-50 text-red-700 dark:border-red-900/40 dark:bg-red-950/20 dark:text-red-300'
            }`}>
              {restReplaceStatus.detail}
              {restReplaceStatus.canFallbackToSftp && ' 已检测到 SFTP 配置，运行时会自动回退到 SFTP。'}
            </div>
          )}

          {selectedIds.length === 0 && !isRunning && (
            <span className={`text-xs ${theme.subText} ml-2`}> (← 勾选下方列表后操作)</span>
          )}

          <div className="flex-1"></div>

          {reviewTotal > 0 && (
            <button onClick={() => { if (!showReview) { lastBatchRef.current = null; fetchReviewItems(); } setShowReview(!showReview); }} className="bg-purple-600 hover:bg-purple-500 text-white text-sm font-bold py-2 px-5 rounded-lg flex items-center gap-2 animate-bounce-slow shadow-lg">
              <IconCheck className="w-4 h-4" /> 2. 审核并发布 ({reviewTotal})
            </button>
          )}
        </div>
      </div>

      {/* SEO Review Panel */}
      {showReview && (reviewItems.length > 0 || isApplying) && (
        <div className={`rounded-xl border ${theme.cardBorder} ${theme.cardBg} overflow-hidden shrink-0`}>
          <div className={`flex items-center justify-between p-4 border-b ${theme.cardBorder}`}>
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={selectedReviewIds.length === reviewItems.length && reviewItems.length > 0}
                  onChange={(e) => {
                    if (e.target.checked) setSelectedReviewIds(reviewItems.map(i => i.id));
                    else setSelectedReviewIds([]);
                  }}
                  className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                />
                <span className={`text-xs font-medium ${theme.subText}`}>全选</span>
              </div>
              <h3 className={`font-bold ${theme.heading}`}>SEO 审核 ({reviewItems.length} 待审核)</h3>
            </div>
            <div className="flex gap-2 items-center">
              {isApplying && (
                <div className="flex items-center gap-2 text-xs text-purple-600 dark:text-purple-400 font-medium">
                  <div className="w-3.5 h-3.5 border-2 border-purple-300 border-t-purple-600 rounded-full animate-spin" />
                  正在同步到 WordPress...
                </div>
              )}
              <button onClick={() => handleBatchApprove(true)} disabled={isApplying} className="bg-purple-600 hover:bg-purple-500 text-white text-xs font-bold py-1.5 px-3 rounded flex items-center gap-1 shadow-md hover:shadow-lg transition-transform active:scale-95 disabled:opacity-50">
                <IconCloudUpload className="w-3 h-3" />
                {selectedReviewIds.length > 0 ? `批准并同步选中 (${selectedReviewIds.length})` : '全部批准并同步'}
              </button>
              <button onClick={() => handleBatchApprove(false)} disabled={isApplying} className="bg-green-600 hover:bg-green-500 text-white text-xs font-medium py-1.5 px-3 rounded flex items-center gap-1 opacity-80 hover:opacity-100 disabled:opacity-50">
                仅批准
              </button>
              <button onClick={() => setShowReview(false)} className={`p-1 rounded hover:bg-black/5 dark:hover:bg-white/5 ${theme.subText}`}><IconX /></button>
            </div>
          </div>
          <div className="max-h-[60vh] overflow-y-auto divide-y dark:divide-slate-800">
            {reviewItems.length === 0 && isApplying && (
              <div className="p-8 text-center">
                <div className="w-8 h-8 border-4 border-purple-200 border-t-purple-600 rounded-full animate-spin mx-auto mb-3" />
                <div className={`text-sm font-medium ${theme.heading}`}>正在将 SEO 数据同步到 WordPress...</div>
                <div className={`text-xs mt-1 ${theme.subText}`}>请稍候，同步完成后将自动刷新</div>
              </div>
            )}
            {reviewItems.map(item => (
              <div key={item.id} className="p-4 grid grid-cols-[32px_64px_1fr_1fr_auto] gap-4 items-start">
                <div className="pt-6">
                  <input
                    type="checkbox"
                    checked={selectedReviewIds.includes(item.id)}
                    onChange={(e) => {
                      if (e.target.checked) setSelectedReviewIds(prev => [...prev, item.id]);
                      else setSelectedReviewIds(prev => prev.filter(id => id !== item.id));
                    }}
                    className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                  />
                </div>
                {/* Thumbnail */}
                <img
                  src={item.source_url}
                  className="w-16 h-16 object-cover rounded border border-slate-200 dark:border-slate-700 cursor-pointer hover:ring-2 hover:ring-blue-500 transition-all"
                  alt={item.filename}
                  loading="lazy"
                  onClick={() => setModalItem({
                    id: item.media_id,
                    filename: item.filename,
                    source_url: item.source_url,
                    mime_type: 'image',
                    status: 'reviewing',
                    bytes_original: 0,
                    bytes_optimized: 0,
                    updated_at: new Date().toISOString(),
                    gen_seo_id: item.id,
                    gen_title: item.title,
                    gen_alt_text: item.alt_text,
                    gen_caption: item.caption,
                    gen_description: item.description,
                    gen_category: item.category_detected || undefined,
                    gen_review_status: item.review_status,
                    gen_generator: item.generator,
                    title: item.orig_title,
                    alt_text: item.orig_alt_text,
                  } as any)}
                />
                {/* Original */}
                <div className="min-w-0">
                  <div className={`text-xs font-medium mb-1 ${theme.subText}`}>Original</div>
                  <div className={`text-xs ${theme.heading} truncate`} title={item.orig_title}>Title: {item.orig_title || '-'}</div>
                  <div className={`text-xs ${theme.heading} truncate`} title={item.orig_alt_text}>Alt: {item.orig_alt_text || '-'}</div>
                </div>
                {/* Generated (Editable) */}
                <div className="min-w-0 space-y-3">
                  {/* Regeneration Toolbar */}
                  <div className="flex items-center gap-2 mb-2 p-2 bg-slate-50 dark:bg-slate-800 rounded border border-slate-100 dark:border-slate-700">
                    <span className={`text-xs font-bold ${theme.subText} uppercase`}>Core Keyword:</span>
                    <input
                      value={manualKeywords[item.id] ?? item.category_detected ?? ''}
                      onChange={e => setManualKeywords(prev => ({ ...prev, [item.id]: e.target.value }))}
                      className={`flex-1 text-xs px-2 py-1 rounded border ${theme.inputBorder} ${theme.inputBg} ${theme.heading}`}
                      placeholder="Enter new keyword..."
                    />
                    <button
                      onClick={() => handleRegenerate(item)}
                      disabled={regeneratingId === item.id}
                      className="text-xs bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300 px-2 py-1 rounded hover:bg-blue-200 flex items-center gap-1"
                    >
                      {regeneratingId === item.id ? <div className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" /> : <IconRefresh className="w-3 h-3" />}
                      生成
                    </button>
                  </div>
                  {regenerateStatus[item.id] && (
                    <div className={`text-[11px] ${regenerateStatus[item.id].includes('失败') ? 'text-red-500' : 'text-slate-500'} mb-2`}>
                      {regenerateStatus[item.id]}
                    </div>
                  )}


                  {/* Editable Fields */}
                  {[
                    { key: 'title', label: 'Title', max: 60 },
                    { key: 'alt_text', label: 'Alt Text', max: 125 },
                    { key: 'caption', label: 'Caption', max: 100 },
                    { key: 'description', label: 'Description', max: 160 }
                  ].map(field => {
                    const value = getReviewValue(item, field.key as keyof ReviewItem) || '';
                    const isOver = value.length > field.max;
                    return (
                      <div key={field.key} className="relative group">
                        <textarea
                          value={value}
                          onChange={e => updateReviewField(item.id, field.key, e.target.value)}
                          rows={field.key === 'description' ? 3 : 2}
                          className={`w-full text-xs ${theme.inputBg} border ${isOver ? 'border-red-500 focus:ring-red-500' : theme.inputBorder} rounded px-3 py-2 ${theme.heading} resize-y focus:ring-1 focus:ring-blue-500 outline-none block`}
                          placeholder={field.label}
                        />
                        <div className={`absolute bottom-1 right-2 pointer-events-none text-[10px] ${isOver ? 'text-red-500 font-bold' : 'text-slate-400'} bg-white/80 dark:bg-black/50 px-1 rounded`}>
                          {value.length} / {field.max} chars
                        </div>
                        <div className="absolute top-0 right-0 -mt-5 text-[10px] font-bold text-slate-400 opacity-0 group-hover:opacity-100 transition-opacity uppercase">{field.label}</div>
                      </div>
                    );
                  })}
                </div>
                {/* Actions */}
                <div className="flex flex-col gap-1">
                  <button
                    onClick={() => handleApproveItem(item.id)}
                    disabled={!isItemValid(item)}
                    className="text-xs bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300 px-2 py-1 rounded hover:bg-green-200 disabled:opacity-50 disabled:cursor-not-allowed"
                    title={!isItemValid(item) ? "Characters exceed limit" : "Approve"}
                  >
                    批准
                  </button>
                  <button onClick={() => handleRejectItem(item.id)} className="text-xs bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300 px-2 py-1 rounded hover:bg-red-200">拒绝</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Data Grid */}
      <div className={`rounded-xl border ${theme.cardBorder} ${theme.cardBg} overflow-hidden flex flex-col shadow-sm`}>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 dark:bg-slate-800 border-b dark:border-slate-700">
              <tr>
                <th className="p-3 w-10"><input type="checkbox" onChange={handleSelectAll} checked={mediaItems.length > 0 && mediaItems.every(i => selectedIds.includes(i.id))} /></th>
                <th className={`p-3 w-16 font-medium ${theme.subText}`}>Preview</th>
                <th className={`p-3 font-medium ${theme.subText}`}>ID</th>
                <th className={`p-3 font-medium ${theme.subText}`}>Filename</th>
                <th className={`p-3 font-medium ${theme.subText}`}>Size</th>
                <th className={`p-3 font-medium ${theme.subText}`}>Status</th>
                <th className={`p-3 font-medium ${theme.subText}`}>Updated</th>
              </tr>
            </thead>
            <tbody className="divide-y dark:divide-slate-800">
              {isLoadingList ? (
                <tr><td colSpan={7} className="p-8 text-center text-slate-400">Loading...</td></tr>
              ) : mediaItems.length === 0 ? (
                <tr><td colSpan={7} className="p-8 text-center text-slate-400">No media found. Click "Scan" to fetch from WordPress.</td></tr>
              ) : (
                mediaItems.map(item => (
                  <tr key={item.id} className={`hover:bg-slate-50 dark:hover:bg-slate-800/50 ${selectedIds.includes(item.id) ? 'bg-blue-50 dark:bg-blue-900/10' : ''}`}>
                    <td className="p-3"><input type="checkbox" checked={selectedIds.includes(item.id)} onChange={() => toggleSelect(item.id)} /></td>
                    <td className="p-3">
                      {item.source_url ? (
                        <img src={item.source_url} alt={item.filename} className="w-12 h-12 object-cover rounded cursor-pointer border border-slate-200 dark:border-slate-700 hover:ring-2 hover:ring-blue-500" onClick={() => setModalItem(item)} loading="lazy" />
                      ) : (
                        <div className="w-12 h-12 bg-slate-100 dark:bg-slate-800 rounded flex items-center justify-center"><IconPhoto /></div>
                      )}
                    </td>
                    <td className={`p-3 font-mono text-xs ${theme.subText}`}>{item.id}</td>
                    <td className="p-3 max-w-[200px]">
                      <div className={`truncate ${theme.heading}`} title={item.filename}>{item.filename}</div>
                      <span className="text-xs text-slate-400">{item.mime_type}</span>
                      {item.gen_category && <span className="text-xs bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300 px-1.5 py-0.5 rounded ml-1">{item.gen_category}</span>}
                    </td>
                    <td className={`p-3 ${theme.subText}`}>{formatBytes(item.bytes_original || 0)}</td>
                    <td className="p-3">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium
                        ${item.status === 'updated' ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300' :
                          item.status === 'error' ? 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300' :
                            item.status === 'scanned' ? 'bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-300' :
                              item.status === 'dry_run' ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300' :
                                'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300'}`}>
                        {item.status}
                      </span>
                      {item.gen_review_status && item.gen_review_status !== 'applied' && (
                        <span className={`ml-1 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium
                          ${item.gen_review_status === 'approved' ? 'bg-green-50 text-green-600' :
                            item.gen_review_status === 'pending' ? 'bg-amber-50 text-amber-600' : 'bg-slate-50 text-slate-500'}`}>
                          {item.gen_review_status}
                        </span>
                      )}
                      {item.error_reason && <div className="text-xs text-red-500 max-w-[200px] truncate" title={item.error_reason}>{item.error_reason}</div>}
                    </td>

                    <td className={`p-3 text-xs ${theme.subText}`}>{new Date(item.updated_at).toLocaleString()}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <div className="p-3 border-t dark:border-slate-700 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className={`text-sm ${theme.subText}`}>
              Showing {(page - 1) * limit + 1} to {Math.min(page * limit, totalMedia)} of {totalMedia}
            </div>
            <select
              value={limit}
              onChange={e => { setLimit(Number(e.target.value)); setPage(1); }}
              className={`text-xs ${theme.inputBg} border ${theme.inputBorder} rounded px-2 py-1 ${theme.heading}`}
            >
              {[10, 20, 50, 100].map(v => <option key={v} value={v}>每页 {v} 条</option>)}
            </select>
          </div>
          <div className="flex gap-2 items-center">
            <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1} className="px-3 py-1 border rounded hover:bg-slate-50 disabled:opacity-50 text-sm transition-colors">Prev</button>
            <span className={`text-sm ${theme.subText}`}>第</span>
            <input
              type="number"
              min={1}
              max={Math.max(1, Math.ceil(totalMedia / limit))}
              value={page}
              onChange={e => {
                const maxPage = Math.max(1, Math.ceil(totalMedia / limit));
                const v = parseInt(e.target.value, 10);
                if (!isNaN(v) && v >= 1 && v <= maxPage) setPage(v);
              }}
              className={`w-16 text-center text-sm border rounded px-1 py-1 ${theme.inputBg} ${theme.inputBorder} ${theme.heading}`}
            />
            <span className={`text-sm ${theme.subText}`}>/ {Math.max(1, Math.ceil(totalMedia / limit))} 页</span>
            <button onClick={() => setPage(p => p + 1)} disabled={page * limit >= totalMedia} className="px-3 py-1 border rounded hover:bg-slate-50 disabled:opacity-50 text-sm transition-colors">Next</button>
          </div>
        </div>
      </div>
    </div>
  );
};

const App: React.FC = () => {
  const [viewMode, setViewMode] = useState<'image' | 'blog' | 'mediaOps' | 'productSeo'>('image');
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [images, setImages] = useState<WorkImage[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [imageNotice, setImageNotice] = useState<string | null>(null);
  const [imageKeywordContext, setImageKeywordContext] = useState<string>();
  const [imageKeywordFileName, setImageKeywordFileName] = useState<string>();
  const [blogState, setBlogState] = useState<BlogState>({ topic: '', keywords: '', referenceContent: '', outline: '', content: '', refineInstruction: '', status: BlogStatus.IDLE });

  useEffect(() => { document.documentElement.classList.toggle('dark', isDarkMode); }, [isDarkMode]);
  useEffect(() => {
    let mounted = true;

    const loadSettings = async () => {
      try {
        const res = await fetch('/api/settings');
        if (!res.ok) return;
        const remote = await res.json();
        if (!mounted) return;
        setSettings(prev => ({ ...prev, ...remote, backendUrl: normalizeBackendUrl(remote.backendUrl) }));
      } catch (e) {
        console.warn('Failed to load backend settings', e);
      }
    };

    loadSettings();
    return () => { mounted = false; };
  }, []);

  const handleSaveSettings = async (newSettings: Settings) => {
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newSettings),
      });
      if (res.ok) {
        setSettings(newSettings);
        setImageNotice('设置已成功保存到后端服务器。');
      } else {
        const data = await res.json();
        alert('保存失败：' + (data?.detail || '未知错误'));
      }
    } catch (e: any) {
      alert('网络错误：' + e.message);
    }
  };

  const getApiKey = () => settings.googleApiKey?.trim() || '';
  const requireApiKey = (cb: () => void) => {
    if (!getApiKey()) {
      setImageNotice('未配置 Gemini API Key。请在系统设置中输入，或在后端 .env 中配置 GEMINI_API_KEY。');
      setShowSettings(true);
      return;
    }
    cb();
  };

  const handleFiles = useCallback(async (files: File[]) => {
    const imageFiles = files.filter(f => f.type.startsWith('image/'));
    if (!imageFiles.length) return;
    const newImages: WorkImage[] = [];
    for (const file of imageFiles) {
      try {
        const { width, height } = await loadImage(file);
        newImages.push({ id: Math.random().toString(36).substring(7), file, previewUrl: URL.createObjectURL(file), targetWidth: 1200, quality: 0.75, mainKeyword: '', extraDesc: '', originalSize: file.size, originalDimensions: { width, height }, status: ProcessingStatus.IDLE });
      } catch (err) { console.error("Failed to load image", file.name, err); }
    }
    setImages(prev => [...prev, ...newImages]);
    if (!activeId && newImages.length) setActiveId(newImages[0].id);
    if (newImages.length) setViewMode('image');
  }, [activeId]);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => { if (e.target.files) handleFiles(Array.from(e.target.files)); e.target.value = ''; };
  const handleExcelUpload = async (e: React.ChangeEvent<HTMLInputElement>, target: 'image' | 'blog') => {
    const file = e.target.files?.[0]; if (!file) return;
    try {
      const context = await parseExcelFile(file);
      if (target === 'image') { setImageKeywordContext(context); setImageKeywordFileName(file.name); }
      else setBlogState(prev => ({ ...prev, keywordContext: context, keywordFileName: file.name }));
    } catch (err) {
      if (target === 'image') setImageNotice('提示：SEO关键词库文件解析失败，已忽略该文件。');
    }
    e.target.value = '';
  };

  const handleDragOver = (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); if (viewMode === 'image') setIsDraggingOver(true); };
  const handleDragLeave = (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); setIsDraggingOver(false); };
  const handleDrop = (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); setIsDraggingOver(false); if (e.dataTransfer.files?.length) handleFiles(Array.from(e.dataTransfer.files)); };

  const activeImage = images.find(img => img.id === activeId);
  const updateImage = (id: string, updates: Partial<WorkImage>) => setImages(prev => prev.map(img => img.id === id ? { ...img, ...updates } : img));
  const updateActiveImage = (updates: Partial<WorkImage>) => { if (activeId) updateImage(activeId, updates); };
  const deleteImage = (id: string, e: React.MouseEvent) => { e.stopPropagation(); const newImages = images.filter(img => img.id !== id); setImages(newImages); if (activeId === id) setActiveId(newImages[0]?.id || null); };

  const resolvedBackendUrl = '/api';

  const fallbackSEO = (img: WorkImage): SEOData => {
    const base = (img.mainKeyword || img.file.name.replace(/\.[^.]+$/, '') || 'image').trim() || 'image';
    const slug = base.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, '-').replace(/^-+|-+$/g, '') || 'image';
    return {
      filename: `${slug}.webp`,
      title: base,
      alt: base,
      caption: base,
      description: img.extraDesc?.trim() || base,
    };
  };

  const hasValidSeoData = (seo?: SEOData) => {
    if (!seo) return false;
    return Boolean(
      seo.alt?.trim() ||
      seo.title?.trim() ||
      seo.caption?.trim() ||
      seo.description?.trim()
    );
  };

  const normalizeSeoData = (seo: SEOData | undefined, fallback: SEOData): SEOData => ({
    filename: seo?.filename?.trim() || fallback.filename,
    title: seo?.title?.trim() || fallback.title,
    alt: seo?.alt?.trim() || fallback.alt,
    caption: seo?.caption?.trim() || fallback.caption,
    description: seo?.description?.trim() || fallback.description,
  });

  const isLikelyFallbackSeo = (seo: SEOData | undefined, keyword: string) => {
    if (!seo) return true;
    const k = keyword.trim().toLowerCase();
    if (!k) return false;
    const fields = [seo.alt, seo.title, seo.caption, seo.description].map(v => (v || '').trim().toLowerCase());
    return fields.every(v => !v || v === k);
  };

  const calcScaledDimensions = (img: WorkImage, targetWidth: number) => {
    const ow = img.originalDimensions?.width || 0;
    const oh = img.originalDimensions?.height || 0;
    if (!ow || !oh) return { width: 0, height: 0 };
    if (targetWidth > 0 && ow > targetWidth) {
      return { width: targetWidth, height: Math.round((oh / ow) * targetWidth) };
    }
    return { width: ow, height: oh };
  };

  const estimateProcessedSize = (img: WorkImage): number | null => {
    if (!img.originalSize) return null;
    const current = calcScaledDimensions(img, img.targetWidth);
    if (!current.width || !current.height) return null;

    if (img.processedSize && img.lastProcessedQuality && img.lastProcessedTargetWidth !== undefined) {
      const base = calcScaledDimensions(img, img.lastProcessedTargetWidth);
      if (base.width && base.height) {
        const areaRatio = (current.width * current.height) / (base.width * base.height);
        const qualityRatio = Math.pow((img.quality + 0.05) / (img.lastProcessedQuality + 0.05), 1.15);
        return Math.max(1024, Math.round(img.processedSize * areaRatio * qualityRatio));
      }
    }

    const areaRatio = (current.width * current.height) / ((img.originalDimensions?.width || current.width) * (img.originalDimensions?.height || current.height));
    const qualityFactor = 0.06 + img.quality * 0.22;
    return Math.max(1024, Math.round(img.originalSize * areaRatio * qualityFactor));
  };

  const processQueue = async () => {
    if (isProcessing || isUploading) return;
    setIsProcessing(true);
    const canReprocessCurrent = Boolean(activeImage && (activeImage.processedUrl || activeImage.status === ProcessingStatus.COMPLETED));
    const queue = canReprocessCurrent
      ? [activeImage!]
      : images.filter(i => i.status === ProcessingStatus.IDLE || i.status === ProcessingStatus.ERROR);
    let apiKey = getApiKey();
    if (!apiKey) {
      try {
        const res = await fetch('/api/settings');
        if (res.ok) {
          const remote = await res.json();
          apiKey = String(remote?.googleApiKey || '').trim();
          if (apiKey) setSettings(prev => ({ ...prev, googleApiKey: apiKey }));
        }
      } catch (e) {
        console.warn('fetch /api/settings failed', e);
      }
    }
    const hasGemini = Boolean(apiKey);
    let completedCount = 0;
    for (const img of queue) {
      setActiveId(img.id);
      try {
        updateImage(img.id, { status: ProcessingStatus.PROCESSING, errorMessage: undefined });
        const { blob, width, height } = await processImageToWebP(img.file, img.targetWidth, img.quality);
        updateImage(img.id, { processedBlob: blob, processedUrl: URL.createObjectURL(blob), processedSize: blob.size, processedDimensions: { width, height } });
        const fallback = fallbackSEO(img);
        const keywordSeed = img.mainKeyword.trim() || fallback.title || 'image';
        let seoData = normalizeSeoData(img.seoData, fallback);
        const isCurrentGemini = img.seoSource === 'gemini';
        const hasFallbackLikeContent = isLikelyFallbackSeo(img.seoData, keywordSeed);
        const shouldGenerateSeo = hasGemini && (
          !isCurrentGemini ||
          !hasValidSeoData(img.seoData) ||
          hasFallbackLikeContent
        );
        if (shouldGenerateSeo) {
          updateImage(img.id, { status: ProcessingStatus.GENERATING_SEO });
          try {
            const generated = await generateSEO(apiKey, blob, keywordSeed, img.extraDesc, imageKeywordContext);
            seoData = normalizeSeoData(generated, fallback);
            updateImage(img.id, { seoSource: 'gemini' });
          } catch (e) {
            console.warn('generateSEO failed, fallback metadata used', e);
            seoData = fallback;
            updateImage(img.id, { seoSource: 'fallback' });
            const msg = e instanceof Error ? e.message : String(e);
            setImageNotice(`Gemini 调用失败，已使用默认SEO：${msg}`);
          }
        } else if (!isCurrentGemini) {
          updateImage(img.id, { seoSource: 'fallback' });
        }
        updateImage(img.id, { seoData });
        updateImage(img.id, {
          status: ProcessingStatus.COMPLETED,
          lastProcessedQuality: img.quality,
          lastProcessedTargetWidth: img.targetWidth,
          wpData: undefined,
        });
        completedCount += 1;
      } catch (error: any) { updateImage(img.id, { status: ProcessingStatus.ERROR, errorMessage: error.message }); }
    }
    setIsProcessing(false);
    if (!hasGemini && completedCount > 0) {
      setImageNotice('提示：当前未连接 Gemini API，无法自动生成 SEO 信息（已使用默认信息，可手动编辑后上传）。');
    } else if (completedCount > 0) {
      setImageNotice(null);
    }
  };

  const handleManualWPUpload = async () => {
    if (!activeImage?.processedBlob) return;
    if (isProcessing || isUploading) return;
    try {
      setIsUploading(true);
      updateActiveImage({ status: ProcessingStatus.UPLOADING });
      const seoData = activeImage.seoData || fallbackSEO(activeImage);
      const wpData = await uploadToWordPress('', '', '', activeImage.processedBlob, seoData, true, resolvedBackendUrl);
      updateActiveImage({ wpData, status: ProcessingStatus.COMPLETED });
      setImageNotice('已上传到 WordPress。');
    } catch (error: any) {
      updateActiveImage({ status: ProcessingStatus.ERROR, errorMessage: error.message });
      setImageNotice(`上传失败：${error.message}`);
    }
    finally { setIsUploading(false); }
  };

  const regenerateActiveSeo = async () => {
    if (!activeImage?.processedBlob) {
      setImageNotice('请先处理图片，再使用 Gemini 生成 SEO。');
      return;
    }
    if (isProcessing || isUploading) return;

    let apiKey = getApiKey();
    if (!apiKey) {
      try {
        const res = await fetch('/api/settings');
        if (res.ok) {
          const remote = await res.json();
          apiKey = String(remote?.googleApiKey || '').trim();
          if (apiKey) setSettings(prev => ({ ...prev, googleApiKey: apiKey }));
        }
      } catch (e) {
        console.warn('fetch /api/settings failed', e);
      }
    }
    if (!apiKey) {
      setImageNotice('后端未配置 Gemini API Key，请在服务器环境变量配置后重试。');
      return;
    }

    const fallback = fallbackSEO(activeImage);
    const keywordSeed = activeImage.mainKeyword.trim() || fallback.title || 'image';
    try {
      updateActiveImage({ status: ProcessingStatus.GENERATING_SEO, errorMessage: undefined });
      const generated = await generateSEO(apiKey, activeImage.processedBlob, keywordSeed, activeImage.extraDesc, imageKeywordContext);
      const seoData = normalizeSeoData(generated, fallback);
      updateActiveImage({ seoData, seoSource: 'gemini', status: ProcessingStatus.COMPLETED });
      setImageNotice('已通过 Gemini 重新生成 SEO 信息。');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      updateActiveImage({ status: ProcessingStatus.COMPLETED });
      setImageNotice(`Gemini 调用失败：${msg}`);
    }
  };

  const handleBlogAction = async (action: 'outline' | 'post' | 'refine' | 'seo') => requireApiKey(async () => {
    const apiKey = getApiKey();
    const setStatus = (status: BlogStatus, extra?: Partial<BlogState>) => setBlogState(prev => ({ ...prev, status, errorMessage: undefined, ...extra }));
    try {
      if (action === 'outline') {
        if (!blogState.topic.trim()) { alert("请输入文章主题"); return; }
        setStatus(BlogStatus.GENERATING_OUTLINE);
        const outline = await generateBlogOutline(apiKey, blogState.topic, blogState.keywords, blogState.referenceContent, blogState.keywordContext);
        setStatus(BlogStatus.OUTLINE_READY, { outline });
      } else if (action === 'post') {
        setStatus(BlogStatus.GENERATING_POST);
        const content = await generateFullPost(apiKey, blogState.topic, blogState.outline, blogState.referenceContent, blogState.keywordContext);
        setStatus(BlogStatus.COMPLETED, { content });
      } else if (action === 'refine') {
        if (!blogState.refineInstruction.trim()) { alert("请输入修改意见"); return; }
        setStatus(BlogStatus.REFINING);
        const content = await refineBlogPost(apiKey, blogState.content, blogState.refineInstruction);
        setStatus(BlogStatus.COMPLETED, { content, refineInstruction: '' });
      } else if (action === 'seo') {
        if (!blogState.content.trim()) return;
        setStatus(BlogStatus.GENERATING_SEO);
        const seo = await generateBlogSEO(apiKey, blogState.content, blogState.keywordContext);
        setStatus(BlogStatus.COMPLETED, { seo });
      }
    } catch (e: any) { setBlogState(prev => ({ ...prev, status: BlogStatus.ERROR, errorMessage: e.message })); }
  });

  const handleExportWord = () => {
    if (!blogState.content.trim()) return;
    const html = `<html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word'><head><meta charset='utf-8'><title>${blogState.topic}</title><style>body{font-family:'Times New Roman',serif;font-size:12pt;line-height:1.5}h1,h2,h3{color:#2e74b5}</style></head><body>${marked.parse(blogState.content)}</body></html>`;
    const blob = new Blob(['\ufeff', html], { type: 'application/msword' });
    const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `${blogState.topic.replace(/[^a-z0-9]/gi, '_').substring(0, 50) || 'blog_post'}.doc`;
    document.body.appendChild(link); link.click(); document.body.removeChild(link);
  };

  const resetBlog = () => setBlogState({ topic: '', keywords: '', referenceContent: '', outline: '', content: '', refineInstruction: '', status: BlogStatus.IDLE });
  const handleTextFileUpload = async (e: React.ChangeEvent<HTMLInputElement>, field: 'referenceContent' | 'outline') => {
    const file = e.target.files?.[0]; if (!file) return;
    try { const text = await file.text(); setBlogState(prev => ({ ...prev, [field]: text })); } catch { alert("Failed to read file"); }
    e.target.value = '';
  };

  const theme = {
    bg: isDarkMode ? 'bg-slate-950' : 'bg-gray-50', text: isDarkMode ? 'text-slate-200' : 'text-slate-700',
    cardBg: isDarkMode ? 'bg-slate-900' : 'bg-white', cardBorder: isDarkMode ? 'border-slate-800' : 'border-gray-200',
    subText: isDarkMode ? 'text-slate-500' : 'text-gray-500', heading: isDarkMode ? 'text-white' : 'text-gray-900',
    inputBg: isDarkMode ? 'bg-slate-950' : 'bg-gray-50', inputBorder: isDarkMode ? 'border-slate-700' : 'border-gray-300',
  };

  const fullFilename = activeImage?.seoData?.filename || 'image.webp';
  const extIndex = fullFilename.lastIndexOf('.'); const ext = extIndex !== -1 ? fullFilename.substring(extIndex) : '.webp';
  const namePart = extIndex !== -1 ? fullFilename.substring(0, extIndex) : fullFilename;
  const compressionRate = activeImage?.processedSize && activeImage.originalSize ? ((1 - activeImage.processedSize / activeImage.originalSize) * 100).toFixed(1) : '0';
  const estimatedSize = activeImage ? estimateProcessedSize(activeImage) : null;
  const hasApiKeyConfigured = Boolean(getApiKey());

  const showBlogContent = [BlogStatus.GENERATING_POST, BlogStatus.COMPLETED, BlogStatus.REFINING, BlogStatus.GENERATING_SEO].includes(blogState.status);
  const canWritePost = blogState.status === BlogStatus.OUTLINE_READY || (blogState.outline.trim() && ![BlogStatus.GENERATING_POST, BlogStatus.REFINING, BlogStatus.COMPLETED, BlogStatus.GENERATING_SEO].includes(blogState.status));
  const imageBusyStatus = activeImage?.status;
  const isImageBusy = Boolean(isProcessing || isUploading || imageBusyStatus === ProcessingStatus.PROCESSING || imageBusyStatus === ProcessingStatus.GENERATING_SEO);
  const imageBusyText = isUploading || imageBusyStatus === ProcessingStatus.UPLOADING
    ? '正在上传到WordPress...'
    : imageBusyStatus === ProcessingStatus.PROCESSING
      ? '正在重新压缩图片...'
      : imageBusyStatus === ProcessingStatus.GENERATING_SEO
        ? '正在生成SEO信息...'
        : '处理中...';

  return (
    <div className={`flex flex-col h-screen ${viewMode === 'mediaOps' ? 'overflow-auto' : 'overflow-hidden'} ${theme.bg} ${theme.text} transition-colors duration-500 font-sans relative`} onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop}>
      {isImageBusy && (
        <div className="fixed inset-0 z-[120] bg-black/35 backdrop-blur-[1px] flex items-center justify-center">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-2xl px-6 py-5 shadow-xl min-w-[280px] flex items-center gap-4">
            <div className="w-7 h-7 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin" />
            <div>
              <div className={`text-sm font-semibold ${theme.heading}`}>加载中</div>
              <div className={`text-xs mt-1 ${theme.subText}`}>{imageBusyText}</div>
            </div>
          </div>
        </div>
      )}

      {isDraggingOver && (
        <div className="absolute inset-0 z-[100] flex items-center justify-center bg-blue-600/20 backdrop-blur-sm border-4 border-dashed border-blue-500 pointer-events-none">
          <div className="bg-white dark:bg-slate-800 p-8 rounded-2xl shadow-2xl flex flex-col items-center gap-4">
            <div className="w-16 h-16 bg-blue-100 dark:bg-blue-900 rounded-full flex items-center justify-center text-blue-600 dark:text-blue-300"><IconUpload /></div>
            <div className="text-xl font-bold dark:text-white">松开上传图片</div>
          </div>
        </div>
      )}

      {/* Header */}
      <div className={`h-16 border-b ${theme.cardBorder} ${theme.cardBg} flex items-center justify-between px-6 shrink-0 z-10`}>
        <div className="flex items-center gap-2">
          <div className="bg-blue-600 p-1.5 rounded-lg text-white">
            {viewMode === 'image' ? <IconUpload /> : viewMode === 'blog' ? <IconDocumentText /> : <IconCloudUpload />}
          </div>
          <span className={`font-bold text-lg ${theme.heading}`}>LensCraft AI</span>
        </div>
        <div className="flex items-center gap-4 text-sm">
          <div className={`text-xs px-2 py-1 rounded-full border ${hasApiKeyConfigured ? 'border-green-300 text-green-600 dark:border-green-600 dark:text-green-300' : 'border-amber-300 text-amber-700 dark:border-amber-600 dark:text-amber-300'}`}>
            {hasApiKeyConfigured ? 'Gemini 已连接' : 'Gemini 未连接'}
          </div>
          <button onClick={() => setShowSettings(true)} className={`p-2 rounded-full hover:bg-black/5 dark:hover:bg-white/10 ${theme.subText}`} title="设置"><IconSettings /></button>
          <button onClick={() => setIsDarkMode(!isDarkMode)} className={`p-2 rounded-full hover:bg-black/5 dark:hover:bg-white/10 ${theme.subText}`}>{isDarkMode ? <IconSun /> : <IconMoon />}</button>
        </div>
      </div>

      {/* Mode Toggle */}
      <div className={`border-b ${theme.cardBorder} ${theme.cardBg} px-6 py-2 flex justify-center shrink-0 z-10`}>
        <div className={`flex p-1 rounded-lg ${isDarkMode ? 'bg-slate-800' : 'bg-slate-100'}`}>
          {(['image', 'blog', 'mediaOps', 'productSeo'] as const).map(mode => (
            <button key={mode} onClick={() => setViewMode(mode)} className={`px-4 py-1.5 rounded-md text-sm font-medium transition-all flex items-center gap-2 ${viewMode === mode ? 'bg-white dark:bg-slate-600 shadow-sm text-blue-600 dark:text-blue-200' : 'text-slate-500 dark:text-slate-400'}`}>
              {mode === 'image' ? <><IconPhoto /> 图片处理</> : mode === 'blog' ? <><IconDocumentText /> 博客写作</> : mode === 'mediaOps' ? <><IconCloudUpload /> 媒体库SEO压缩</> : <><IconRefresh /> WooCommerce产品SEO</>}
            </button>
          ))}
        </div>
      </div>

      {imageNotice && (
        <div className={`shrink-0 px-6 py-2 border-b ${theme.cardBorder} ${theme.cardBg} z-20`}>
          <div className="max-w-6xl mx-auto bg-amber-50 dark:bg-amber-900/20 border border-amber-300 dark:border-amber-700 text-amber-800 dark:text-amber-200 rounded-lg px-3 py-2 text-sm flex items-center justify-between">
            <span>{imageNotice}</span>
            <button onClick={() => setImageNotice(null)} className="ml-2 text-amber-500 hover:text-amber-600"><IconX className="w-4 h-4" /></button>
          </div>
        </div>
      )}

      <div className={`flex-1 flex ${viewMode === 'mediaOps' ? '' : 'overflow-hidden'}`}>
        {viewMode === 'image' && (
          <div className="flex-1 overflow-y-auto p-4 md:p-8 flex justify-center">
            {!activeImage ? (
              <div className="flex flex-col items-center justify-center h-full opacity-50 space-y-6">
                <div className="bg-slate-200 dark:bg-slate-800 w-32 h-32 rounded-full flex items-center justify-center border-4 border-dashed border-slate-300 dark:border-slate-700"><IconUpload /></div>
                <div className="text-center">
                  <label className="cursor-pointer bg-blue-600 hover:bg-blue-500 text-white px-8 py-3 rounded-xl font-bold shadow-lg inline-block">
                    <input type="file" multiple accept="image/*" onChange={handleFileUpload} className="hidden" />上传图片
                  </label>
                  <p className={`mt-4 ${theme.subText}`}>或者直接将图片拖拽到这里</p>
                </div>
              </div>
            ) : (
              <div className="w-full max-w-6xl grid grid-cols-1 lg:grid-cols-2 gap-6 h-fit">
                {/* Image Preview */}
                <div className={`rounded-2xl overflow-hidden shadow-sm border ${theme.cardBorder} ${theme.cardBg} p-2 flex flex-col`}>
                  <div className="relative flex-1 min-h-[400px] bg-checkerboard rounded-xl overflow-hidden">
                    {activeImage.processedUrl ? <ComparisonSlider beforeImage={activeImage.previewUrl} afterImage={activeImage.processedUrl} beforeLabel="Original" afterLabel="WebP" /> : <img src={activeImage.previewUrl} className="w-full h-full object-contain absolute inset-0" alt="Preview" />}
                  </div>
                  <div className="mt-2 h-20 flex gap-2 overflow-x-auto pb-1 px-1">
                    {images.map(img => (
                      <div key={img.id} onClick={() => setActiveId(img.id)} className={`relative w-20 h-full shrink-0 rounded-lg border-2 cursor-pointer group ${activeId === img.id ? 'border-blue-500 opacity-100' : `${theme.cardBorder} opacity-60 hover:opacity-80`}`}>
                        <img src={img.processedUrl || img.previewUrl} className="w-full h-full object-cover rounded-md" />
                        <button onClick={(e) => deleteImage(img.id, e)} className="absolute -top-1 -right-1 bg-red-500 text-white rounded-full p-0.5 opacity-0 group-hover:opacity-100 z-10"><IconX /></button>
                      </div>
                    ))}
                    <label className={`w-20 h-full shrink-0 rounded-lg border-2 border-dashed ${theme.cardBorder} flex items-center justify-center cursor-pointer hover:bg-black/5 dark:hover:bg-white/5`}>
                      <input type="file" multiple accept="image/*" onChange={handleFileUpload} className="hidden" /><IconPlus />
                    </label>
                  </div>
                </div>

                {/* Settings & Results */}
                <div className="space-y-6">
                  {activeImage.processedUrl && (
                    <div className={`rounded-2xl shadow-sm border ${theme.cardBorder} ${theme.cardBg} p-6`}>
                      <div className="text-center mb-6"><div className="text-5xl font-bold text-green-500">{compressionRate}%</div><div className={`text-sm mt-1 ${theme.subText}`}>压缩率</div></div>
                      <div className="grid grid-cols-2 gap-8 border-t border-dashed border-gray-200 dark:border-slate-800 pt-6">
                        <div><div className={`text-xs ${theme.subText} mb-1`}>原图</div><div className={`text-lg font-semibold ${theme.heading}`}>{formatBytes(activeImage.originalSize || 0)}</div></div>
                        <div className="text-right"><div className={`text-xs ${theme.subText} mb-1`}>处理后</div><div className="text-lg font-semibold text-green-500">{formatBytes(activeImage.processedSize || 0)}</div></div>
                      </div>
                    </div>
                  )}

                  <div className={`rounded-2xl shadow-sm border ${theme.cardBorder} ${theme.cardBg} p-6`}>
                    <h3 className={`font-bold mb-4 ${theme.heading}`}>处理配置</h3>
                    <div className="space-y-4">
                      <div>
                        <label className={`block text-xs font-medium uppercase tracking-wider mb-2 ${theme.subText}`}>SEO 词库 (可选)</label>
                        <input type="file" accept=".xlsx,.xls,.csv" onChange={(e) => handleExcelUpload(e, 'image')} className="hidden" id="img-keyword-upload" />
                        <label htmlFor="img-keyword-upload" className={`w-full ${theme.inputBg} border ${theme.inputBorder} border-dashed rounded-lg px-3 py-3 flex items-center justify-between cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-800 ${theme.heading}`}>
                          <div className="flex items-center gap-2"><IconTable /><span className="text-sm truncate max-w-[200px]">{imageKeywordFileName || "上传 Excel 关键词库"}</span></div>
                          {imageKeywordContext ? <span className="text-xs text-green-500 font-medium flex items-center gap-1"><IconCheck /> 已加载</span> : <span className="text-xs text-blue-500 font-medium">选择文件</span>}
                        </label>
                      </div>
                      <div>
                        <label className={`block text-xs font-medium uppercase tracking-wider mb-2 ${theme.subText}`}>主关键词 <span className="text-red-500">*</span></label>
                        <input type="text" value={activeImage.mainKeyword} onChange={(e) => updateActiveImage({ mainKeyword: e.target.value })} className={`w-full ${theme.inputBg} border ${theme.inputBorder} rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-blue-500 ${theme.heading}`} placeholder="例如：不锈钢工厂" />
                      </div>
                      <div>
                        <label className={`block text-xs font-medium uppercase tracking-wider mb-2 ${theme.subText}`}>额外描述 (可选)</label>
                        <textarea value={activeImage.extraDesc} onChange={(e) => updateActiveImage({ extraDesc: e.target.value })} rows={3} className={`w-full ${theme.inputBg} border ${theme.inputBorder} rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-blue-500 resize-none ${theme.heading}`} placeholder="补充更多上下文信息..." />
                      </div>
                      <div>
                        <label className={`block text-xs font-medium uppercase tracking-wider mb-2 ${theme.subText}`}>输出宽度</label>
                        <div className="grid grid-cols-2 gap-2">
                          {TARGET_WIDTH_OPTIONS.map(opt => (
                            <button key={opt.value} onClick={() => updateActiveImage({ targetWidth: opt.value })} className={`py-2.5 px-2 rounded-lg border flex flex-col items-center gap-1 ${activeImage.targetWidth === opt.value ? 'bg-slate-800 text-white border-slate-800' : `${theme.inputBg} ${theme.inputBorder} hover:border-slate-400`}`}>
                              <div className="text-sm font-semibold">{opt.label}</div>
                              <div className={`text-[10px] ${activeImage.targetWidth === opt.value ? 'text-white/80' : theme.subText}`}>{opt.hint}</div>
                            </button>
                          ))}
                        </div>
                      </div>
                      <div>
                        <div className="flex items-center justify-between mb-2">
                          <label className={`text-xs font-medium uppercase tracking-wider ${theme.subText}`}>压缩质量</label>
                          <span className={`text-xs ${theme.subText}`}>{Math.round(activeImage.quality * 100)}%</span>
                        </div>
                        <input type="range" min="0.3" max="0.95" step="0.05" value={activeImage.quality} onChange={(e) => updateActiveImage({ quality: Number(e.target.value) })} className="w-full" />
                        {estimatedSize !== null && (
                          <div className={`text-xs mt-2 ${theme.subText}`}>
                            预估处理后大小: <span className={theme.heading}>{formatBytes(estimatedSize)}</span>
                          </div>
                        )}
                      </div>
                      <button onClick={processQueue} disabled={isProcessing || isUploading} className="w-full bg-slate-900 hover:bg-black text-white py-3 rounded-lg font-bold shadow-lg mt-4 disabled:opacity-50 flex justify-center items-center gap-2">
                        {isProcessing ? '处理中...' : (activeImage.processedUrl ? '重新处理' : '开始处理')}
                      </button>
                    </div>
                  </div>

                  {activeImage.processedUrl && (
                    <div className="grid grid-cols-2 gap-3">
                      <a href={activeImage.processedUrl} download={fullFilename} className={`flex items-center justify-center gap-2 py-3 rounded-xl font-medium border ${theme.cardBorder} ${theme.cardBg} ${theme.heading} hover:bg-slate-50 dark:hover:bg-slate-800`}><IconDownload /> 下载</a>
                      <button onClick={handleManualWPUpload} disabled={!activeImage.processedBlob || isProcessing || isUploading} className={`flex items-center justify-center gap-2 py-3 rounded-xl font-medium border ${theme.cardBorder} ${theme.cardBg} ${theme.heading} hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50`}><IconCloudUpload /> 上传至 WP</button>
                    </div>
                  )}

                  {activeImage.seoData && (
                    <div className={`rounded-2xl shadow-sm border ${theme.cardBorder} ${theme.cardBg} p-6`}>
                      <div className="flex items-center justify-between mb-4 gap-3">
                        <h4 className={`font-bold ${theme.heading}`}>SEO 信息</h4>
                        <button
                          onClick={regenerateActiveSeo}
                          disabled={!activeImage.processedBlob || isProcessing || isUploading || activeImage.status === ProcessingStatus.GENERATING_SEO}
                          className="text-xs bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 rounded-lg disabled:opacity-50 whitespace-nowrap"
                        >
                          {activeImage.status === ProcessingStatus.GENERATING_SEO ? '生成中...' : '用 Gemini 重写'}
                        </button>
                      </div>
                      <div className="space-y-4">
                        {(['title', 'alt', 'caption', 'description'] as const).map(field => {
                          const limits = { title: 60, alt: 125, caption: 100, description: 160 };
                          const value = activeImage.seoData![field] || '';
                          const isOver = value.length > limits[field];
                          return (
                            <div key={field}>
                              <div className="flex justify-between items-center mb-1">
                                <label className={`text-xs font-medium ${theme.subText}`}>{field.charAt(0).toUpperCase() + field.slice(1)}</label>
                                <div className="flex items-center gap-2">
                                  <span className={`text-[10px] ${isOver ? 'text-red-500 font-bold' : 'text-slate-400'}`}>{value.length} / {limits[field]}</span>
                                  <CopyButton text={value} />
                                </div>
                              </div>
                              {field === 'title' ? (
                                <input type="text" value={value} onChange={(e) => updateActiveImage({ seoData: { ...activeImage.seoData!, [field]: e.target.value } })} className={`w-full ${theme.inputBg} border ${isOver ? 'border-red-500 focus:ring-red-500' : theme.inputBorder} rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-blue-500 text-sm ${theme.heading}`} />
                              ) : (
                                <textarea value={value} onChange={(e) => updateActiveImage({ seoData: { ...activeImage.seoData!, [field]: e.target.value } })} rows={field === 'description' ? 3 : 2} className={`w-full ${theme.inputBg} border ${isOver ? 'border-red-500 focus:ring-red-500' : theme.inputBorder} rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-blue-500 text-sm ${theme.heading}`} />
                              )}
                            </div>
                          );
                        })}
                        <div className="pt-2">
                          <div className="flex justify-between items-center mb-1">
                            <label className={`text-xs font-medium ${theme.subText}`}>Filename</label>
                            <CopyButton text={fullFilename} />
                          </div>
                          <div className="flex items-center">
                            <input type="text" value={namePart} onChange={(e) => updateActiveImage({ seoData: { ...activeImage.seoData!, filename: e.target.value + ext } })} className={`flex-1 ${theme.inputBg} border border-r-0 ${theme.inputBorder} rounded-l-lg px-3 py-2 outline-none text-sm ${theme.heading} focus:ring-1 focus:ring-blue-500`} />
                            <div className={`px-3 py-2 bg-slate-100 dark:bg-slate-800 border ${theme.inputBorder} rounded-r-lg text-sm text-slate-500`}>{ext}</div>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  {activeImage.wpData && (
                    <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-xl p-4 flex items-center justify-between">
                      <div className="flex items-center gap-3"><IconCheck className="w-5 h-5 text-green-500" /><div className="font-medium text-green-800 dark:text-green-300">已上传至 WP</div></div>
                      <a href={`${settings.wpUrl}/wp-admin/post.php?post=${activeImage.wpData.id}&action=edit`} target="_blank" className="text-sm font-medium text-green-700 dark:text-green-300 hover:underline">编辑 &rarr;</a>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {viewMode === 'blog' && (
          <div className="flex-1 overflow-y-auto p-4 md:p-8 flex justify-center">
            <div className="w-full max-w-6xl h-fit">
              {/* Step 1: Topic & Outline */}
              <div className={`rounded-2xl shadow-sm border ${theme.cardBorder} ${theme.cardBg} p-6 mb-6`}>
                <h3 className={`font-bold mb-4 flex items-center gap-2 ${theme.heading}`}>
                  <span className="bg-purple-100 dark:bg-purple-900 text-purple-600 dark:text-purple-300 w-6 h-6 rounded-full flex items-center justify-center text-xs">1</span>
                  第一步：主题、参考与大纲
                </h3>
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                  <div className="space-y-4">
                    <div>
                      <label className={`block text-xs font-medium uppercase tracking-wider mb-2 ${theme.subText}`}>博客主题 <span className="text-red-500">*</span></label>
                      <input type="text" value={blogState.topic} onChange={(e) => setBlogState({ ...blogState, topic: e.target.value })} placeholder="例如: 2024年工业不锈钢市场趋势分析" disabled={blogState.status === BlogStatus.GENERATING_OUTLINE} className={`w-full ${theme.inputBg} border ${theme.inputBorder} rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-purple-500 ${theme.heading}`} />
                    </div>
                    <div>
                      <label className={`block text-xs font-medium uppercase tracking-wider mb-2 ${theme.subText}`}>关键词库 (Excel)</label>
                      <input type="file" accept=".xlsx,.xls,.csv" onChange={(e) => handleExcelUpload(e, 'blog')} className="hidden" id="keyword-upload" disabled={blogState.status === BlogStatus.GENERATING_OUTLINE} />
                      <label htmlFor="keyword-upload" className={`w-full ${theme.inputBg} border ${theme.inputBorder} border-dashed rounded-lg px-3 py-3 flex items-center justify-between cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-800 ${theme.heading}`}>
                        <div className="flex items-center gap-2"><IconTable /><span className="text-sm truncate max-w-[200px]">{blogState.keywordFileName || "上传 Excel 文件"}</span></div>
                        {blogState.keywordContext ? <span className="text-xs text-green-500 font-medium flex items-center gap-1"><IconCheck /> 已加载</span> : <span className="text-xs text-blue-500 font-medium">选择文件</span>}
                      </label>
                    </div>
                    <div>
                      <label className={`block text-xs font-medium uppercase tracking-wider mb-2 ${theme.subText}`}>手动关键词</label>
                      <textarea value={blogState.keywords} onChange={(e) => setBlogState({ ...blogState, keywords: e.target.value })} placeholder="关键词：环保、价格波动..." rows={2} className={`w-full ${theme.inputBg} border ${theme.inputBorder} rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-purple-500 resize-none ${theme.heading}`} />
                    </div>
                    <div>
                      <div className="flex justify-between items-center mb-2">
                        <label className={`text-xs font-medium uppercase tracking-wider ${theme.subText}`}>参考素材</label>
                        <label className="cursor-pointer text-xs flex items-center gap-1 text-blue-500 hover:text-blue-400">
                          <input type="file" accept=".txt,.md" className="hidden" onChange={(e) => handleTextFileUpload(e, 'referenceContent')} /><IconImport /> 导入文件
                        </label>
                      </div>
                      <textarea value={blogState.referenceContent} onChange={(e) => setBlogState({ ...blogState, referenceContent: e.target.value })} placeholder="粘贴类似文章或背景资料..." rows={6} className={`w-full ${theme.inputBg} border ${theme.inputBorder} rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-purple-500 resize-none text-xs leading-relaxed ${theme.heading}`} />
                    </div>
                    <button onClick={() => handleBlogAction('outline')} disabled={blogState.status === BlogStatus.GENERATING_OUTLINE} className="bg-purple-600 hover:bg-purple-500 text-white font-medium py-3 px-6 rounded-lg w-full disabled:opacity-50 shadow-sm">
                      {blogState.status === BlogStatus.GENERATING_OUTLINE ? '正在生成大纲...' : '生成大纲'}
                    </button>
                  </div>
                  <div className={`border-t lg:border-t-0 lg:border-l ${theme.cardBorder} pt-6 lg:pt-0 lg:pl-8 flex flex-col h-full`}>
                    <div className="flex justify-between items-center mb-2">
                      <label className={`text-xs font-medium uppercase tracking-wider ${theme.subText}`}>编辑大纲</label>
                      <label className="cursor-pointer text-xs flex items-center gap-1 text-blue-500 hover:text-blue-400">
                        <input type="file" accept=".txt,.md" className="hidden" onChange={(e) => handleTextFileUpload(e, 'outline')} /><IconImport /> 导入大纲
                      </label>
                    </div>
                    <textarea value={blogState.outline} onChange={(e) => setBlogState({ ...blogState, outline: e.target.value })} placeholder="您可以手动输入大纲，或点击左侧按钮生成..." className={`flex-1 min-h-[300px] w-full ${theme.inputBg} border ${theme.inputBorder} rounded-lg px-4 py-3 outline-none focus:ring-2 focus:ring-purple-500 resize-none font-mono text-sm leading-relaxed ${theme.heading}`} />
                    {canWritePost && (
                      <div className="mt-4 flex justify-end">
                        <button onClick={() => handleBlogAction('post')} disabled={blogState.status === BlogStatus.GENERATING_POST} className="bg-green-600 hover:bg-green-500 text-white font-bold py-3 px-8 rounded-lg shadow-lg disabled:opacity-50">
                          {blogState.status === BlogStatus.GENERATING_POST ? 'AI 正在撰写...' : '批准并撰写全文'}
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Step 2: Content & Refinement */}
              {showBlogContent && (
                <div className={`rounded-2xl shadow-sm border ${theme.cardBorder} ${theme.cardBg} p-6 mb-12`}>
                  <h3 className={`font-bold mb-4 flex items-center gap-2 ${theme.heading}`}>
                    <span className="bg-green-100 dark:bg-green-900 text-green-600 dark:text-green-300 w-6 h-6 rounded-full flex items-center justify-center text-xs">2</span>
                    博客正文与润色
                  </h3>
                  {blogState.status === BlogStatus.GENERATING_POST ? (
                    <div className="flex flex-col items-center justify-center py-20 text-center space-y-4">
                      <div className="w-12 h-12 border-4 border-purple-200 border-t-purple-600 rounded-full animate-spin" />
                      <p className={theme.subText}>AI 正在撰写...</p>
                    </div>
                  ) : (
                    <div className="space-y-4">
                      <div className="relative group">
                        <textarea value={blogState.content} onChange={(e) => setBlogState({ ...blogState, content: e.target.value })} className={`w-full min-h-[600px] ${theme.inputBg} border ${theme.inputBorder} rounded-xl p-6 outline-none focus:ring-2 focus:ring-green-500 font-sans text-sm leading-7 resize-y ${theme.heading}`} />
                        <div className="absolute top-4 right-4 flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button onClick={handleExportWord} className="bg-blue-600 hover:bg-blue-500 text-white px-2 py-1 rounded text-xs flex items-center gap-1 shadow-sm"><IconWord /> Download Word</button>
                          <CopyButton text={blogState.content} label="Copy" className="bg-black/50 hover:bg-black/70 text-white px-2 py-1 rounded shadow-sm" />
                        </div>
                      </div>
                      <div className={`flex flex-col md:flex-row gap-4 p-4 rounded-xl border border-dashed ${theme.cardBorder} bg-slate-50 dark:bg-slate-800/50`}>
                        <div className="flex-1">
                          <label className={`block text-xs font-bold uppercase tracking-wider mb-2 ${theme.subText} flex items-center gap-1`}><IconSparkles /> AI 润色</label>
                          <div className="flex gap-2">
                            <input type="text" value={blogState.refineInstruction} onChange={(e) => setBlogState({ ...blogState, refineInstruction: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && handleBlogAction('refine')} placeholder="例如：让语气更专业一点..." disabled={blogState.status === BlogStatus.REFINING} className={`flex-1 ${theme.inputBg} border ${theme.inputBorder} rounded-lg px-4 py-2 outline-none focus:ring-2 focus:ring-blue-500 text-sm ${theme.heading}`} />
                            <button onClick={() => handleBlogAction('refine')} disabled={blogState.status === BlogStatus.REFINING || !blogState.refineInstruction.trim()} className="bg-blue-600 hover:bg-blue-500 text-white font-medium px-6 py-2 rounded-lg disabled:opacity-50 whitespace-nowrap">
                              {blogState.status === BlogStatus.REFINING ? '润色中...' : '提交修改'}
                            </button>
                          </div>
                        </div>
                        <div className="flex items-end">
                          <button onClick={resetBlog} className={`px-4 py-2 rounded-lg border ${theme.cardBorder} ${theme.heading} hover:bg-slate-200 dark:hover:bg-slate-700 text-sm`}>重新开始</button>
                        </div>
                      </div>
                      <div className={`mt-8 rounded-xl border ${theme.cardBorder} ${theme.cardBg} p-6`}>
                        <div className="flex justify-between items-center mb-4">
                          <h3 className={`font-bold flex items-center gap-2 ${theme.heading}`}><IconDocumentText /> 博客 SEO 元数据</h3>
                          <button onClick={() => handleBlogAction('seo')} disabled={blogState.status === BlogStatus.GENERATING_SEO} className="text-sm bg-purple-600 hover:bg-purple-500 text-white px-4 py-2 rounded-lg disabled:opacity-50">
                            {blogState.status === BlogStatus.GENERATING_SEO ? '生成中...' : '生成 SEO 信息'}
                          </button>
                        </div>
                        {blogState.seo ? (
                          <div className="space-y-4">
                            <div>
                              <div className="flex justify-between items-center mb-1">
                                <label className={`text-xs font-medium ${theme.subText}`}>SEO Title (Max 60)</label>
                                <div className={`text-xs ${blogState.seo.seoTitle.length > 60 ? 'text-red-500' : 'text-slate-400'}`}>{blogState.seo.seoTitle.length}/60</div>
                              </div>
                              <input type="text" value={blogState.seo.seoTitle} onChange={(e) => setBlogState({ ...blogState, seo: { ...blogState.seo!, seoTitle: e.target.value } })} className={`w-full ${theme.inputBg} border ${theme.inputBorder} rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-purple-500 text-sm ${theme.heading}`} />
                            </div>
                            <div>
                              <div className="flex justify-between items-center mb-1">
                                <label className={`text-xs font-medium ${theme.subText}`}>Meta Description (Max 160)</label>
                                <div className={`text-xs ${blogState.seo.seoDescription.length > 160 ? 'text-red-500' : 'text-slate-400'}`}>{blogState.seo.seoDescription.length}/160</div>
                              </div>
                              <textarea value={blogState.seo.seoDescription} onChange={(e) => setBlogState({ ...blogState, seo: { ...blogState.seo!, seoDescription: e.target.value } })} rows={3} className={`w-full ${theme.inputBg} border ${theme.inputBorder} rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-purple-500 text-sm ${theme.heading}`} />
                            </div>
                          </div>
                        ) : (
                          <div className={`text-center py-6 border-2 border-dashed ${theme.inputBorder} rounded-lg ${theme.subText}`}>点击上方按钮生成 SEO 标题和描述</div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {blogState.errorMessage && (
                <div className="bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 p-4 rounded-lg border border-red-200 dark:border-red-800 mb-6">
                  <div className="font-bold mb-1">Error:</div>{blogState.errorMessage}
                </div>
              )}
            </div>
          </div>
        )}

        {viewMode === 'mediaOps' && (
          <div className="flex-1 p-4 md:p-8 flex justify-center">
            <MediaOpsDashboard
              theme={theme}
              settings={settings}
              getApiKey={getApiKey}
              requireApiKey={requireApiKey}
              onNotice={setImageNotice}
            />
          </div>
        )}

        {viewMode === 'productSeo' && (
          <div className="flex-1 p-4 md:p-8 flex justify-center overflow-auto">
            <ProductSeoDashboard
              theme={theme}
              getApiKey={getApiKey}
              requireApiKey={requireApiKey}
              onNotice={setImageNotice}
            />
          </div>
        )}
      </div>

      <SettingsModal
        isOpen={showSettings}
        onClose={() => setShowSettings(false)}
        settings={settings}
        onSave={handleSaveSettings}
        theme={theme}
      />
    </div>
  );
};

export default App;
