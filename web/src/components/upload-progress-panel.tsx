"use client";

import { useEffect } from "react";
import { Button, Progress, theme } from "antd";
import { AudioLines, Check, ChevronDown, ChevronUp, File, Image, LoaderCircle, Trash2, Upload, Video, X } from "lucide-react";

import { isUploadActive, useUploadStore, type UploadRecord } from "@/stores/use-upload-store";
import { useUserStore } from "@/stores/use-user-store";

const fileIcons = { image: Image, video: Video, audio: AudioLines, file: File };
const statusLabels = { preparing: "准备文件", uploading: "上传中", processing: "服务器处理中", success: "上传完成", error: "上传失败" };

function formatBytes(bytes: number) {
    return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
}

function UploadRow({ record }: { record: UploadRecord }) {
    const { token } = theme.useToken();
    const Icon = fileIcons[record.kind];
    const active = isUploadActive(record);
    const color = record.status === "error" ? token.colorError : record.status === "success" ? token.colorSuccess : token.colorPrimary;
    return (
        <li className="flex gap-3 px-4 py-3" style={{ borderBottom: `1px solid ${token.colorBorderSecondary}` }}>
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg" style={{ background: token.colorFillSecondary, color }}>
                <Icon size={18} aria-hidden />
            </div>
            <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm" title={record.name}>{record.name}</span>
                    <span className="shrink-0 text-xs tabular-nums" style={{ color }}>
                        {record.status === "success" ? <Check size={14} aria-label="上传完成" /> : record.status === "error" ? <X size={14} aria-label="上传失败" /> : (record.status === "preparing" || (record.status === "processing" && !record.progress)) ? "—" : `${record.progress}%`}
                    </span>
                </div>
                <Progress percent={record.progress} showInfo={false} size="small" status={record.status === "error" ? "exception" : active ? "active" : "success"} strokeColor={color} className="!my-1 !block" />
                <div className="flex items-center gap-1.5 text-xs" style={{ color: token.colorTextSecondary }}>
                    {active ? <LoaderCircle size={11} className="animate-spin" aria-hidden /> : null}
                    <span>{statusLabels[record.status]}</span>
                    {record.bytes ? <span className="ml-auto tabular-nums">{formatBytes(record.bytes)}</span> : null}
                </div>
                {record.error ? <p className="mb-0 mt-1 break-words text-xs" style={{ color: token.colorError }}>{record.error}</p> : null}
            </div>
        </li>
    );
}

export function UploadProgressPanel() {
    const { token } = theme.useToken();
    const userId = useUserStore((state) => state.user?.id);
    const records = useUploadStore((state) => state.records);
    const collapsed = useUploadStore((state) => state.collapsed);
    const hidden = useUploadStore((state) => state.hidden);
    const setCollapsed = useUploadStore((state) => state.setCollapsed);
    const setHidden = useUploadStore((state) => state.setHidden);
    const clearFinished = useUploadStore((state) => state.clearFinished);
    const reset = useUploadStore((state) => state.reset);
    useEffect(() => reset(), [userId, reset]);
    if (!records.length) return null;
    const activeCount = records.filter(isUploadActive).length;
    const failedCount = records.filter((record) => record.status === "error").length;
    const summary = activeCount ? `${activeCount} 个上传中` : failedCount ? `${failedCount} 个失败 · ${records.length} 条记录` : `${records.length} 个已完成`;
    const position = "fixed bottom-5 left-4 z-[90]";
    if (hidden) return (
        <Button className={position} icon={<Upload size={15} />} onClick={() => { setHidden(false); setCollapsed(false); }} aria-label="展开上传记录">
            上传记录 · {summary}
        </Button>
    );
    return (
        <section data-canvas-shortcuts-ignore data-canvas-no-zoom aria-label="上传进度管理器" className={`${position} w-[360px] max-w-[calc(100vw-32px)] overflow-hidden rounded-xl border`} style={{ background: token.colorBgElevated, borderColor: token.colorBorderSecondary, color: token.colorText, boxShadow: token.boxShadowSecondary }}>
            <header className="flex items-center gap-2 px-4 py-3">
                <Upload size={16} style={{ color: token.colorPrimary }} aria-hidden />
                <div className="min-w-0 flex-1">
                    <h2 className="m-0 text-sm font-semibold">上传进度</h2>
                    <p className="m-0 mt-0.5 text-xs" style={{ color: token.colorTextSecondary }} aria-live="polite">{summary}</p>
                </div>
                <Button type="text" size="small" disabled={activeCount === records.length} icon={<Trash2 size={15} />} title="清空已完成记录" aria-label="清空已完成记录" onClick={clearFinished} />
                <Button type="text" size="small" icon={collapsed ? <ChevronUp size={17} /> : <ChevronDown size={17} />} title={collapsed ? "展开上传记录" : "折叠上传记录"} aria-label={collapsed ? "展开上传记录" : "折叠上传记录"} aria-expanded={!collapsed} onClick={() => setCollapsed(!collapsed)} />
                <Button type="text" size="small" icon={<X size={17} />} title="收起面板，上传继续" aria-label="收起上传面板" onClick={() => setHidden(true)} />
            </header>
            {!collapsed ? <ul className="m-0 max-h-[min(340px,50dvh)] list-none overflow-y-auto p-0" style={{ borderTop: `1px solid ${token.colorBorderSecondary}` }}>{records.map((record) => <UploadRow key={record.id} record={record} />)}</ul> : null}
        </section>
    );
}
