"use client";

import { useEffect, useState } from "react";
import type { Key } from "react";
import { App, Button, Drawer, Empty, Image, Input, Select, Space, Statistic, Table, Tag } from "antd";
import type { ColumnsType } from "antd/es/table";
import { Eye, FileText, ImageIcon, Trash2 } from "lucide-react";

import { formatBytes } from "@/lib/image-utils";
import { PromptCover } from "@/components/prompts/prompt-cover";

type Status = "active" | "upstream_missing" | "admin_deleted";
type Item = {
    resourceId: string;
    sourceId: string;
    category: string;
    id: string;
    identityKey: string;
    title: string;
    prompt?: string;
    description?: string;
    coverUrl: string;
    referenceImageUrls: string[];
    tags?: string[];
    status: Status;
    imageCount: number;
    totalBytes: number;
    lastSeenAt: string;
    deletedAt: string;
    updatedAt: string;
};

type SourceOption = { id: string; name: string };

const statusOptions = [
    { label: "全部状态", value: "" },
    { label: "正常", value: "active" },
    { label: "上游已移除", value: "upstream_missing" },
    { label: "管理员已删除", value: "admin_deleted" },
];
const statusLabel: Record<Status, { text: string; color: string }> = {
    active: { text: "正常", color: "success" },
    upstream_missing: { text: "上游已移除", color: "warning" },
    admin_deleted: { text: "管理员已删除", color: "default" },
};

export function PromptResourcesTab() {
    const { message, modal } = App.useApp();
    const [items, setItems] = useState<Item[]>([]);
    const [sources, setSources] = useState<SourceOption[]>([]);
    const [total, setTotal] = useState(0);
    const [totalBytes, setTotalBytes] = useState(0);
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(20);
    const [loading, setLoading] = useState(false);
    const [keyword, setKeyword] = useState("");
    const [sourceId, setSourceId] = useState("");
    const [status, setStatus] = useState("");
    const [selectedKeys, setSelectedKeys] = useState<Key[]>([]);
    const [preview, setPreview] = useState<Item | null>(null);

    const load = async () => {
        setLoading(true);
        try {
            const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
            if (keyword.trim()) params.set("keyword", keyword.trim());
            if (sourceId) params.set("sourceId", sourceId);
            if (status) params.set("status", status);
            const payload = await api(`/api/admin/prompt-resources?${params}`);
            setItems(payload.items || []);
            setSources(payload.sources || []);
            setTotal(payload.total || 0);
            setTotalBytes(Number(payload.totalBytes || 0));
            setSelectedKeys([]);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "提示词资源加载失败");
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => { void load(); }, [page, pageSize, sourceId, status]);

    const remove = (ids: string[]) => {
        modal.confirm({
            title: `删除 ${ids.length} 条提示词？`,
            content: "正文、封面和参考图将被清理，只保留最小删除标记；后续同步不会重新下载这些提示词。",
            okText: "删除",
            okButtonProps: { danger: true },
            cancelText: "取消",
            onOk: async () => {
                await api("/api/admin/prompt-resources", { method: "DELETE", body: JSON.stringify({ ids }) });
                message.success(`已删除 ${ids.length} 条提示词资源`);
                setPreview(null);
                await load();
            },
        });
    };

    const columns: ColumnsType<Item> = [
        { title: "封面", width: 72, render: (_, item) => item.coverUrl ? <PromptCover src={item.coverUrl} alt="" className="size-12 rounded object-cover" /> : <div className="grid size-12 place-items-center rounded bg-stone-100 text-stone-400 dark:bg-stone-900"><ImageIcon className="size-5" /></div> },
        { title: "提示词", render: (_, item) => <div className="min-w-0"><div className="truncate font-medium">{item.title}</div><div className="mt-0.5 line-clamp-2 text-xs text-stone-500">{item.status === "admin_deleted" ? "内容已清理，仅保留删除标记" : item.prompt || item.description || ""}</div></div> },
        { title: "来源", dataIndex: "category", width: 190, ellipsis: true },
        { title: "标签", dataIndex: "tags", width: 220, render: (tags: string[] = []) => tags.length ? <Space size={[0, 4]} wrap>{tags.map((tag) => <Tag key={tag}>{tag}</Tag>)}</Space> : <span className="text-stone-400">-</span> },
        { title: "状态", dataIndex: "status", width: 120, render: (value: Status) => <Tag color={statusLabel[value].color}>{statusLabel[value].text}</Tag> },
        { title: "图片", dataIndex: "imageCount", width: 80, render: (value: number) => `${value} 张` },
        { title: "占用", dataIndex: "totalBytes", width: 100, render: (value: number) => formatBytes(value) },
        { title: "同步时间", dataIndex: "lastSeenAt", width: 180, render: (value: string, item) => value ? new Date(value).toLocaleString("zh-CN") : item.deletedAt ? `删除于 ${new Date(item.deletedAt).toLocaleString("zh-CN")}` : "-" },
        { title: "操作", width: 150, fixed: "right", render: (_, item) => <Space size={4}><Button size="small" type="text" icon={<Eye className="size-3.5" />} disabled={item.status === "admin_deleted"} onClick={() => setPreview(item)}>预览</Button><Button size="small" type="text" danger icon={<Trash2 className="size-3.5" />} disabled={item.status === "admin_deleted"} onClick={() => remove([item.resourceId])}>删除</Button></Space> },
    ];

    return <main className="h-full overflow-auto bg-background px-6 py-6"><div className="mx-auto max-w-[1500px] space-y-5">
        <header className="flex flex-wrap items-center justify-between gap-4 border-b border-stone-200 pb-5 dark:border-stone-800"><div><h2 className="text-xl font-semibold">提示词资源</h2><p className="mt-1 text-xs text-stone-500">提示词正文与图片在同步时写入本站；这里不提供自动清理或按时间清理。</p></div>{selectedKeys.length ? <Button danger icon={<Trash2 className="size-4" />} onClick={() => remove(selectedKeys.map(String))}>删除选中 ({selectedKeys.length})</Button> : null}</header>
        <section className="grid grid-cols-2 gap-3 lg:grid-cols-4"><div className="border-b border-stone-200 px-2 py-3 dark:border-stone-800"><Statistic title="提示词资源总占用" value={formatBytes(totalBytes)} /></div></section>
        <section className="flex flex-wrap items-center gap-2"><Input.Search allowClear className="w-72" placeholder="搜索标题、正文、标签或来源" value={keyword} onChange={(event) => setKeyword(event.target.value)} onSearch={() => { setPage(1); void load(); }} /><Select className="w-48" value={sourceId} options={[{ label: "全部来源", value: "" }, ...sources.map((source) => ({ label: source.name, value: source.id }))]} onChange={(value) => { setPage(1); setSourceId(value); }} /><Select className="w-40" value={status} options={statusOptions} onChange={(value) => { setPage(1); setStatus(value); }} /><Button onClick={() => { setKeyword(""); setSourceId(""); setStatus(""); setPage(1); void load(); }}>重置</Button></section>
        <Table<Item> rowKey="resourceId" loading={loading} columns={columns} dataSource={items} scroll={{ x: 1250 }} rowSelection={{ selectedRowKeys: selectedKeys, onChange: setSelectedKeys, getCheckboxProps: (item) => ({ disabled: item.status === "admin_deleted" }) }} pagination={{ current: page, pageSize, total, showSizeChanger: true, pageSizeOptions: [20, 50, 100], showTotal: (value) => `共 ${value} 项`, onChange: (next, size) => { setPage(next); setPageSize(size); } }} />
    </div><Drawer title={preview?.title || "提示词预览"} open={Boolean(preview)} size="large" onClose={() => setPreview(null)}>{preview ? <div className="space-y-4"><div className="flex gap-3">{preview.coverUrl ? <Image src={preview.coverUrl} alt="" width={160} className="rounded object-cover" /> : null}<div className="min-w-0 flex-1"><Tag color={statusLabel[preview.status].color}>{statusLabel[preview.status].text}</Tag><div className="mt-2 text-sm text-stone-500">{preview.category}</div></div></div><div><div className="mb-2 font-medium">提示词正文</div><pre className="max-h-[42vh] overflow-auto whitespace-pre-wrap rounded bg-stone-100 p-4 text-sm dark:bg-stone-900">{preview.prompt || "无正文"}</pre></div>{preview.referenceImageUrls.length ? <div><div className="mb-2 font-medium">参考图</div><Image.PreviewGroup><div className="grid grid-cols-3 gap-2">{preview.referenceImageUrls.map((url) => <Image key={url} src={url} alt="" className="aspect-square rounded object-cover" />)}</div></Image.PreviewGroup></div> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有参考图" />}</div> : null}</Drawer></main>;
}

async function api(url: string, init?: RequestInit) {
    const response = await fetch(url, { cache: "no-store", ...init, headers: { "content-type": "application/json", ...init?.headers } });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.code !== 0) throw new Error(payload?.msg || "请求失败");
    return payload.data || {};
}
