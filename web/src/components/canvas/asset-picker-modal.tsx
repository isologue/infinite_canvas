import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Empty, Input, Modal, Pagination, Tag } from "antd";
import { Search, Upload, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { type CanvasGroupAssetData } from "@/lib/canvas/canvas-group-asset";
import { uploadImage } from "@/services/image-storage";
import { useAssetStore, type Asset } from "@/stores/use-asset-store";

export type InsertAssetPayload = { kind: "text"; content: string; title: string } | { kind: "image"; dataUrl: string; title: string; storageKey?: string; width?: number; height?: number; bytes?: number; mimeType?: string } | { kind: "video"; url: string; title: string; storageKey?: string; width?: number; height?: number } | { kind: "audio"; url: string; title: string; storageKey?: string; durationMs?: number } | { kind: "group"; data: CanvasGroupAssetData; title: string };

type Props = {
    open: boolean;
    defaultTab?: string;
    onInsert: (payload: InsertAssetPayload) => void;
    onClose: () => void;
    multiSelectMax?: number;
    onInsertMany?: (payloads: InsertAssetPayload[]) => void;
};

export function AssetPickerModal({ open, onInsert, onClose, multiSelectMax, onInsertMany }: Props) {
    const [assetPayloads, setAssetPayloads] = useState<InsertAssetPayload[]>([]);
    const [localPayloads, setLocalPayloads] = useState<Extract<InsertAssetPayload, { kind: "image" }>[]>([]);
    const [uploading, setUploading] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const multiSelect = Boolean(multiSelectMax && multiSelectMax > 0);
    const selectedPayloads = [...assetPayloads, ...localPayloads];
    useEffect(() => {
        if (!open) {
            setAssetPayloads([]);
            setLocalPayloads([]);
        }
    }, [open]);
    const confirmMany = () => {
        if (!selectedPayloads.length) return;
        if (onInsertMany) onInsertMany(selectedPayloads);
        else selectedPayloads.forEach(onInsert);
        onClose();
    };
    const handleLocalUpload = async (files: FileList | null) => {
        const candidates = Array.from(files || []).filter((file) => file.type.startsWith("image/"));
        if (!candidates.length) return;
        const remaining = multiSelect ? Math.max(0, (multiSelectMax || 0) - selectedPayloads.length) : candidates.length;
        if (!remaining) return;
        setUploading(true);
        try {
            const uploaded = await Promise.all(candidates.slice(0, remaining).map(async (file) => {
                const image = await uploadImage(file, { compress: true, title: file.name, source: "canvas-batch-replace" });
                return { kind: "image" as const, dataUrl: image.url, storageKey: image.storageKey, title: file.name, width: image.width, height: image.height, bytes: image.bytes, mimeType: image.mimeType };
            }));
            if (multiSelect) setLocalPayloads((current) => [...current, ...uploaded]);
            else {
                uploaded.forEach(onInsert);
                onClose();
            }
        } catch (error) {
            console.error(error);
        } finally {
            setUploading(false);
            if (fileInputRef.current) fileInputRef.current.value = "";
        }
    };
    return (
        <Modal title={multiSelect ? `选择参考图（${selectedPayloads.length}/${multiSelectMax}）` : "选择资产"} open={open} onCancel={onClose} footer={multiSelect ? <div className="flex items-center justify-between"><span className="text-xs opacity-60">需选择 {multiSelectMax} 张图片</span><Button type="primary" disabled={selectedPayloads.length !== multiSelectMax} onClick={confirmMany}>确认替换</Button></div> : null} width={860} destroyOnHidden styles={{ body: { padding: "0 24px 24px", minHeight: 480 } }}>
            <div className="mb-4 flex items-center justify-between gap-3">
                <span className="text-sm opacity-65">可从我的资产选择，或上传电脑中的图片</span>
                <Button icon={<Upload className="size-4" />} loading={uploading} onClick={() => fileInputRef.current?.click()}>
                    上传本地图片
                </Button>
                <input ref={fileInputRef} type="file" accept="image/*" multiple={multiSelect} className="hidden" onChange={(event) => void handleLocalUpload(event.target.files)} />
            </div>
            {localPayloads.length ? (
                <div className="mb-4 rounded-lg border border-blue-200 bg-blue-50/50 p-3 dark:border-blue-900/60 dark:bg-blue-950/20">
                    <div className="mb-2 text-xs font-medium text-blue-700 dark:text-blue-300">本次上传（{localPayloads.length}）</div>
                    <div className="grid grid-cols-4 gap-3">
                        {localPayloads.map((payload, index) => (
                            <div key={`${payload.storageKey || payload.title}-${index}`} className="relative overflow-hidden rounded-lg border border-blue-300 bg-white dark:border-blue-800 dark:bg-stone-900">
                                <img src={payload.dataUrl} alt={payload.title} className="aspect-[4/3] w-full object-cover" />
                                <div className="flex items-center justify-between gap-1 p-2">
                                    <span className="line-clamp-1 text-xs text-stone-700 dark:text-stone-200">{payload.title}</span>
                                    <button type="button" aria-label="移除本地图片" className="shrink-0 rounded p-1 text-stone-400 hover:bg-stone-100 hover:text-stone-700 dark:hover:bg-stone-800 dark:hover:text-stone-200" onClick={() => setLocalPayloads((current) => current.filter((_, currentIndex) => currentIndex !== index))}>
                                        <X className="size-3.5" />
                                    </button>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            ) : null}
            <MyAssetsTab onInsert={onInsert} selectionLimit={multiSelect ? multiSelectMax : undefined} externalSelectedCount={localPayloads.length} onSelectionChange={setAssetPayloads} />
        </Modal>
    );
}

const PAGE_SIZE = 8;

const kindOptions = [
    { label: "全部", value: "all" },
    { label: "文本", value: "text" },
    { label: "图片", value: "image" },
    { label: "视频", value: "video" },
    { label: "音频", value: "audio" },
    { label: "组", value: "group" },
];

function PickerCard({ title, kind, cover, deleted, selected, disabled = false, onClick }: { title: string; kind: string; cover: string; deleted: boolean; selected?: boolean; disabled?: boolean; onClick: () => void }) {
    return (
        <button
            type="button"
            className={cn("group relative overflow-hidden rounded-lg border border-stone-200 bg-white text-left transition dark:border-stone-700 dark:bg-stone-900", selected && "border-blue-500 ring-2 ring-blue-500/30", deleted || disabled ? "cursor-not-allowed opacity-65" : "cursor-pointer hover:border-stone-400 hover:shadow-md dark:hover:border-stone-500")}
            onClick={onClick}
            disabled={deleted || disabled}
        >
            {deleted ? (
                <div className="flex aspect-[4/3] items-center justify-center bg-stone-100 p-3 text-center text-xs text-stone-500 dark:bg-stone-800">资源已删除</div>
            ) : cover ? (
                <img src={cover} alt={title} className="aspect-[4/3] w-full object-cover" />
            ) : (
                <div className="flex aspect-[4/3] items-center justify-center bg-stone-100 p-3 text-center text-xs leading-5 text-stone-500 dark:bg-stone-800 dark:text-stone-400">{title}</div>
            )}
            <div className="p-2.5">
                <div className="flex items-center justify-between gap-2">
                    <span className="line-clamp-1 text-xs font-medium text-stone-800 dark:text-stone-200">{title}</span>
                    <Tag className="m-0 shrink-0 text-[10px]">{kind === "image" ? "图片" : kind === "video" ? "视频" : kind === "audio" ? "音频" : kind === "group" ? "组" : "文本"}</Tag>
                </div>
            </div>
            {!deleted ? <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-stone-950/0 text-sm font-medium text-white opacity-0 transition group-hover:bg-stone-950/55 group-hover:opacity-100">插入</div> : null}
        </button>
    );
}

function MyAssetsTab({ onInsert, selectionLimit, externalSelectedCount = 0, onSelectionChange }: { onInsert: (payload: InsertAssetPayload) => void; selectionLimit?: number; externalSelectedCount?: number; onSelectionChange?: (payloads: InsertAssetPayload[]) => void }) {
    const assets = useAssetStore((state) => state.assets);
    const [keyword, setKeyword] = useState("");
    const [kindFilter, setKindFilter] = useState(selectionLimit ? "image" : "all");
    const [page, setPage] = useState(1);
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const isMultiSelect = Boolean(selectionLimit);

    const filtered = useMemo(() => {
        const query = keyword.trim().toLowerCase();
        return assets
            .filter((a) => a.kind === "text" || a.kind === "image" || a.kind === "video" || a.kind === "audio" || a.kind === "group")
            .filter((a) => kindFilter === "all" || a.kind === kindFilter)
            .filter((a) => !query || [a.title, ...(a.tags || [])].join(" ").toLowerCase().includes(query));
    }, [assets, keyword, kindFilter]);

    const visible = useMemo(() => filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), [filtered, page]);

    useEffect(() => {
        const maxPage = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
        setPage((v) => Math.min(v, maxPage));
    }, [filtered.length]);

    const toPayload = (asset: Asset): InsertAssetPayload => {
        if (asset.kind === "group") {
            return { kind: "group", data: asset.data, title: asset.title };
        } else if (asset.kind === "text") {
            return { kind: "text", content: asset.data.content, title: asset.title };
        } else if (asset.kind === "video") {
            return { kind: "video", url: asset.data.url, storageKey: asset.data.storageKey, title: asset.title, width: asset.data.width, height: asset.data.height };
        } else if (asset.kind === "audio") {
            return { kind: "audio", url: asset.data.url, storageKey: asset.data.storageKey, title: asset.title, durationMs: asset.data.durationMs };
        } else {
            return { kind: "image", dataUrl: asset.data.dataUrl, storageKey: asset.data.storageKey, title: asset.title, width: asset.data.width, height: asset.data.height, bytes: asset.data.bytes, mimeType: asset.data.mimeType };
        }
    };

    const handleInsert = (asset: Asset) => {
        if (!isMultiSelect) {
            onInsert(toPayload(asset));
            return;
        }
        if (asset.kind !== "image") return;
        setSelectedIds((current) => {
            const next = new Set(current);
            if (next.has(asset.id)) next.delete(asset.id);
            else if (next.size + externalSelectedCount < (selectionLimit || 0)) next.add(asset.id);
            onSelectionChange?.(Array.from(next).map((id) => assets.find((item) => item.id === id)).filter((item): item is Asset => Boolean(item)).map(toPayload));
            return next;
        });
    };

    return (
        <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
                <Input
                    className="w-56"
                    size="small"
                    prefix={<Search className="size-3.5 text-stone-400" />}
                    placeholder="搜索资产"
                    value={keyword}
                    allowClear
                    onChange={(e) => {
                        setPage(1);
                        setKeyword(e.target.value);
                    }}
                />
                <div className="flex gap-1.5">
                    {kindOptions.map((opt) => (
                        <Tag.CheckableTag
                            key={opt.value}
                            checked={kindFilter === opt.value}
                            className={cn("prompt-filter-tag", kindFilter === opt.value && "is-active")}
                            onChange={() => {
                                setPage(1);
                                setKindFilter(opt.value);
                            }}
                        >
                            {opt.label}
                        </Tag.CheckableTag>
                    ))}
                </div>
            </div>

            {visible.length ? (
                <div className="grid grid-cols-4 gap-3">
                    {visible.map((asset) => {
                        const selected = selectedIds.has(asset.id);
                        const disabled = isMultiSelect && (asset.kind !== "image" || (selectedIds.size + externalSelectedCount >= (selectionLimit || 0) && !selected));
                        return <PickerCard key={asset.id} title={asset.title} kind={asset.kind} cover={asset.coverUrl || (asset.kind === "image" ? asset.data.dataUrl : "")} deleted={asset.metadata?.resourceDeleted === true} selected={selected} disabled={disabled} onClick={() => handleInsert(asset)} />;
                    })}
                </div>
            ) : (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有资产" className="py-12" />
            )}

            {filtered.length > PAGE_SIZE && (
                <div className="flex justify-center">
                    <Pagination size="small" current={page} pageSize={PAGE_SIZE} total={filtered.length} onChange={setPage} showSizeChanger={false} />
                </div>
            )}
        </div>
    );
}
