import React, { useState, useEffect, useCallback } from 'react';
import {
    IconRefresh, IconDocumentText, IconSparkles, IconCloudUpload, IconCheck, IconX, IconPhoto
} from './Icons';

interface ProductItem {
    id: number;
    name: string;
    slug: string;
    permalink: string;
    status: string;
    short_description: string;
    description: string;
    description_alt_texts?: string;
    error_reason?: string | null;
    updated_at: string;
}

// Parse alt_texts JSON string from DB
const parseAltTexts = (raw?: string): Record<string, string> => {
    if (!raw) return {};
    try { return JSON.parse(raw); } catch { return {}; }
};

const ALT_TEXT_LABELS: Record<string, string> = {
    design_concept: 'Design Concept',
    materials_craftsmanship: 'Materials & Craftsmanship',
    functionality_user_experience: 'Functionality & User Experience',
    installation_options: 'Installation Options',
    applications: 'Applications',
    technical_specifications: 'Technical Specifications',
    about_manufacturer: 'About the Manufacturer',
};

interface ProductReviewItem {
    id: number;
    product_id: number;
    short_description: string;
    description: string;
    acf_seo_extra_info: string;
    aioseo_title: string;
    aioseo_description: string;
    generator: string;
    review_status: string;
    product_name: string;
    product_permalink: string;
}

// Strip HTML tags for preview
const stripHtml = (html: string) => html?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || '';

export const ProductSeoDashboard: React.FC<{
    theme: any;
    getApiKey: () => string;
    requireApiKey: (cb: () => void) => void;
    onNotice: (msg: string | null) => void;
}> = ({ theme, getApiKey, requireApiKey, onNotice }) => {
    const [products, setProducts] = useState<ProductItem[]>([]);
    const [totalProducts, setTotalProducts] = useState(0);
    const [page, setPage] = useState(1);
    const [limit, setLimit] = useState(20);
    const [selectedIds, setSelectedIds] = useState<number[]>([]);
    const [expandedId, setExpandedId] = useState<number | null>(null);
    const [reviewItems, setReviewItems] = useState<ProductReviewItem[]>([]);
    const [selectedReviewIds, setSelectedReviewIds] = useState<number[]>([]);
    const [showReview, setShowReview] = useState(false);
    const [isRunning, setIsRunning] = useState(false);
    const [template, setTemplate] = useState('');
    const [showTemplateArea, setShowTemplateArea] = useState(false);
    const [searchInput, setSearchInput] = useState('');
    const [searchQuery, setSearchQuery] = useState('');
    const [isLoadingList, setIsLoadingList] = useState(false);
    const [editingAltTexts, setEditingAltTexts] = useState<Record<number, Record<string, string>>>({});
    const [savingAltTexts, setSavingAltTexts] = useState<number | null>(null);
    const [refImages, setRefImages] = useState<Record<number, { filename: string; category: string; url: string }[]>>({});
    const [uploadingImages, setUploadingImages] = useState<number | null>(null);

    const fetchProducts = useCallback(async () => {
        setIsLoadingList(true);
        try {
            const params = new URLSearchParams({
                page: String(page),
                limit: String(limit),
            });
            if (searchQuery.trim()) {
                params.set('q', searchQuery.trim());
            }
            const res = await fetch(`/api/products?${params.toString()}`);
            if (res.ok) {
                const data = await res.json();
                setProducts(data.items || []);
                setTotalProducts(data.total || 0);
            }
        } catch (e) {
            console.error('Failed to fetch products', e);
        } finally {
            setIsLoadingList(false);
        }
    }, [page, limit, searchQuery]);

    const fetchReviewItems = useCallback(async () => {
        try {
            const res = await fetch('/api/product-review?status=pending');
            if (res.ok) setReviewItems(await res.json());
        } catch (e) {
            console.error('Failed to fetch product review', e);
        }
    }, []);

    useEffect(() => {
        fetchProducts();
    }, [fetchProducts]);

    // Auto-refresh every 5s
    useEffect(() => {
        const interval = setInterval(fetchProducts, 5000);
        return () => clearInterval(interval);
    }, [fetchProducts]);

    const handleScan = async () => {
        if (isRunning) return;
        try {
            setIsRunning(true);
            onNotice('开始扫描 WooCommerce 产品...');
            await fetch('/api/product-scan');
            setTimeout(() => { fetchProducts(); setIsRunning(false); }, 3000);
        } catch (e: any) {
            onNotice('扫描失败: ' + e.message);
            setIsRunning(false);
        }
    };

    const handleRun = async () => {
        if (selectedIds.length === 0) return onNotice('请先选择要生成 SEO 的产品');

        requireApiKey(async () => {
            try {
                setIsRunning(true);
                onNotice(`开始为 ${selectedIds.length} 个产品生成 SEO（DOCX 图文布局）...`);
                const res = await fetch('/api/products/generate-batch', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        ids: selectedIds,
                        fields: ['short_description', 'description', 'acf_seo_extra_info', 'aioseo_title', 'aioseo_description'],
                        language: 'en',
                        short_template: template.trim(),
                        full_template: template.trim(),
                    })
                });
                if (!res.ok) throw new Error(await res.text());
                const data = await res.json();
                setSelectedIds([]);
                fetchProducts();
                onNotice(`生成完成！成功 ${data.updated_products} 个产品，共 ${data.generated_fields} 个字段${data.failed ? `，失败 ${data.failed} 个` : ''}`);
            } catch (e: any) {
                onNotice('生成失败: ' + e.message);
            } finally {
                setIsRunning(false);
            }
        });
    };

    const handleBatchApprove = async (sync: boolean) => {
        const ids = selectedReviewIds.length > 0 ? selectedReviewIds : reviewItems.map(i => i.id);
        if (ids.length === 0) return;
        try {
            if (sync) onNotice('正在同步产品 SEO 到 WordPress...');
            const status = sync ? 'applied' : 'approved';
            const res = await fetch('/api/product-review', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ids, status })
            });
            if (res.ok) {
                onNotice(sync ? '已同步到 WordPress！' : '已批准选中项');
                setSelectedReviewIds([]);
                fetchReviewItems();
            } else {
                throw new Error(await res.text());
            }
        } catch (e: any) {
            onNotice('操作失败: ' + e.message);
        }
    };

    const handleSearch = () => {
        setPage(1);
        setSelectedIds([]);
        setExpandedId(null);
        setSearchQuery(searchInput.trim());
    };

    const handleClearSearch = () => {
        setSearchInput('');
        setSearchQuery('');
        setPage(1);
        setSelectedIds([]);
        setExpandedId(null);
    };

    const handleEditAltText = (productId: number, key: string, value: string) => {
        setEditingAltTexts(prev => ({
            ...prev,
            [productId]: { ...(prev[productId] || {}), [key]: value }
        }));
    };

    const handleSaveAltTexts = async (productId: number) => {
        const edited = editingAltTexts[productId];
        if (!edited) return;
        setSavingAltTexts(productId);
        try {
            const res = await fetch(`/api/products/${productId}/alt-texts`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ alt_texts: edited }),
            });
            if (!res.ok) throw new Error(await res.text());
            onNotice('Alt texts 已保存并重新渲染');
            setEditingAltTexts(prev => { const next = { ...prev }; delete next[productId]; return next; });
            fetchProducts();
        } catch (e: any) {
            onNotice('保存失败: ' + e.message);
        } finally {
            setSavingAltTexts(null);
        }
    };

    const fetchRefImages = async (productId: number) => {
        try {
            const res = await fetch(`/api/products/${productId}/ref-images`);
            if (res.ok) {
                const data = await res.json();
                setRefImages(prev => ({ ...prev, [productId]: data.images || [] }));
            }
        } catch (e) {
            console.error('Failed to fetch ref images', e);
        }
    };

    const handleUploadImages = async (productId: number, files: FileList | File[], category: string = 'product') => {
        if (!files || files.length === 0) return;
        setUploadingImages(productId);
        try {
            const formData = new FormData();
            for (let i = 0; i < files.length; i++) {
                formData.append('files', files[i]);
            }
            formData.append('category', category);
            const res = await fetch(`/api/products/${productId}/ref-images`, {
                method: 'POST',
                body: formData,
            });
            if (!res.ok) throw new Error(await res.text());
            onNotice(`已上传 ${files.length} 张图片`);
            fetchRefImages(productId);
        } catch (e: any) {
            onNotice('上传失败: ' + e.message);
        } finally {
            setUploadingImages(null);
        }
    };

    const handlePasteImages = async (productId: number, e: React.ClipboardEvent, category: string = 'product') => {
        const items = e.clipboardData?.items;
        if (!items) return;
        const imageFiles: File[] = [];
        for (let i = 0; i < items.length; i++) {
            if (items[i].type.startsWith('image/')) {
                const file = items[i].getAsFile();
                if (file) imageFiles.push(file);
            }
        }
        if (imageFiles.length > 0) {
            e.preventDefault();
            await handleUploadImages(productId, imageFiles, category);
        }
    };

    const handleDeleteRefImage = async (productId: number, filename: string) => {
        try {
            await fetch(`/api/products/${productId}/ref-images/${filename}`, { method: 'DELETE' });
            fetchRefImages(productId);
        } catch (e: any) {
            onNotice('删除失败: ' + e.message);
        }
    };

    const updateReviewField = (id: number, field: string, val: string) => {
        setReviewItems(prev => prev.map(item => item.id === id ? { ...item, [field]: val } : item));
    };

    const totalPages = Math.max(1, Math.ceil(totalProducts / limit));

    return (
        <div className="w-full max-w-6xl space-y-6 pb-20">
            {/* Header Card */}
            <div className={`rounded-xl border ${theme.cardBorder} ${theme.cardBg} p-6`}>
                <div className="flex items-center justify-between mb-4">
                    <div>
                        <h2 className={`text-xl font-bold ${theme.heading}`}>WooCommerce 产品 SEO</h2>
                        <div className={`text-sm mt-1 ${theme.subText}`}>
                            批量扫描 WooCommerce 产品、利用 Gemini 自动生成标题、描述及自定义额外字段。
                        </div>
                    </div>
                    <button onClick={() => { fetchProducts(); fetchReviewItems(); }} className={`p-2 rounded-full hover:bg-black/5 dark:hover:bg-white/5 ${theme.subText}`}><IconRefresh /></button>
                </div>

                {/* Stats */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
                    {([
                        [searchQuery ? '搜索结果数' : '总产品数', totalProducts],
                        ['当前页', `${page} / ${totalPages}`],
                        ['已选择', selectedIds.length],
                        ['待审核', reviewItems.length],
                    ] as [string, any][]).map(([k, v]) => (
                        <div key={k} className={`p-3 rounded-lg bg-slate-50 dark:bg-slate-800/50 border ${theme.cardBorder}`}>
                            <div className={`text-xs uppercase tracking-wider ${theme.subText}`}>{k}</div>
                            <div className={`text-lg font-bold mt-1 ${theme.heading}`}>{v}</div>
                        </div>
                    ))}
                </div>

                {/* Toolbar */}
                <div className="flex flex-wrap items-center gap-3 bg-slate-50 dark:bg-slate-900/50 p-4 rounded-lg border border-slate-200 dark:border-slate-700">
                    <button onClick={handleScan} disabled={isRunning} className="bg-slate-800 hover:bg-black text-white text-sm font-bold py-2 px-4 rounded-lg disabled:opacity-50 flex items-center gap-2 shadow-sm">
                        <IconRefresh className="w-4 h-4" /> 扫描产品
                    </button>

                    <div className="flex items-center gap-2">
                        <input
                            type="text"
                            value={searchInput}
                            onChange={e => setSearchInput(e.target.value)}
                            onKeyDown={e => {
                                if (e.key === 'Enter') {
                                    e.preventDefault();
                                    handleSearch();
                                }
                            }}
                            className={`w-64 text-sm ${theme.inputBg} border ${theme.inputBorder} rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-blue-500 ${theme.heading}`}
                            placeholder="按产品名称搜索..."
                        />
                        <button
                            onClick={handleSearch}
                            className="bg-blue-600 hover:bg-blue-500 text-white text-sm font-bold py-2 px-4 rounded-lg shadow-sm"
                        >
                            搜索
                        </button>
                        <button
                            onClick={handleClearSearch}
                            disabled={!searchInput && !searchQuery}
                            className={`text-sm py-2 px-3 rounded-lg border disabled:opacity-50 ${theme.inputBg} ${theme.inputBorder} ${theme.heading}`}
                        >
                            清空
                        </button>
                    </div>

                    <div className="h-8 w-px bg-slate-300 dark:bg-slate-600 mx-1"></div>

                    <button onClick={() => setShowTemplateArea(!showTemplateArea)} className={`text-sm font-medium py-2 px-4 rounded-lg flex items-center gap-2 border ${showTemplateArea ? 'bg-purple-100 border-purple-300 text-purple-700 dark:bg-purple-900/30 dark:border-purple-700 dark:text-purple-300' : `${theme.inputBg} ${theme.inputBorder} ${theme.heading}`}`}>
                        <IconDocumentText className="w-4 h-4" /> {showTemplateArea ? '收起模板' : '展开模板编辑'}
                    </button>

                    <button onClick={handleRun} disabled={isRunning || selectedIds.length === 0} className="bg-purple-600 hover:bg-purple-500 text-white text-sm font-bold py-2 px-5 rounded-lg disabled:opacity-50 flex items-center gap-2 shadow-lg">
                        <IconSparkles className="w-4 h-4" /> AI 批量生成 ({selectedIds.length})
                    </button>

                    <button onClick={() => { fetchReviewItems(); setShowReview(!showReview); }} className="bg-green-600 hover:bg-green-500 text-white text-sm font-bold py-2 px-5 rounded-lg flex items-center gap-2 shadow-lg">
                        <IconCheck className="w-4 h-4" /> 审核并发布
                    </button>
                </div>

                {/* Template Editor */}
                {showTemplateArea && (
                    <div className={`mt-4 p-4 rounded-lg border border-dashed ${theme.cardBorder} bg-slate-50 dark:bg-slate-800/50`}>
                        <label className={`block text-xs font-bold uppercase tracking-wider mb-2 ${theme.subText}`}>AI 提示词模板</label>
                        <textarea
                            value={template}
                            onChange={e => setTemplate(e.target.value)}
                            rows={6}
                            className={`w-full text-sm ${theme.inputBg} border ${theme.inputBorder} rounded-lg px-4 py-3 outline-none focus:ring-2 focus:ring-purple-500 resize-y font-mono leading-relaxed ${theme.heading}`}
                            placeholder={`示例模板：\n\n请根据以下产品名称生成SEO优化的内容：\n- 简短描述（1-2段，突出卖点）\n- 完整描述（HTML格式，包含产品特点、规格、应用场景）\n- ACF Extra Info（附加SEO信息）\n- AIOSEO标题（max 60字符）\n- AIOSEO描述（max 160字符）\n\n请使用英文生成，面向B2B客户。`}
                        />
                    </div>
                )}
            </div>

            {/* Review Panel */}
            {showReview && (
                <div className={`rounded-xl border ${theme.cardBorder} ${theme.cardBg} overflow-hidden`}>
                    <div className={`flex items-center justify-between p-4 border-b ${theme.cardBorder}`}>
                        <div className="flex items-center gap-4">
                            <input
                                type="checkbox"
                                checked={selectedReviewIds.length === reviewItems.length && reviewItems.length > 0}
                                onChange={(e) => setSelectedReviewIds(e.target.checked ? reviewItems.map(i => i.id) : [])}
                                className="w-4 h-4 rounded"
                            />
                            <h3 className={`font-bold ${theme.heading}`}>产品 SEO 审核 ({reviewItems.length} 待审核)</h3>
                        </div>
                        <div className="flex gap-2 items-center">
                            <button onClick={() => handleBatchApprove(true)} className="bg-purple-600 hover:bg-purple-500 text-white text-xs font-bold py-1.5 px-3 rounded flex items-center gap-1">
                                <IconCloudUpload className="w-3 h-3" /> 批准并同步 ({selectedReviewIds.length || reviewItems.length})
                            </button>
                            <button onClick={() => handleBatchApprove(false)} className="bg-green-600 hover:bg-green-500 text-white text-xs font-medium py-1.5 px-3 rounded">
                                仅批准
                            </button>
                            <button onClick={() => setShowReview(false)} className={`p-1 rounded hover:bg-black/5 dark:hover:bg-white/5 ${theme.subText}`}><IconX /></button>
                        </div>
                    </div>
                    <div className="max-h-[60vh] overflow-y-auto divide-y dark:divide-slate-800">
                        {reviewItems.length === 0 ? (
                            <div className={`p-8 text-center ${theme.subText}`}>暂无待审核的产品 SEO 数据。请先运行"AI 批量生成"。</div>
                        ) : reviewItems.map(item => (
                            <div key={item.id} className="p-4 space-y-3">
                                <div className="flex items-start gap-3">
                                    <input type="checkbox" checked={selectedReviewIds.includes(item.id)} onChange={(e) => setSelectedReviewIds(prev => e.target.checked ? [...prev, item.id] : prev.filter(id => id !== item.id))} className="mt-1 w-4 h-4 rounded" />
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2 mb-2">
                                            <span className={`font-bold ${theme.heading}`}>{item.product_name}</span>
                                            <a href={item.product_permalink} target="_blank" className="text-xs text-blue-500 hover:underline">查看 →</a>
                                        </div>
                                        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                                            {/* Left column */}
                                            <div className="space-y-2">
                                                <div>
                                                    <label className={`text-xs font-bold ${theme.subText}`}>AIOSEO Title <span className={`${(item.aioseo_title?.length || 0) > 60 ? 'text-red-500' : 'text-slate-400'}`}>({item.aioseo_title?.length || 0}/60)</span></label>
                                                    <input className={`w-full text-xs mt-1 ${theme.inputBg} border ${theme.inputBorder} rounded px-2 py-1.5 ${theme.heading} outline-none focus:ring-1 focus:ring-purple-500`} value={item.aioseo_title} onChange={e => updateReviewField(item.id, 'aioseo_title', e.target.value)} />
                                                </div>
                                                <div>
                                                    <label className={`text-xs font-bold ${theme.subText}`}>AIOSEO Description <span className={`${(item.aioseo_description?.length || 0) > 160 ? 'text-red-500' : 'text-slate-400'}`}>({item.aioseo_description?.length || 0}/160)</span></label>
                                                    <textarea className={`w-full text-xs mt-1 ${theme.inputBg} border ${theme.inputBorder} rounded px-2 py-1.5 ${theme.heading} outline-none focus:ring-1 focus:ring-purple-500 resize-y`} rows={2} value={item.aioseo_description} onChange={e => updateReviewField(item.id, 'aioseo_description', e.target.value)} />
                                                </div>
                                                <div>
                                                    <label className={`text-xs font-bold ${theme.subText}`}>Short Description</label>
                                                    <textarea className={`w-full text-xs mt-1 ${theme.inputBg} border ${theme.inputBorder} rounded px-2 py-1.5 ${theme.heading} outline-none focus:ring-1 focus:ring-purple-500 resize-y`} rows={3} value={item.short_description} onChange={e => updateReviewField(item.id, 'short_description', e.target.value)} />
                                                </div>
                                            </div>
                                            {/* Right column */}
                                            <div className="space-y-2">
                                                <div>
                                                    <label className={`text-xs font-bold ${theme.subText}`}>Description</label>
                                                    <textarea className={`w-full text-xs mt-1 ${theme.inputBg} border ${theme.inputBorder} rounded px-2 py-1.5 ${theme.heading} outline-none focus:ring-1 focus:ring-purple-500 resize-y font-mono`} rows={5} value={item.description} onChange={e => updateReviewField(item.id, 'description', e.target.value)} />
                                                </div>
                                                <div>
                                                    <label className={`text-xs font-bold ${theme.subText}`}>ACF Extra Info (product_extra_info——seo)</label>
                                                    <textarea className={`w-full text-xs mt-1 ${theme.inputBg} border ${theme.inputBorder} rounded px-2 py-1.5 ${theme.heading} outline-none focus:ring-1 focus:ring-purple-500 resize-y`} rows={3} value={item.acf_seo_extra_info} onChange={e => updateReviewField(item.id, 'acf_seo_extra_info', e.target.value)} />
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* Product List Table */}
            <div className={`rounded-xl border ${theme.cardBorder} ${theme.cardBg} overflow-hidden`}>
                <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                        <thead className="bg-slate-50 dark:bg-slate-800 border-b dark:border-slate-700">
                            <tr>
                                <th className="p-3 w-10"><input type="checkbox" onChange={e => setSelectedIds(e.target.checked ? products.map(p => p.id) : [])} checked={products.length > 0 && selectedIds.length === products.length} /></th>
                                <th className={`p-3 font-medium ${theme.subText}`}>ID</th>
                                <th className={`p-3 font-medium ${theme.subText}`}>产品名称</th>
                                <th className={`p-3 font-medium ${theme.subText}`}>简短描述</th>
                                <th className={`p-3 font-medium ${theme.subText}`}>状态</th>
                                <th className={`p-3 font-medium ${theme.subText}`}>更新时间</th>
                                <th className={`p-3 font-medium ${theme.subText} w-10`}></th>
                            </tr>
                        </thead>
                        <tbody className="divide-y dark:divide-slate-800">
                            {isLoadingList ? (
                                <tr><td colSpan={7} className="p-8 text-center text-slate-400">加载中...</td></tr>
                            ) : products.length === 0 ? (
                                <tr><td colSpan={7} className="p-8 text-center text-slate-400">暂无产品数据，请点击"扫描产品"获取。</td></tr>
                            ) : products.map(p => (
                                <React.Fragment key={p.id}>
                                    <tr className={`hover:bg-slate-50 dark:hover:bg-slate-800/50 cursor-pointer ${selectedIds.includes(p.id) ? 'bg-blue-50 dark:bg-blue-900/10' : ''}`}>
                                        <td className="p-3"><input type="checkbox" checked={selectedIds.includes(p.id)} onChange={e => setSelectedIds(prev => e.target.checked ? [...prev, p.id] : prev.filter(id => id !== p.id))} /></td>
                                        <td className={`p-3 font-mono text-xs ${theme.subText}`}>{p.id}</td>
                                        <td className="p-3">
                                            <div className={`font-medium ${theme.heading}`}>{p.name}</div>
                                            <a href={p.permalink} target="_blank" className="text-xs text-slate-400 hover:underline">{p.slug}</a>
                                        </td>
                                        <td className={`p-3 text-xs max-w-[250px] ${theme.subText}`}>
                                            <div className="truncate" title={stripHtml(p.short_description)}>{stripHtml(p.short_description) || <span className="text-slate-300 italic">无</span>}</div>
                                        </td>
                                        <td className="p-3">
                                            <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${p.status === 'generated' ? 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300' :
                                                    p.status === 'updated' ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300' :
                                                        p.status === 'error' ? 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300' :
                                                            p.status === 'processing' ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300' :
                                                                'bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-300'
                                                }`}>
                                                {p.status}
                                            </span>
                                            {p.error_reason && <div className="text-xs text-red-500 max-w-[200px] truncate mt-1" title={p.error_reason}>{p.error_reason}</div>}
                                        </td>
                                        <td className={`p-3 text-xs ${theme.subText}`}>{new Date(p.updated_at).toLocaleString()}</td>
                                        <td className="p-3">
                                            <button onClick={() => {
                                                const newId = expandedId === p.id ? null : p.id;
                                                setExpandedId(newId);
                                                if (newId !== null && !refImages[newId]) fetchRefImages(newId);
                                            }} className={`text-xs px-2 py-1 rounded border ${theme.cardBorder} ${theme.heading} hover:bg-slate-100 dark:hover:bg-slate-800`}>
                                                {expandedId === p.id ? '收起' : '详情'}
                                            </button>
                                        </td>
                                    </tr>
                                    {/* Expanded Detail Row */}
                                    {expandedId === p.id && (
                                        <tr>
                                            <td colSpan={7} className={`p-4 ${theme.cardBg} border-t border-dashed ${theme.cardBorder}`}>
                                                {/* Description */}
                                                <div className="mb-4">
                                                    <h4 className={`text-xs font-bold uppercase tracking-wider mb-2 ${theme.subText} border-l-4 border-blue-500 pl-2`}>Description</h4>
                                                    <div className={`text-xs p-3 rounded border ${theme.cardBorder} bg-slate-50 dark:bg-slate-800/50 ${theme.heading} max-h-[200px] overflow-auto whitespace-pre-wrap`} dangerouslySetInnerHTML={{ __html: p.description || '<em class="text-slate-400">无内容</em>' }} />
                                                </div>
                                                {/* Reference Images - paste/upload area */}
                                                <div className="mb-4">
                                                    <h4 className={`text-xs font-bold uppercase tracking-wider mb-2 ${theme.subText} border-l-4 border-green-500 pl-2`}>
                                                        参考图片 <span className="normal-case font-normal">（产品图、详情页截图等，可直接粘贴或拖拽上传）</span>
                                                    </h4>
                                                    <div
                                                        className={`p-4 rounded border-2 border-dashed ${theme.cardBorder} bg-slate-50 dark:bg-slate-800/50 min-h-[120px] transition-colors`}
                                                        onPaste={(e) => handlePasteImages(p.id, e)}
                                                        onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add('border-green-400', 'bg-green-50', 'dark:bg-green-900/20'); }}
                                                        onDragLeave={(e) => { e.currentTarget.classList.remove('border-green-400', 'bg-green-50', 'dark:bg-green-900/20'); }}
                                                        onDrop={(e) => {
                                                            e.preventDefault();
                                                            e.currentTarget.classList.remove('border-green-400', 'bg-green-50', 'dark:bg-green-900/20');
                                                            if (e.dataTransfer.files.length > 0) {
                                                                handleUploadImages(p.id, Array.from(e.dataTransfer.files));
                                                            }
                                                        }}
                                                        tabIndex={0}
                                                    >
                                                        {/* Uploaded images grid */}
                                                        {(refImages[p.id] && refImages[p.id].length > 0) ? (
                                                            <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-3 mb-3">
                                                                {refImages[p.id].map((img) => (
                                                                    <div key={img.filename} className="relative group">
                                                                        <img
                                                                            src={`/api${img.url}`}
                                                                            alt={img.filename}
                                                                            className="w-full h-24 object-cover rounded border border-slate-200 dark:border-slate-700"
                                                                        />
                                                                        <button
                                                                            onClick={() => handleDeleteRefImage(p.id, img.filename)}
                                                                            className="absolute -top-1.5 -right-1.5 bg-red-500 text-white rounded-full w-5 h-5 text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity shadow"
                                                                            title="删除"
                                                                        >
                                                                            &times;
                                                                        </button>
                                                                        <div className={`text-[10px] mt-1 truncate ${theme.subText}`}>{img.category}</div>
                                                                    </div>
                                                                ))}
                                                            </div>
                                                        ) : null}
                                                        {/* Upload prompt */}
                                                        <div className="flex items-center justify-center gap-3">
                                                            {uploadingImages === p.id ? (
                                                                <span className={`text-xs ${theme.subText}`}>上传中...</span>
                                                            ) : (
                                                                <>
                                                                    <IconPhoto className="w-5 h-5 text-slate-300" />
                                                                    <span className={`text-xs ${theme.subText}`}>
                                                                        Ctrl+V 粘贴图片 / 拖拽图片到此处 /
                                                                    </span>
                                                                    <label className="text-xs text-green-600 hover:text-green-500 cursor-pointer font-medium">
                                                                        点击选择文件
                                                                        <input
                                                                            type="file"
                                                                            multiple
                                                                            accept="image/*"
                                                                            className="hidden"
                                                                            onChange={(e) => {
                                                                                if (e.target.files && e.target.files.length > 0) {
                                                                                    handleUploadImages(p.id, e.target.files);
                                                                                    e.target.value = '';
                                                                                }
                                                                            }}
                                                                        />
                                                                    </label>
                                                                </>
                                                            )}
                                                        </div>
                                                    </div>
                                                </div>
                                                {/* Image Alt Texts for SEO Review */}
                                                {(() => {
                                                    const saved = parseAltTexts(p.description_alt_texts);
                                                    const edited = editingAltTexts[p.id] || {};
                                                    const merged = { ...saved, ...edited };
                                                    const hasAltTexts = Object.keys(saved).length > 0;
                                                    const hasEdits = Object.keys(edited).length > 0;
                                                    if (!hasAltTexts) return null;
                                                    return (
                                                        <div className="mt-4">
                                                            <h4 className={`text-xs font-bold uppercase tracking-wider mb-2 ${theme.subText} border-l-4 border-amber-500 pl-2`}>
                                                                Image Alt Texts (SEO)
                                                            </h4>
                                                            <div className={`p-3 rounded border ${theme.cardBorder} bg-slate-50 dark:bg-slate-800/50 space-y-2`}>
                                                                {Object.entries(ALT_TEXT_LABELS).map(([key, label]) => {
                                                                    const val = merged[key] || '';
                                                                    if (!val && !saved[key]) return null;
                                                                    return (
                                                                        <div key={key} className="flex items-start gap-2">
                                                                            <span className={`text-xs font-medium ${theme.subText} w-40 shrink-0 pt-1`}>{label}</span>
                                                                            <input
                                                                                className={`flex-1 text-xs ${theme.inputBg} border ${theme.inputBorder} rounded px-2 py-1.5 ${theme.heading} outline-none focus:ring-1 focus:ring-amber-500`}
                                                                                value={edited[key] !== undefined ? edited[key] : (saved[key] || '')}
                                                                                onChange={e => handleEditAltText(p.id, key, e.target.value)}
                                                                                placeholder="8-15 words, include product type + B2B keyword"
                                                                            />
                                                                        </div>
                                                                    );
                                                                })}
                                                                {hasEdits && (
                                                                    <div className="flex justify-end pt-1">
                                                                        <button
                                                                            onClick={() => handleSaveAltTexts(p.id)}
                                                                            disabled={savingAltTexts === p.id}
                                                                            className="bg-amber-600 hover:bg-amber-500 text-white text-xs font-bold py-1.5 px-4 rounded disabled:opacity-50"
                                                                        >
                                                                            {savingAltTexts === p.id ? '保存中...' : '保存 Alt Texts'}
                                                                        </button>
                                                                    </div>
                                                                )}
                                                            </div>
                                                        </div>
                                                    );
                                                })()}
                                                <div className="mt-3 flex items-center gap-4">
                                                    <a href={p.permalink} target="_blank" className="text-xs text-blue-500 hover:underline">在网站查看 →</a>
                                                    <span className={`text-xs ${theme.subText}`}>Slug: {p.slug}</span>
                                                </div>
                                            </td>
                                        </tr>
                                    )}
                                </React.Fragment>
                            ))}
                        </tbody>
                    </table>
                </div>

                {/* Pagination */}
                <div className="p-3 border-t dark:border-slate-700 flex items-center justify-between">
                    <div className="flex items-center gap-4">
                        <div className={`text-sm ${theme.subText}`}>
                            共 {totalProducts} 个产品，显示 {(page - 1) * limit + 1} - {Math.min(page * limit, totalProducts)}
                            {searchQuery ? `（关键词：${searchQuery}）` : ''}
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
                        <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1} className="px-3 py-1 border rounded hover:bg-slate-50 disabled:opacity-50 text-sm">上一页</button>
                        <span className={`text-sm ${theme.subText}`}>第</span>
                        <input
                            type="number"
                            min={1}
                            max={totalPages}
                            value={page}
                            onChange={e => {
                                const v = parseInt(e.target.value, 10);
                                if (!isNaN(v) && v >= 1 && v <= totalPages) setPage(v);
                            }}
                            className={`w-16 text-center text-sm border rounded px-1 py-1 ${theme.inputBg} ${theme.inputBorder} ${theme.heading}`}
                        />
                        <span className={`text-sm ${theme.subText}`}>/ {totalPages} 页</span>
                        <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page >= totalPages} className="px-3 py-1 border rounded hover:bg-slate-50 disabled:opacity-50 text-sm">下一页</button>
                    </div>
                </div>
            </div>
        </div>
    );
};
