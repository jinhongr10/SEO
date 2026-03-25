import React, { useState, useEffect, useCallback } from 'react';
import {
    IconRefresh, IconCloudUpload, IconCheck, IconX, IconPhoto
} from './Icons';

interface ProductItem {
    id: number;
    name: string;
    slug: string;
    permalink: string;
    category_slugs?: string;
    category_names?: string;
    image_urls?: string;
    short_ref_images?: string;
    full_ref_images?: string;
    status: string;
    short_description: string;
    description: string;
    acf_seo_extra_info: string;
    aioseo_title: string;
    aioseo_title_raw?: string;
    aioseo_description: string;
    aioseo_description_raw?: string;
    catalog_text?: string;
    issue_flags?: Partial<Record<ProductIssueFlagKey, boolean>>;
    issue_groups?: ProductIssueFlagKey[];
    error_reason?: string | null;
    updated_at: string;
}

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

interface ProductCategoryOption {
    slug: string;
    name: string;
    count: number;
}

type SeoFieldKey = 'acf_seo_extra_info' | 'aioseo_title' | 'aioseo_description';
type ProductContentFieldKey = 'short_description' | 'description';
type ProductSeoFieldKey = SeoFieldKey | ProductContentFieldKey;
type ProductIssueFlagKey =
    | 'full_description_empty'
    | 'short_description_empty'
    | 'acf_seo_extra_info_empty'
    | 'aioseo_title_missing_custom'
    | 'aioseo_description_missing_custom'
    | 'aioseo_title_uses_template_tag'
    | 'aioseo_description_uses_template_tag'
    | 'aioseo_title_is_default_or_empty'
    | 'aioseo_description_is_default_or_empty'
    | 'needs_attention'
    | 'generated_not_synced';

const SEO_FIELD_OPTIONS: Array<{ key: ProductSeoFieldKey; label: string }> = [
    { key: 'short_description', label: 'Short Description' },
    { key: 'description', label: 'Description' },
    { key: 'acf_seo_extra_info', label: 'ACF Extra Info' },
    { key: 'aioseo_title', label: 'AIOSEO Title' },
    { key: 'aioseo_description', label: 'AIOSEO Description' },
];

const PRODUCT_ISSUE_OPTIONS: Array<{ key: ProductIssueFlagKey; label: string }> = [
    { key: 'needs_attention', label: '任意问题' },
    { key: 'generated_not_synced', label: '已生成未同步' },
    { key: 'full_description_empty', label: 'Description 为空' },
    { key: 'short_description_empty', label: 'Short Description 为空' },
    { key: 'acf_seo_extra_info_empty', label: 'ACF Extra Info 为空' },
    { key: 'aioseo_title_is_default_or_empty', label: 'Product Title 默认/未写' },
    { key: 'aioseo_description_is_default_or_empty', label: 'Meta Description 默认/未写' },
    { key: 'aioseo_title_uses_template_tag', label: 'Product Title 含默认标签' },
    { key: 'aioseo_description_uses_template_tag', label: 'Meta Description 含默认标签' },
    { key: 'aioseo_title_missing_custom', label: 'Product Title 未填写' },
    { key: 'aioseo_description_missing_custom', label: 'Meta Description 未填写' },
];

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
    const [generatingFieldKey, setGeneratingFieldKey] = useState<string | null>(null);
    const [syncingProductId, setSyncingProductId] = useState<number | null>(null);
    const [selectedFieldKeys, setSelectedFieldKeys] = useState<ProductSeoFieldKey[]>([
        'short_description',
        'description',
        'acf_seo_extra_info',
        'aioseo_title',
        'aioseo_description',
    ]);
    const [isBatchGenerating, setIsBatchGenerating] = useState(false);
    const [isBatchSyncing, setIsBatchSyncing] = useState(false);
    const [searchInput, setSearchInput] = useState('');
    const [searchQuery, setSearchQuery] = useState('');
    const [categoryFilter, setCategoryFilter] = useState('');
    const [categoryOptions, setCategoryOptions] = useState<ProductCategoryOption[]>([]);
    const [issueFilter, setIssueFilter] = useState<ProductIssueFlagKey | ''>('');
    const [issueSummary, setIssueSummary] = useState<Partial<Record<ProductIssueFlagKey, number>>>({});
    const [shortDescTemplate, setShortDescTemplate] = useState('');
    const [fullDescTemplate, setFullDescTemplate] = useState('');
    const [docxRenderVersion, setDocxRenderVersion] = useState('');
    const [isLoadingList, setIsLoadingList] = useState(false);

    const [seoKeywords, setSeoKeywords] = useState('');

    const [editingProductId, setEditingProductId] = useState<number | null>(null);
    const [editShortDesc, setEditShortDesc] = useState('');
    const [editFullDesc, setEditFullDesc] = useState('');
    const [editAcf, setEditAcf] = useState('');
    const [editAioseoTitle, setEditAioseoTitle] = useState('');
    const [editAioseoDesc, setEditAioseoDesc] = useState('');
    const [editCatalogText, setEditCatalogText] = useState('');
    const [editShortRefImages, setEditShortRefImages] = useState('');
    const [editFullRefImages, setEditFullRefImages] = useState('');
    const [editSlug, setEditSlug] = useState('');
    const [refImages, setRefImages] = useState<Record<number, { filename: string; category: string; url: string }[]>>({});
    const [historyField, setHistoryField] = useState<{ productId: number; field: string } | null>(null);
    const [historyItems, setHistoryItems] = useState<{ id: number; field: string; value: string; created_at: string }[]>([]);
    const [uploadingImages, setUploadingImages] = useState<number | null>(null);

    const copyToClipboard = useCallback(async (text: string, successMsg: string) => {
        try {
            await navigator.clipboard.writeText(text || '');
            onNotice(successMsg);
        } catch (e: any) {
            onNotice(`复制失败: ${e?.message || '浏览器限制'}`);
        }
    }, [onNotice]);

    const readClipboardText = useCallback(async () => {
        try {
            const text = await navigator.clipboard.readText();
            return text || '';
        } catch (e: any) {
            onNotice(`读取剪贴板失败: ${e?.message || '浏览器限制'}`);
            return '';
        }
    }, [onNotice]);

    const fetchGenerationHistory = async (productId: number, field: string) => {
        try {
            const res = await fetch(`/api/products/${productId}/generation-history?field=${field}&limit=20`);
            if (res.ok) {
                const data = await res.json();
                setHistoryItems(data.history || []);
                setHistoryField({ productId, field });
            }
        } catch (e) {
            console.error('Failed to fetch generation history', e);
        }
    };

    const applyHistoryItem = (value: string, field: string) => {
        if (field === 'short_description') setEditShortDesc(value);
        if (field === 'description') setEditFullDesc(value);
        if (field === 'acf_seo_extra_info') setEditAcf(value);
        if (field === 'aioseo_title') setEditAioseoTitle(value);
        if (field === 'aioseo_description') setEditAioseoDesc(value);
        setHistoryField(null);
        onNotice('已应用历史记录，请保存修改');
    };

    const fetchRefImages = useCallback(async (productId: number) => {
        try {
            const res = await fetch(`/api/products/${productId}/ref-images`);
            if (res.ok) {
                const data = await res.json();
                setRefImages(prev => ({ ...prev, [productId]: data.images || [] }));
            }
        } catch (e) {
            console.error('Failed to fetch ref images', e);
        }
    }, []);

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

    const saveProductEdits = async (id: number) => {
        const res = await fetch(`/api/products/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                short_description: editShortDesc,
                description: editFullDesc,
                short_ref_images: editShortRefImages,
                full_ref_images: editFullRefImages,
                acf_seo_extra_info: editAcf,
                aioseo_title: editAioseoTitle,
                aioseo_description: editAioseoDesc,
                catalog_text: editCatalogText,
                slug: editSlug
            })
        });
        if (!res.ok) {
            throw new Error(await res.text());
        }
    };

    const fetchProducts = useCallback(async (silent = false) => {
        if (!silent) setIsLoadingList(true);
        try {
            const params = new URLSearchParams({
                page: String(page),
                limit: String(limit),
            });
            if (searchQuery.trim()) {
                params.set('q', searchQuery.trim());
            }
            if (categoryFilter.trim()) {
                params.set('category', categoryFilter.trim());
            }
            if (issueFilter) {
                params.set('issue', issueFilter);
            }
            const res = await fetch(`/api/products?${params.toString()}`);
            if (res.ok) {
                const data = await res.json();
                setProducts(data.items || []);
                setTotalProducts(data.total || 0);
                setIssueSummary(data.issue_summary || {});
            }
        } catch (e) {
            console.error('Failed to fetch products', e);
        } finally {
            if (!silent) setIsLoadingList(false);
        }
    }, [page, limit, searchQuery, categoryFilter, issueFilter]);

    const fetchCategories = useCallback(async () => {
        try {
            const res = await fetch('/api/products/categories');
            if (!res.ok) return;
            const data = await res.json();
            setCategoryOptions(Array.isArray(data.items) ? data.items : []);
        } catch (e) {
            console.error('Failed to fetch product categories', e);
        }
    }, []);

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

    useEffect(() => {
        fetchCategories();
    }, [fetchCategories]);

    useEffect(() => {
        (async () => {
            try {
                const res = await fetch('/api/products/render-version');
                if (!res.ok) return;
                const data = await res.json();
                const version = String(data.docx_render_version || '');
                setDocxRenderVersion(version);
            } catch {
                // keep silent; version badge is optional
            }
        })();
    }, []);

    // Auto-refresh every 5s silently
    useEffect(() => {
        const interval = setInterval(() => fetchProducts(true), 5000);
        return () => clearInterval(interval);
    }, [fetchProducts]);

    const handleSaveOriginalProductInfo = async (id: number) => {
        try {
            await saveProductEdits(id);
            onNotice('商品原内容已保存');
            setEditingProductId(null);
            fetchProducts(true);
        } catch (e: any) {
            onNotice('保存失败: ' + e.message);
        }
    };

    const handleSyncProductSeo = async (id: number) => {
        if (selectedFieldKeys.length === 0) {
            onNotice('请先勾选要同步的字段');
            return;
        }
        try {
            setSyncingProductId(id);
            // If current row is in editing mode, persist edits first to avoid syncing stale DB values.
            if (editingProductId === id) {
                await saveProductEdits(id);
            }
            onNotice('正在按所选字段同步该产品 SEO 到 WordPress...');
            const res = await fetch(`/api/products/${id}/sync-seo`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    fields: selectedFieldKeys,
                    only_changed: true,
                }),
            });
            if (!res.ok) {
                throw new Error(await res.text());
            }
            const data = await res.json();
            if (data.skipped) {
                onNotice('该产品所选字段没有变化，已跳过同步');
            } else {
                const syncedFields = Array.isArray(data.synced_fields) ? data.synced_fields : [];
                onNotice(`该产品已同步字段：${syncedFields.length ? syncedFields.join(', ') : '所选字段'}`);
            }
            fetchProducts(true);
        } catch (e: any) {
            onNotice('同步失败: ' + e.message);
        } finally {
            setSyncingProductId(null);
        }
    };

    const getFieldGeneratingKey = (id: number, field: ProductSeoFieldKey) => `${id}:${field}`;

    const isGeneratingField = (id: number, field: ProductSeoFieldKey) =>
        generatingFieldKey === getFieldGeneratingKey(id, field);

    const handleGenerateField = async (product: ProductItem, field: ProductSeoFieldKey) => {
        if (isRunning) return;
        const key = getFieldGeneratingKey(product.id, field);
        if (generatingFieldKey === key) return;

        requireApiKey(async () => {
            try {
                setGeneratingFieldKey(key);

                const usingEdit = editingProductId === product.id;
                const shortBase = usingEdit ? editShortDesc : (product.short_description || '');
                const descBase = usingEdit ? editFullDesc : (product.description || '');
                const currentValue = usingEdit
                    ? (field === 'short_description'
                        ? editShortDesc
                        : field === 'description'
                            ? editFullDesc
                            : field === 'acf_seo_extra_info'
                        ? editAcf
                        : field === 'aioseo_title'
                            ? editAioseoTitle
                            : editAioseoDesc)
                    : (product[field] || '');
                const shortRefImages = usingEdit ? editShortRefImages : (product.short_ref_images || '');
                const fullRefImages = usingEdit ? editFullRefImages : (product.full_ref_images || '');

                onNotice(`正在生成字段：${field} ...`);
                const res = await fetch(`/api/products/${product.id}/generate-field`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        field,
                        short_description: shortBase,
                        description: descBase,
                        short_ref_images: shortRefImages,
                        full_ref_images: fullRefImages,
                        current_value: currentValue,
                        language: 'en',
                        short_template: shortDescTemplate.trim(),
                        full_template: fullDescTemplate.trim(),
                        seo_keywords: seoKeywords.trim(),
                    }),
                });
                if (!res.ok) throw new Error(await res.text());
                const data = await res.json();
                const value = String(data.value || '');
                const activeDocxVersion = String(data.docx_render_version || '');
                if (activeDocxVersion) {
                    setDocxRenderVersion(activeDocxVersion);
                }

                if (editingProductId !== product.id) {
                    setEditingProductId(product.id);
                    setEditShortDesc(product.short_description || '');
                    setEditFullDesc(product.description || '');
                    setEditAcf(product.acf_seo_extra_info || '');
                    setEditAioseoTitle(product.aioseo_title || '');
                    setEditAioseoDesc(product.aioseo_description || '');
                    setEditCatalogText(product.catalog_text || '');
                    setEditShortRefImages(product.short_ref_images || '');
                    setEditFullRefImages(product.full_ref_images || '');
                    setEditSlug(product.slug || '');
                }

                if (field === 'short_description') setEditShortDesc(value);
                if (field === 'description') setEditFullDesc(value);
                if (field === 'acf_seo_extra_info') setEditAcf(value);
                if (field === 'aioseo_title') setEditAioseoTitle(value);
                if (field === 'aioseo_description') setEditAioseoDesc(value);

                if (field === 'description') {
                    const hasDocxMarker = value.includes('DOCX_STYLE_TEMPLATE_V');
                    if (!hasDocxMarker) {
                        onNotice('字段已生成，但当前后端未返回 DOCX 模板标记。请重启 3004 后端后再生成。');
                        return;
                    }
                }

                onNotice('字段 AI 生成完成，可继续手动修改后再保存');
            } catch (e: any) {
                onNotice('字段生成失败: ' + e.message);
            } finally {
                setGeneratingFieldKey(null);
            }
        });
    };

    const handleScan = async () => {
        if (isRunning) return;
        try {
            setIsRunning(true);
            onNotice('开始扫描 WooCommerce 产品...');
            const kick = await fetch('/api/product-scan');
            if (!kick.ok) {
                throw new Error(await kick.text());
            }

            const startedAt = Date.now();
            const timeoutMs = 5 * 60 * 1000;
            while (Date.now() - startedAt < timeoutMs) {
                await new Promise(resolve => setTimeout(resolve, 1000));
                const reportRes = await fetch('/api/media/report');
                if (!reportRes.ok) continue;
                const report = await reportRes.json();
                const status = report?.status || {};
                if (!status.isRunning) {
                    if (status.lastError) {
                        throw new Error(String(status.lastError));
                    }
                    fetchProducts(true);
                    fetchCategories();
                    onNotice('WooCommerce 产品扫描完成');
                    setIsRunning(false);
                    return;
                }
            }
            throw new Error('扫描超时，请稍后重试');
        } catch (e: any) {
            onNotice('扫描失败: ' + e.message);
            setIsRunning(false);
        }
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
        setCategoryFilter('');
        setIssueFilter('');
        setPage(1);
        setSelectedIds([]);
        setExpandedId(null);
    };

    const handleCategoryChange = (value: string) => {
        setCategoryFilter(value);
        setPage(1);
        setSelectedIds([]);
        setExpandedId(null);
    };

    const handleIssueChange = (value: ProductIssueFlagKey | '') => {
        setIssueFilter(value);
        setPage(1);
        setSelectedIds([]);
        setExpandedId(null);
    };

    const toggleFieldSelection = (field: ProductSeoFieldKey) => {
        setSelectedFieldKeys(prev => (
            prev.includes(field) ? prev.filter(f => f !== field) : [...prev, field]
        ));
    };

    const handleBatchGenerateSelected = () => {
        if (selectedIds.length === 0) {
            onNotice('请先勾选需要处理的产品');
            return;
        }
        if (selectedFieldKeys.length === 0) {
            onNotice('请先勾选需要 AI 生成的字段');
            return;
        }

        requireApiKey(async () => {
            try {
                setIsBatchGenerating(true);
                onNotice(`正在为 ${selectedIds.length} 个产品生成 ${selectedFieldKeys.length} 个字段...`);
                const res = await fetch('/api/products/generate-batch', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        ids: selectedIds,
                        fields: selectedFieldKeys,
                        language: 'en',
                        short_template: shortDescTemplate.trim(),
                        full_template: fullDescTemplate.trim(),
                    }),
                });
                if (!res.ok) throw new Error(await res.text());
                const data = await res.json();
                onNotice(`批量 AI 完成：更新 ${data.updated_products || 0} 个产品，生成 ${data.generated_fields || 0} 项`);
                fetchProducts(true);
            } catch (e: any) {
                onNotice('批量 AI 失败: ' + e.message);
            } finally {
                setIsBatchGenerating(false);
            }
        });
    };

    const handleBatchSyncSelected = async () => {
        if (selectedIds.length === 0) {
            onNotice('请先勾选要同步的产品');
            return;
        }
        if (selectedFieldKeys.length === 0) {
            onNotice('请先勾选要同步的字段');
            return;
        }
        try {
            setIsBatchSyncing(true);
            // If currently editing a product that is in the sync list, save edits first
            if (editingProductId && selectedIds.includes(editingProductId)) {
                await saveProductEdits(editingProductId);
            }
            onNotice(`正在同步 ${selectedIds.length} 个产品的所选字段到 WordPress...`);
            const res = await fetch('/api/products/sync-seo-batch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    ids: selectedIds,
                    fields: selectedFieldKeys,
                    only_changed: true,
                }),
            });
            if (!res.ok) throw new Error(await res.text());
            const data = await res.json();
            if (data.failed > 0) {
                onNotice(`同步完成：成功 ${data.applied || 0}，跳过 ${data.skipped || 0}，失败 ${data.failed}（可重试）`);
            } else {
                onNotice(`同步完成：成功 ${data.applied || 0}，跳过 ${data.skipped || 0}`);
            }
            fetchProducts(true);
        } catch (e: any) {
            onNotice('批量同步失败: ' + e.message);
        } finally {
            setIsBatchSyncing(false);
        }
    };

    const updateReviewField = (id: number, field: string, val: string) => {
        setReviewItems(prev => prev.map(item => item.id === id ? { ...item, [field]: val } : item));
    };

    const issueLabelMap = React.useMemo(
        () => new Map(PRODUCT_ISSUE_OPTIONS.map(opt => [opt.key, opt.label])),
        [],
    );

    const getIssueLabels = (product: ProductItem) => {
        const groups = Array.isArray(product.issue_groups)
            ? product.issue_groups
            : Object.entries(product.issue_flags || {})
                .filter(([key, value]) => key !== 'needs_attention' && Boolean(value))
                .map(([key]) => key as ProductIssueFlagKey);
        return groups.map(key => issueLabelMap.get(key) || key);
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
                    <button onClick={() => { fetchProducts(); fetchReviewItems(); fetchCategories(); }} className={`p-2 rounded-full hover:bg-black/5 dark:hover:bg-white/5 ${theme.subText}`}><IconRefresh /></button>
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
                            disabled={!searchInput && !searchQuery && !categoryFilter && !issueFilter}
                            className={`text-sm py-2 px-3 rounded-lg border disabled:opacity-50 ${theme.inputBg} ${theme.inputBorder} ${theme.heading}`}
                        >
                            清空筛选
                        </button>
                    </div>

                    <div className="flex items-center gap-2">
                        <span className={`text-xs ${theme.subText}`}>分类</span>
                        <select
                            value={categoryFilter}
                            onChange={(e) => handleCategoryChange(e.target.value)}
                            className={`text-sm ${theme.inputBg} border ${theme.inputBorder} rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-blue-500 ${theme.heading}`}
                        >
                            <option value="">全部分类</option>
                            {categoryOptions.map((opt) => (
                                <option key={opt.slug} value={opt.slug}>
                                    {opt.name} ({opt.count})
                                </option>
                            ))}
                        </select>
                    </div>

                    <div className="flex items-center gap-2">
                        <span className={`text-xs ${theme.subText}`}>问题筛选</span>
                        <select
                            value={issueFilter}
                            onChange={(e) => handleIssueChange((e.target.value || '') as ProductIssueFlagKey | '')}
                            className={`text-sm ${theme.inputBg} border ${theme.inputBorder} rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-blue-500 ${theme.heading}`}
                        >
                            <option value="">全部问题类型</option>
                            {PRODUCT_ISSUE_OPTIONS.map((opt) => (
                                <option key={opt.key} value={opt.key}>
                                    {opt.label} ({issueSummary[opt.key] || 0})
                                </option>
                            ))}
                        </select>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 px-2 py-1 rounded-lg border border-slate-200 dark:border-slate-700">
                        <span className={`text-[11px] ${theme.subText}`}>AI/同步字段</span>
                        {SEO_FIELD_OPTIONS.map(opt => (
                            <label key={opt.key} className={`text-xs flex items-center gap-1.5 ${theme.subText}`}>
                                <input
                                    type="checkbox"
                                    checked={selectedFieldKeys.includes(opt.key)}
                                    onChange={() => toggleFieldSelection(opt.key)}
                                />
                                {opt.label}
                            </label>
                        ))}
                    </div>

                    <button
                        onClick={handleBatchGenerateSelected}
                        disabled={isBatchGenerating || selectedIds.length === 0 || selectedFieldKeys.length === 0}
                        className="bg-purple-600 hover:bg-purple-500 text-white text-sm font-bold py-2 px-4 rounded-lg disabled:opacity-50 shadow-sm"
                    >
                        {isBatchGenerating ? 'AI生成中...' : 'AI生成所选字段'}
                    </button>

                    <button
                        onClick={handleBatchSyncSelected}
                        disabled={isBatchSyncing || selectedIds.length === 0}
                        className="bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-bold py-2 px-4 rounded-lg disabled:opacity-50 shadow-sm"
                    >
                        {isBatchSyncing ? '同步中...' : '同步所选到WordPress'}
                    </button>

                    <button onClick={() => { fetchReviewItems(); setShowReview(!showReview); }} className="bg-green-600 hover:bg-green-500 text-white text-sm font-bold py-2 px-5 rounded-lg flex items-center gap-2 shadow-lg">
                        <IconCheck className="w-4 h-4" /> 审核并发布
                    </button>
                </div>

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
                            <div className={`p-8 text-center ${theme.subText}`}>暂无待审核的产品 SEO 数据。请先在字段旁点击“AI生成”。</div>
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
                                <th className={`p-3 font-medium ${theme.subText}`}>问题标签</th>
                                <th className={`p-3 font-medium ${theme.subText}`}>状态</th>
                                <th className={`p-3 font-medium ${theme.subText}`}>更新时间</th>
                                <th className={`p-3 font-medium ${theme.subText} w-10`}></th>
                            </tr>
                        </thead>
                        <tbody className="divide-y dark:divide-slate-800">
                            {isLoadingList && products.length === 0 ? (
                                <tr><td colSpan={8} className="p-8 text-center text-slate-400">加载中...</td></tr>
                            ) : products.length === 0 ? (
                                <tr><td colSpan={8} className="p-8 text-center text-slate-400">暂无产品数据，请点击"扫描产品"获取。</td></tr>
                            ) : products.map(p => (
                                <React.Fragment key={p.id}>
                                    <tr className={`hover:bg-slate-50 dark:hover:bg-slate-800/50 cursor-pointer ${selectedIds.includes(p.id) ? 'bg-blue-50 dark:bg-blue-900/10' : ''}`}>
                                        <td className="p-3"><input type="checkbox" checked={selectedIds.includes(p.id)} onChange={e => setSelectedIds(prev => e.target.checked ? [...prev, p.id] : prev.filter(id => id !== p.id))} /></td>
                                        <td className={`p-3 font-mono text-xs ${theme.subText}`}>{p.id}</td>
                                        <td className="p-3">
                                            <div className={`font-medium ${theme.heading}`}>{p.name}</div>
                                            <a href={p.permalink} target="_blank" className="text-xs text-slate-400 hover:underline">{p.slug}</a>
                                            {p.category_names && (
                                                <div className={`text-[11px] mt-1 ${theme.subText}`}>分类: {p.category_names}</div>
                                            )}
                                        </td>
                                        <td className={`p-3 text-xs max-w-[250px] ${theme.subText}`}>
                                            <div className="truncate" title={stripHtml(p.short_description)}>{stripHtml(p.short_description) || <span className="text-slate-300 italic">无</span>}</div>
                                        </td>
                                        <td className="p-3">
                                            <div className="flex flex-wrap gap-1 max-w-[220px]">
                                                {getIssueLabels(p).slice(0, 3).map(label => (
                                                    <span key={`${p.id}-${label}`} className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">
                                                        {label}
                                                    </span>
                                                ))}
                                                {getIssueLabels(p).length > 3 && (
                                                    <span className={`text-[11px] ${theme.subText}`}>+{getIssueLabels(p).length - 3}</span>
                                                )}
                                                {getIssueLabels(p).length === 0 && (
                                                    <span className={`text-[11px] ${theme.subText}`}>无</span>
                                                )}
                                            </div>
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
                                            <td colSpan={8} className={`p-4 ${theme.cardBg} border-t border-dashed ${theme.cardBorder}`}>
                                                <div className="flex items-center justify-between mb-4">
                                                    <h3 className={`font-bold ${theme.heading}`}>原文内容预览 (扫描抓取的内容)</h3>
                                                    {editingProductId === p.id ? (
                                                        <div className="flex gap-2">
                                                            <button onClick={() => setEditingProductId(null)} className="text-xs px-3 py-1.5 rounded border border-slate-300 dark:border-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800">取消</button>
                                                            <button onClick={() => handleSaveOriginalProductInfo(p.id)} className="text-xs px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-white font-medium shadow-sm">保存修改</button>
                                                            <button
                                                                onClick={() => handleSyncProductSeo(p.id)}
                                                                disabled={syncingProductId === p.id}
                                                                className="text-xs px-3 py-1.5 rounded bg-green-600 hover:bg-green-500 text-white font-medium shadow-sm disabled:opacity-50"
                                                            >
                                                                {syncingProductId === p.id ? '同步中...' : '同步SEO到WordPress'}
                                                            </button>
                                                        </div>
                                                    ) : (
                                                        <div className="flex gap-2">
                                                            <button
                                                                onClick={() => {
                                                                    setEditingProductId(p.id);
                                                                    setEditShortDesc(p.short_description);
                                                                    setEditFullDesc(p.description);
                                                                    setEditAcf(p.acf_seo_extra_info);
                                                                    setEditAioseoTitle(p.aioseo_title);
                                                                    setEditAioseoDesc(p.aioseo_description);
                                                                    setEditCatalogText(p.catalog_text || '');
                                                                    setEditShortRefImages(p.short_ref_images || '');
                                                                    setEditFullRefImages(p.full_ref_images || '');
                                                                    setEditSlug(p.slug);
                                                                }}
                                                                className={`text-xs px-3 py-1.5 rounded border ${theme.cardBorder} hover:bg-slate-100 dark:hover:bg-slate-800`}
                                                            >
                                                                修改原内容 (影响后续AI生成)
                                                            </button>
                                                            <button
                                                                onClick={() => handleSyncProductSeo(p.id)}
                                                                disabled={syncingProductId === p.id}
                                                                className="text-xs px-3 py-1.5 rounded bg-green-600 hover:bg-green-500 text-white font-medium shadow-sm disabled:opacity-50"
                                                            >
                                                                {syncingProductId === p.id ? '同步中...' : '同步SEO到WordPress'}
                                                            </button>
                                                        </div>
                                                    )}
                                                </div>

                                                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                                                    {/* Short Description — hide when filtering by unrelated issue */}
                                                    {(!issueFilter || ['needs_attention', 'generated_not_synced', 'short_description_empty'].includes(issueFilter)) && (
                                                    <div>
                                                        <div className="flex items-center justify-between mb-2 gap-2">
                                                            <h4 className={`text-xs font-bold uppercase tracking-wider ${theme.subText} border-l-4 border-purple-500 pl-2`}>Short Description (WooCommerce 默认短描述)</h4>
                                                            <div className="flex items-center gap-2">
                                                                <button
                                                                    onClick={async () => {
                                                                        const text = await readClipboardText();
                                                                        if (text) setEditShortDesc(text);
                                                                    }}
                                                                    disabled={editingProductId !== p.id}
                                                                    className="text-[11px] px-2 py-1 rounded border border-slate-300 dark:border-slate-600 disabled:opacity-50"
                                                                >
                                                                    粘贴
                                                                </button>
                                                                <button
                                                                    onClick={() => copyToClipboard(editingProductId === p.id ? editShortDesc : (p.short_description || ''), 'Short Description HTML 已复制')}
                                                                    className="text-[11px] px-2 py-1 rounded border border-slate-300 dark:border-slate-600"
                                                                >
                                                                    复制HTML
                                                                </button>
                                                                <button
                                                                    onClick={() => handleGenerateField(p, 'short_description')}
                                                                    disabled={Boolean(generatingFieldKey)}
                                                                    className="text-[11px] px-2 py-1 rounded bg-purple-600 hover:bg-purple-500 text-white disabled:opacity-50"
                                                                >
                                                                    {isGeneratingField(p.id, 'short_description') ? '生成中...' : 'AI生成'}
                                                                </button>
                                                            </div>
                                                        </div>
                                                        {editingProductId === p.id ? (
                                                            <div className="space-y-2">
                                                                <textarea className={`w-full text-xs p-3 rounded border ${theme.inputBorder} ${theme.inputBg} ${theme.heading} outline-none focus:ring-1 focus:ring-purple-500 resize-y`} rows={8} value={editShortDesc} onChange={e => setEditShortDesc(e.target.value)} />
                                                                <div className={`rounded border ${theme.cardBorder} bg-white dark:bg-slate-900 p-3`}>
                                                                    <div className={`text-[11px] font-bold uppercase tracking-wider mb-2 ${theme.subText}`}>可视化预览</div>
                                                                    <div className={`text-xs ${theme.heading} prose prose-sm max-w-none dark:prose-invert`} dangerouslySetInnerHTML={{ __html: editShortDesc || '<em class="text-slate-400">无内容</em>' }} />
                                                                </div>
                                                            </div>
                                                        ) : (
                                                            <div className={`text-xs p-3 rounded border ${theme.cardBorder} bg-slate-50 dark:bg-slate-800/50 ${theme.heading} max-h-[200px] overflow-auto whitespace-pre-wrap`} dangerouslySetInnerHTML={{ __html: p.short_description || '<em class="text-slate-400">无内容</em>' }} />
                                                        )}
                                                    </div>
                                                    )}
                                                    {/* Description — hide when filtering by unrelated issue */}
                                                    {(!issueFilter || ['needs_attention', 'generated_not_synced', 'full_description_empty'].includes(issueFilter)) && (
                                                    <div>
                                                        <div className="flex items-center justify-between mb-2 gap-2">
                                                            <h4 className={`text-xs font-bold uppercase tracking-wider ${theme.subText} border-l-4 border-blue-500 pl-2`}>
                                                                Description {docxRenderVersion ? `(${docxRenderVersion})` : ''}
                                                            </h4>
                                                            <div className="flex items-center gap-2">
                                                                <button
                                                                    onClick={async () => {
                                                                        const text = await readClipboardText();
                                                                        if (text) setEditFullDesc(text);
                                                                    }}
                                                                    disabled={editingProductId !== p.id}
                                                                    className="text-[11px] px-2 py-1 rounded border border-slate-300 dark:border-slate-600 disabled:opacity-50"
                                                                >
                                                                    粘贴
                                                                </button>
                                                                <button
                                                                    onClick={() => copyToClipboard(editingProductId === p.id ? editFullDesc : (p.description || ''), 'Description HTML 已复制')}
                                                                    className="text-[11px] px-2 py-1 rounded border border-slate-300 dark:border-slate-600"
                                                                >
                                                                    复制HTML
                                                                </button>
                                                                <button
                                                                    onClick={() => handleGenerateField(p, 'description')}
                                                                    disabled={Boolean(generatingFieldKey)}
                                                                    className="text-[11px] px-2 py-1 rounded bg-purple-600 hover:bg-purple-500 text-white disabled:opacity-50"
                                                                >
                                                                    {isGeneratingField(p.id, 'description') ? '生成中...' : 'AI生成'}
                                                                </button>
                                                                <button
                                                                    onClick={() => fetchGenerationHistory(p.id, 'description')}
                                                                    className="text-[11px] px-2 py-1 rounded border border-slate-300 dark:border-slate-600"
                                                                >
                                                                    历史
                                                                </button>
                                                            </div>
                                                        </div>
                                                        {editingProductId === p.id ? (
                                                            <div className="space-y-2">
                                                                <textarea className={`w-full text-xs p-3 rounded border ${theme.inputBorder} ${theme.inputBg} ${theme.heading} outline-none focus:ring-1 focus:ring-blue-500 resize-y font-mono`} rows={8} value={editFullDesc} onChange={e => setEditFullDesc(e.target.value)} />
                                                            </div>
                                                        ) : (
                                                            <div className={`text-xs p-3 rounded border ${theme.cardBorder} bg-slate-50 dark:bg-slate-800/50 ${theme.heading} max-h-[200px] overflow-auto whitespace-pre-wrap`} dangerouslySetInnerHTML={{ __html: p.description || '<em class="text-slate-400">无内容</em>' }} />
                                                        )}
                                                    </div>
                                                    )}
                                                    {/* Description 全宽可视化预览 — 模拟 WooCommerce 后台全宽渲染 */}
                                                    {(!issueFilter || ['needs_attention', 'generated_not_synced', 'full_description_empty'].includes(issueFilter)) && editingProductId === p.id && (
                                                        <div className="lg:col-span-2">
                                                            <div className={`rounded border ${theme.cardBorder} bg-white dark:bg-slate-900 p-4`}>
                                                                <div className={`text-[11px] font-bold uppercase tracking-wider mb-3 ${theme.subText}`}>Description 可视化预览（全宽，模拟 WooCommerce 前台效果）</div>
                                                                <div className={`${theme.heading} max-w-none`} style={{ fontSize: '14px', lineHeight: '1.6' }} dangerouslySetInnerHTML={{ __html: editFullDesc || '<em style="color: #94a3b8;">无内容</em>' }} />
                                                            </div>
                                                        </div>
                                                    )}
                                                    {/* 参考图片 — show when description filter or no filter */}
                                                    {(!issueFilter || ['needs_attention', 'generated_not_synced', 'full_description_empty'].includes(issueFilter)) && (
                                                    <div className="lg:col-span-2">
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
                                                                        </div>
                                                                    ))}
                                                                </div>
                                                            ) : null}
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
                                                    )}
                                                    {/* 产品图册参考图片（AI 直接读取图片内容，不会出现在 Description 中） */}
                                                    {(!issueFilter || ['needs_attention', 'generated_not_synced', 'full_description_empty', 'short_description_empty'].includes(issueFilter)) && (
                                                    <div className="lg:col-span-2">
                                                        <h4 className={`text-xs font-bold uppercase tracking-wider mb-2 ${theme.subText} border-l-4 border-teal-500 pl-2`}>
                                                            产品图册参考图片 <span className="normal-case font-normal">（上传图册截图，AI 自动读取图片中的文字和信息，不会出现在 Description 中）</span>
                                                        </h4>
                                                        <div
                                                            className={`p-3 rounded border-2 border-dashed ${theme.cardBorder} bg-slate-50 dark:bg-slate-800/50 min-h-[80px] transition-colors`}
                                                            onPaste={(e) => handlePasteImages(p.id, e, 'catalog')}
                                                            onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add('border-teal-400', 'bg-teal-50', 'dark:bg-teal-900/20'); }}
                                                            onDragLeave={(e) => { e.currentTarget.classList.remove('border-teal-400', 'bg-teal-50', 'dark:bg-teal-900/20'); }}
                                                            onDrop={(e) => {
                                                                e.preventDefault();
                                                                e.currentTarget.classList.remove('border-teal-400', 'bg-teal-50', 'dark:bg-teal-900/20');
                                                                if (e.dataTransfer.files.length > 0) {
                                                                    handleUploadImages(p.id, Array.from(e.dataTransfer.files), 'catalog');
                                                                }
                                                            }}
                                                            tabIndex={0}
                                                        >
                                                            {(() => {
                                                                const catalogImgs = (refImages[p.id] || []).filter(img => img.category === 'catalog');
                                                                return catalogImgs.length > 0 ? (
                                                                    <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-3 mb-3">
                                                                        {catalogImgs.map((img) => (
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
                                                                            </div>
                                                                        ))}
                                                                    </div>
                                                                ) : null;
                                                            })()}
                                                            <div className="flex items-center justify-center gap-3">
                                                                {uploadingImages === p.id ? (
                                                                    <span className={`text-xs ${theme.subText}`}>上传中...</span>
                                                                ) : (
                                                                    <>
                                                                        <IconPhoto className="w-4 h-4 text-slate-300" />
                                                                        <span className={`text-xs ${theme.subText}`}>
                                                                            Ctrl+V 粘贴图册图片 / 拖拽到此处 /
                                                                        </span>
                                                                        <label className="text-xs text-teal-600 hover:text-teal-500 cursor-pointer font-medium">
                                                                            点击选择文件
                                                                            <input
                                                                                type="file"
                                                                                multiple
                                                                                accept="image/*"
                                                                                className="hidden"
                                                                                onChange={(e) => {
                                                                                    if (e.target.files && e.target.files.length > 0) {
                                                                                        handleUploadImages(p.id, e.target.files, 'catalog');
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
                                                    )}
                                                    {/* ACF Extra Info — hide when filtering by unrelated issue */}
                                                    {(!issueFilter || ['needs_attention', 'generated_not_synced', 'acf_seo_extra_info_empty'].includes(issueFilter)) && (
                                                    <div>
                                                        <div className="flex items-center justify-between mb-2 gap-2">
                                                            <h4 className={`text-xs font-bold uppercase tracking-wider ${theme.subText} border-l-4 border-green-500 pl-2`}>ACF Extra Info——SEO (字段名为 short_description)</h4>
                                                            <button
                                                                onClick={() => handleGenerateField(p, 'acf_seo_extra_info')}
                                                                disabled={Boolean(generatingFieldKey)}
                                                                className="text-[11px] px-2 py-1 rounded bg-purple-600 hover:bg-purple-500 text-white disabled:opacity-50"
                                                            >
                                                                {isGeneratingField(p.id, 'acf_seo_extra_info') ? '生成中...' : 'AI生成'}
                                                            </button>
                                                        </div>
                                                        {editingProductId === p.id ? (
                                                            <textarea className={`w-full text-xs p-3 rounded border ${theme.inputBorder} ${theme.inputBg} ${theme.heading} outline-none focus:ring-1 focus:ring-green-500 resize-y`} rows={5} value={editAcf} onChange={e => setEditAcf(e.target.value)} />
                                                        ) : (
                                                            <div className={`text-xs p-3 rounded border ${theme.cardBorder} bg-slate-50 dark:bg-slate-800/50 ${theme.heading} max-h-[150px] overflow-auto whitespace-pre-wrap`}>
                                                                {p.acf_seo_extra_info || <em className="text-slate-400">无内容</em>}
                                                            </div>
                                                        )}
                                                    </div>
                                                    )}
                                                    {/* SEO Core Keywords — show for description / AIOSEO related issues */}
                                                    {(!issueFilter || ['needs_attention', 'generated_not_synced', 'full_description_empty', 'short_description_empty', 'aioseo_title_is_default_or_empty', 'aioseo_description_is_default_or_empty', 'aioseo_title_uses_template_tag', 'aioseo_description_uses_template_tag', 'aioseo_title_missing_custom', 'aioseo_description_missing_custom'].includes(issueFilter)) && (
                                                    <div>
                                                        <div className="flex items-center gap-2 mb-2">
                                                            <h4 className={`text-xs font-bold uppercase tracking-wider ${theme.subText} border-l-4 border-orange-500 pl-2`}>SEO Core Keywords</h4>
                                                        </div>
                                                        <input
                                                            type="text"
                                                            className={`w-full text-xs p-2 rounded border ${theme.inputBorder} ${theme.inputBg} ${theme.heading} outline-none focus:ring-1 focus:ring-orange-500`}
                                                            value={seoKeywords}
                                                            onChange={e => setSeoKeywords(e.target.value)}
                                                            placeholder="输入核心关键词，用逗号分隔，如：shower gel bracket, magnetic soap holder, hotel bathroom accessories"
                                                        />
                                                        <p className={`text-[10px] mt-1 ${theme.subText}`}>AI 生成 Description / AIOSEO Title / Description 时会自动融入这些关键词</p>
                                                    </div>
                                                    )}
                                                    {/* AIOSEO Title/Description — hide when filtering by unrelated issue */}
                                                    {(!issueFilter || ['needs_attention', 'generated_not_synced', 'aioseo_title_is_default_or_empty', 'aioseo_description_is_default_or_empty', 'aioseo_title_uses_template_tag', 'aioseo_description_uses_template_tag', 'aioseo_title_missing_custom', 'aioseo_description_missing_custom'].includes(issueFilter)) && (
                                                    <div className="space-y-4">
                                                        <div>
                                                            <div className="flex items-center justify-between mb-2 gap-2">
                                                                <h4 className={`text-xs font-bold uppercase tracking-wider ${theme.subText} border-l-4 border-yellow-500 pl-2`}>AIOSEO Title</h4>
                                                                <button
                                                                    onClick={() => handleGenerateField(p, 'aioseo_title')}
                                                                    disabled={Boolean(generatingFieldKey)}
                                                                    className="text-[11px] px-2 py-1 rounded bg-purple-600 hover:bg-purple-500 text-white disabled:opacity-50"
                                                                >
                                                                    {isGeneratingField(p.id, 'aioseo_title') ? '生成中...' : 'AI生成'}
                                                                </button>
                                                            </div>
                                                            {editingProductId === p.id ? (
                                                                <input type="text" className={`w-full text-xs p-2 rounded border ${theme.inputBorder} ${theme.inputBg} ${theme.heading} outline-none focus:ring-1 focus:ring-yellow-500`} value={editAioseoTitle} onChange={e => setEditAioseoTitle(e.target.value)} />
                                                            ) : (
                                                                <div className={`text-xs p-2 rounded border ${theme.cardBorder} bg-slate-50 dark:bg-slate-800/50 ${theme.heading} whitespace-pre-wrap`}>
                                                                    {p.aioseo_title || <em className="text-slate-400">无内容</em>}
                                                                </div>
                                                            )}
                                                        </div>
                                                        <div>
                                                            <div className="flex items-center justify-between mb-2 gap-2">
                                                                <h4 className={`text-xs font-bold uppercase tracking-wider ${theme.subText} border-l-4 border-yellow-500 pl-2`}>AIOSEO Description</h4>
                                                                <button
                                                                    onClick={() => handleGenerateField(p, 'aioseo_description')}
                                                                    disabled={Boolean(generatingFieldKey)}
                                                                    className="text-[11px] px-2 py-1 rounded bg-purple-600 hover:bg-purple-500 text-white disabled:opacity-50"
                                                                >
                                                                    {isGeneratingField(p.id, 'aioseo_description') ? '生成中...' : 'AI生成'}
                                                                </button>
                                                            </div>
                                                            {editingProductId === p.id ? (
                                                                <textarea className={`w-full text-xs p-2 rounded border ${theme.inputBorder} ${theme.inputBg} ${theme.heading} outline-none focus:ring-1 focus:ring-yellow-500 resize-y`} rows={3} value={editAioseoDesc} onChange={e => setEditAioseoDesc(e.target.value)} />
                                                            ) : (
                                                                <div className={`text-xs p-2 rounded border ${theme.cardBorder} bg-slate-50 dark:bg-slate-800/50 ${theme.heading} whitespace-pre-wrap`}>
                                                                    {p.aioseo_description || <em className="text-slate-400">无内容</em>}
                                                                </div>
                                                            )}
                                                        </div>
                                                    </div>
                                                    )}
                                                </div>
                                                <div className="mt-3 flex items-center gap-4">
                                                    <a href={p.permalink} target="_blank" className="text-xs text-blue-500 hover:underline">在网站查看 →</a>
                                                    {editingProductId === p.id ? (
                                                        <div className="flex items-center gap-2">
                                                            <span className={`text-xs ${theme.subText}`}>Slug:</span>
                                                            <input type="text" className={`text-xs p-1 px-2 w-[300px] rounded border ${theme.inputBorder} ${theme.inputBg} ${theme.heading} outline-none focus:ring-1 focus:ring-blue-500`} value={editSlug} onChange={e => setEditSlug(e.target.value)} />
                                                        </div>
                                                    ) : (
                                                        <span className={`text-xs ${theme.subText}`}>Slug: {p.slug}</span>
                                                    )}
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
                            {issueFilter ? `（问题：${PRODUCT_ISSUE_OPTIONS.find(o => o.key === issueFilter)?.label || issueFilter}）` : ''}
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

            {/* Generation History Modal */}
            {historyField && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setHistoryField(null)}>
                    <div className={`w-full max-w-3xl max-h-[80vh] rounded-xl border ${theme.cardBorder} ${theme.cardBg} shadow-2xl overflow-hidden`} onClick={e => e.stopPropagation()}>
                        <div className="flex items-center justify-between p-4 border-b dark:border-slate-700">
                            <h3 className={`text-sm font-bold ${theme.heading}`}>
                                生成历史记录 — {historyField.field} (Product #{historyField.productId})
                            </h3>
                            <button onClick={() => setHistoryField(null)} className={`text-lg px-2 ${theme.subText} hover:opacity-70`}>&times;</button>
                        </div>
                        <div className="overflow-auto max-h-[65vh] p-4 space-y-3">
                            {historyItems.length === 0 ? (
                                <div className={`text-sm ${theme.subText} text-center py-8`}>暂无历史记录</div>
                            ) : historyItems.map((item) => (
                                <div key={item.id} className={`rounded border ${theme.cardBorder} p-3`}>
                                    <div className="flex items-center justify-between mb-2">
                                        <span className={`text-[11px] ${theme.subText}`}>{item.created_at}</span>
                                        <button
                                            onClick={() => applyHistoryItem(item.value, item.field)}
                                            className="text-[11px] px-3 py-1 rounded bg-blue-600 hover:bg-blue-500 text-white"
                                        >
                                            使用此版本
                                        </button>
                                    </div>
                                    {historyField.field === 'description' ? (
                                        <div className={`text-xs ${theme.heading} max-h-[200px] overflow-auto`} style={{ fontSize: '12px', lineHeight: '1.5' }} dangerouslySetInnerHTML={{ __html: item.value || '' }} />
                                    ) : (
                                        <div className={`text-xs ${theme.heading} max-h-[150px] overflow-auto whitespace-pre-wrap`}>{item.value}</div>
                                    )}
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};
