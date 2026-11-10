"use client";

import { memo, useCallback, useMemo, useState } from "react";
import { Button, Checkbox, Empty, Pagination, Tag, theme } from "antd";
import { CheckSquare, Plus, Trash2 } from "lucide-react";

export type WorkbenchLogRow = {
    id: string;
    title: string;
    status: string;
    statusTone: "success" | "error" | "processing";
    detail: string;
    time: string;
    thumbnails?: string[];
};

type Props = {
    logs: WorkbenchLogRow[];
    selectedIds: string[];
    activeId?: string;
    onSelectedIdsChange: (ids: string[]) => void;
    onCreate: () => void;
    onDelete: () => void;
    onSelect: (id: string) => void;
};

const PAGE_SIZE = 20;

export function WorkbenchLogList({ logs, selectedIds, activeId, onSelectedIdsChange, onCreate, onDelete, onSelect }: Props) {
    const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
    const [page, setPage] = useState(1);
    const allSelected = logs.length > 0 && selected.size === logs.length;
    const { token } = theme.useToken();
    const pageCount = Math.ceil(logs.length / PAGE_SIZE);
    const currentPage = Math.min(page, Math.max(pageCount, 1));
    const visibleLogs = useMemo(() => logs.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE), [logs, currentPage]);

    const toggleAll = useCallback(() => onSelectedIdsChange(allSelected ? [] : logs.map((log) => log.id)), [allSelected, logs, onSelectedIdsChange]);
    const renderRow = useCallback((log: WorkbenchLogRow) => (
        <LogRow
            key={log.id}
            log={log}
            selected={selected.has(log.id)}
            active={activeId === log.id}
            onSelect={onSelect}
            onSelectedIdsChange={onSelectedIdsChange}
            selectedIds={selectedIds}
        />
    ), [activeId, onSelect, onSelectedIdsChange, selected, selectedIds]);

    return (
        <div className="flex h-full min-h-0 flex-col">
            <div className="mb-2 flex items-center justify-between">
                <h2 className="text-sm font-semibold">生成记录</h2>
                <span className="text-xs text-muted-foreground">{logs.length}</span>
            </div>
            <div className="mb-2 flex items-center gap-1">
                <Button size="small" type="text" icon={<Plus className="size-3.5" />} onClick={onCreate}>新建</Button>
                <Button size="small" type="text" icon={<CheckSquare className="size-3.5" />} disabled={!logs.length} onClick={toggleAll}>{allSelected ? "取消" : "全选"}</Button>
                <Button size="small" type="text" danger icon={<Trash2 className="size-3.5" />} disabled={!selected.size} onClick={onDelete}>删除{selected.size ? ` ${selected.size}` : ""}</Button>
            </div>
            <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto">
                {!logs.length ? <div className="flex min-h-48 items-center justify-center"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无生成记录" /></div> : visibleLogs.map(renderRow)}
            </div>
            {pageCount > 1 ? <Pagination className="!mt-2 flex justify-center" size="small" current={currentPage} pageSize={PAGE_SIZE} total={logs.length} showSizeChanger={false} onChange={setPage} /> : null}
            <style jsx global>{`
                .workbench-log-row-active { background: ${token.colorPrimaryBg}; }
            `}</style>
        </div>
    );
}

const LogRow = memo(function LogRow({ log, selected, active, selectedIds, onSelectedIdsChange, onSelect }: {
    log: WorkbenchLogRow;
    selected: boolean;
    active: boolean;
    selectedIds: string[];
    onSelectedIdsChange: (ids: string[]) => void;
    onSelect: (id: string) => void;
}) {
    const toggleSelected = useCallback((checked: boolean) => {
        onSelectedIdsChange(checked ? [...selectedIds, log.id] : selectedIds.filter((id) => id !== log.id));
    }, [log.id, onSelectedIdsChange, selectedIds]);
    const tone = log.statusTone === "success" ? "success" : log.statusTone === "error" ? "error" : "processing";

    return (
        <button
            type="button"
            className={`flex min-h-[68px] w-full items-center gap-2 border-b px-1.5 py-1 text-left transition-colors hover:bg-stone-50 dark:hover:bg-stone-900 ${active ? "workbench-log-row-active" : ""}`}
            onClick={() => onSelect(log.id)}
        >
            <Checkbox checked={selected} onClick={(event) => event.stopPropagation()} onChange={(event) => toggleSelected(event.target.checked)} />
            {log.thumbnails?.length ? <div className="flex shrink-0 gap-1">{log.thumbnails.slice(0, 2).map((src, index) => <img key={index} loading="lazy" src={src} alt="" className="size-9 rounded object-cover" />)}</div> : null}
            <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium leading-5">{log.title || "未命名记录"}</span>
                <span className="mt-0.5 flex min-w-0 items-center gap-1.5">
                    <Tag className="m-0 shrink-0 border-0 px-1 text-[10px] leading-[18px]" color={tone}>{log.status}</Tag>
                    <span className="truncate text-[11px] text-muted-foreground">{log.detail}</span>
                </span>
            </span>
            <time className="shrink-0 text-[10px] text-muted-foreground">{log.time}</time>
        </button>
    );
});
