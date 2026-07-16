"use client";

import { useEffect, useMemo, useState } from "react";
import type { Key } from "react";
import { App, Button, DatePicker, Drawer, Form, Image, Input, InputNumber, Modal, Select, Space, Statistic, Table, Tag } from "antd";
import type { ColumnsType } from "antd/es/table";
import { Download, Eye, FileText, FilterX, ImageIcon, Music2, Play, Settings2, Trash2 } from "lucide-react";

import { AdminRequired } from "@/components/layout/admin-required";
import { formatBytes } from "@/lib/image-utils";

type ResourceKind = "image" | "video" | "audio" | "text";
type Resource = { userId: string; resourceId: string; kind: ResourceKind; storageKey: string; title: string; mimeType: string; bytes: number; source: string; isSaved: boolean; createdAt: string; username: string; displayName: string };
type Settings = { imageDays: number; videoDays: number; audioDays: number; textDays: number; lastRunAt: string | null; lastResult?: unknown };
type UserOption = { id: string; username: string; displayName: string };

const kindOptions = [
    { label: "全部类型", value: "" },
    { label: "图片", value: "image" },
    { label: "视频", value: "video" },
    { label: "音频", value: "audio" },
    { label: "文本", value: "text" },
];
const kindLabel: Record<ResourceKind, string> = { image: "图片", video: "视频", audio: "音频", text: "文本" };
const kindColor: Record<ResourceKind, string> = { image: "blue", video: "purple", audio: "cyan", text: "gold" };

export default function AdminResourcesPage() {
    const { message, modal } = App.useApp();
    const [form] = Form.useForm<Settings>();
    const [items, setItems] = useState<Resource[]>([]);
    const [users, setUsers] = useState<UserOption[]>([]);
    const [stats, setStats] = useState<Array<{ kind: ResourceKind; count: number; bytes: number }>>([]);
    const [total, setTotal] = useState(0);
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(20);
    const [loading, setLoading] = useState(false);
    const [selectedKeys, setSelectedKeys] = useState<Key[]>([]);
    const [keyword, setKeyword] = useState("");
    const [kind, setKind] = useState("");
    const [saved, setSaved] = useState("");
    const [userId, setUserId] = useState("");
    const [source, setSource] = useState("");
    const [dates, setDates] = useState<any>(null);
    const [preview, setPreview] = useState<Resource | null>(null);
    const [previewText, setPreviewText] = useState("");
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [settings, setSettings] = useState<Settings | null>(null);
    const [clearOpen, setClearOpen] = useState(false);
    const [clearText, setClearText] = useState("");

    const load = async () => {
        setLoading(true);
        try {
            const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
            if (keyword.trim()) params.set("keyword", keyword.trim());
            if (kind) params.set("kind", kind);
            if (saved) params.set("saved", saved);
            if (userId) params.set("userId", userId);
            if (source.trim()) params.set("source", source.trim());
            if (dates?.[0]) params.set("from", dates[0].startOf("day").toISOString());
            if (dates?.[1]) params.set("to", dates[1].endOf("day").toISOString());
            const payload = await api(`/api/admin/resources?${params}`);
            setItems(payload.data?.items || []);
            setTotal(payload.data?.total || 0);
            setStats(payload.data?.stats || []);
            setSelectedKeys([]);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "资源加载失败");
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => void load(), [page, pageSize, kind, saved, userId, source, dates]);
    useEffect(() => {
        void api("/api/admin/users").then((payload) => setUsers(payload.data?.users || [])).catch(() => undefined);
    }, []);

    useEffect(() => {
        setPreviewText("");
        if (preview?.kind !== "text") return;
        const controller = new AbortController();
        void fetch(contentUrl(preview), { cache: "no-store", signal: controller.signal }).then((response) => response.ok ? response.text() : Promise.reject()).then(setPreviewText).catch(() => {
            if (!controller.signal.aborted) setPreviewText("文本资源读取失败");
        });
        return () => controller.abort();
    }, [preview]);
    const deleteItems = async (resources: Resource[]) => {
        await api("/api/admin/resources", { method: "DELETE", body: JSON.stringify({ resources: resources.map(({ userId, resourceId }) => ({ userId, resourceId })) }) });
        message.success(`已删除 ${resources.length} 个资源`);
        await load();
    };
    const confirmDelete = (resources: Resource[]) => modal.confirm({ title: `删除 ${resources.length} 个资源？`, content: "资源会被物理删除，引用它的画布节点和素材卡片将显示“资源已删除”。", okText: "强制删除", cancelText: "取消", okButtonProps: { danger: true }, onOk: () => deleteItems(resources) });

    const columns: ColumnsType<Resource> = [
        { title: "类型", dataIndex: "kind", width: 80, render: (value: ResourceKind) => <Tag color={kindColor[value]}>{kindLabel[value]}</Tag> },
        { title: "预览", key: "preview", width: 64, render: (_, row) => row.kind === "image" ? <img src={contentUrl(row)} alt="" loading="lazy" className="size-10 rounded object-cover" /> : <div className="flex size-10 items-center justify-center text-stone-400">{row.kind === "video" ? <Play className="size-5" /> : row.kind === "audio" ? <Music2 className="size-5" /> : row.kind === "text" ? <FileText className="size-5" /> : <ImageIcon className="size-5" />}</div> },
        { title: "资源", dataIndex: "title", ellipsis: true, render: (_, row) => <div className="min-w-0"><div className="truncate font-medium">{row.title || row.resourceId}</div><div className="truncate text-xs text-stone-500">{row.mimeType || "text/plain"}</div></div> },
        { title: "用户", dataIndex: "username", width: 150, render: (_, row) => <div><div>{row.displayName || row.username}</div><div className="text-xs text-stone-500">{row.username}</div></div> },
        { title: "来源", dataIndex: "source", width: 110, render: (value) => value || "-" },
        { title: "素材", dataIndex: "isSaved", width: 90, render: (value) => value ? <Tag color="green">已存素材</Tag> : <span className="text-stone-400">否</span> },
        { title: "大小", dataIndex: "bytes", width: 100, render: (value) => formatBytes(value) || "-" },
        { title: "创建时间", dataIndex: "createdAt", width: 170, render: (value) => new Date(value).toLocaleString("zh-CN") },
        { title: "操作", key: "actions", width: 150, fixed: "right", render: (_, row) => <Space size={4}><Button type="text" icon={<Eye className="size-4" />} onClick={() => setPreview(row)} aria-label="预览"/><Button type="text" icon={<Download className="size-4" />} href={contentUrl(row, true)} aria-label="下载"/><Button danger type="text" icon={<Trash2 className="size-4" />} onClick={() => confirmDelete([row])} aria-label="删除"/></Space> },
    ];

    const statMap = useMemo(() => new Map(stats.map((item) => [item.kind, item])), [stats]);
    const openSettings = async () => {
        const payload = await api("/api/admin/resources/settings");
        const value = payload.data?.settings as Settings;
        setSettings(value);
        form.setFieldsValue(value);
        setSettingsOpen(true);
    };
    const saveSettings = async () => {
        const values = await form.validateFields();
        const payload = await api("/api/admin/resources/settings", { method: "PUT", body: JSON.stringify(values) });
        setSettings(payload.data?.settings);
        setSettingsOpen(false);
        message.success("自动清理设置已保存");
    };
    const runCleanup = async () => {
        await api("/api/admin/resources/cleanup", { method: "POST" });
        message.success("资源清理已完成");
        await load();
    };
    const clearAll = async () => {
        await api("/api/admin/resources/all", { method: "DELETE", body: JSON.stringify({ confirm: clearText }) });
        setClearOpen(false);
        setClearText("");
        message.success("全部资源已清空");
        await load();
    };

    return <AdminRequired><main className="h-full overflow-auto bg-background px-6 py-6"><div className="mx-auto max-w-[1500px] space-y-5">
        <header className="flex flex-wrap items-center justify-between gap-4 border-b border-stone-200 pb-5 dark:border-stone-800"><h1 className="text-2xl font-semibold">资源管理</h1><Space wrap><Button icon={<Play className="size-4" />} onClick={() => void runCleanup()}>立即清理</Button><Button icon={<Settings2 className="size-4" />} onClick={() => void openSettings()}>自动清理</Button><Button danger icon={<Trash2 className="size-4" />} onClick={() => setClearOpen(true)}>清空全部</Button></Space></header>
        <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">{(["image", "video", "audio", "text"] as ResourceKind[]).map((value) => <div key={value} className="border-b border-stone-200 px-2 py-3 dark:border-stone-800"><Statistic title={kindLabel[value]} value={statMap.get(value)?.count || 0} suffix={<span className="text-xs text-stone-400">{formatBytes(statMap.get(value)?.bytes || 0)}</span>} /></div>)}</section>
        <section className="flex flex-wrap items-center gap-2"><Input.Search allowClear className="w-72" placeholder="搜索标题、用户、Storage Key" value={keyword} onChange={(e) => setKeyword(e.target.value)} onSearch={() => { setPage(1); void load(); }} /><Select className="w-32" value={kind} options={kindOptions} onChange={(value) => { setPage(1); setKind(value); }} /><Select className="w-32" value={saved} options={[{label:"全部素材状态",value:""},{label:"已存素材",value:"true"},{label:"未存素材",value:"false"}]} onChange={(value) => { setPage(1); setSaved(value); }} /><Select allowClear showSearch optionFilterProp="label" className="w-44" placeholder="全部用户" value={userId || undefined} options={users.map((user) => ({ label: `${user.displayName} (${user.username})`, value: user.id }))} onChange={(value) => { setPage(1); setUserId(value || ""); }} /><Input allowClear className="w-32" placeholder="来源" value={source} onChange={(event) => { setPage(1); setSource(event.target.value); }} /><DatePicker.RangePicker value={dates} onChange={(value) => { setPage(1); setDates(value); }} /><Button icon={<FilterX className="size-4" />} onClick={() => { setKeyword(""); setKind(""); setSaved(""); setUserId(""); setSource(""); setDates(null); setPage(1); }}>重置</Button>{selectedKeys.length ? <Button danger icon={<Trash2 className="size-4" />} onClick={() => confirmDelete(items.filter((item) => selectedKeys.includes(`${item.userId}:${item.resourceId}`)))}>删除选中 ({selectedKeys.length})</Button> : null}</section>
        <Table<Resource> rowKey={(row) => `${row.userId}:${row.resourceId}`} loading={loading} columns={columns} dataSource={items} scroll={{ x: 1100 }} rowSelection={{ selectedRowKeys: selectedKeys, onChange: setSelectedKeys }} pagination={{ current: page, pageSize, total, showSizeChanger: true, pageSizeOptions: [20,50,100], showTotal: (value) => `共 ${value} 项`, onChange: (next, size) => { setPage(next); setPageSize(size); } }} />
    </div></main>
    <Drawer title="资源预览" open={Boolean(preview)} size="large" onClose={() => setPreview(null)}>{preview ? <div className="space-y-4">{preview.kind === "image" ? <Image src={contentUrl(preview)} alt={preview.title} className="max-h-[65vh] object-contain" /> : preview.kind === "video" ? <video src={contentUrl(preview)} controls preload="metadata" className="max-h-[65vh] w-full bg-black" /> : preview.kind === "audio" ? <audio src={contentUrl(preview)} controls className="w-full" /> : <pre className="max-h-[65vh] overflow-auto whitespace-pre-wrap rounded bg-stone-100 p-4 text-sm dark:bg-stone-900">{previewText || "加载中..."}</pre>}<Button icon={<Download className="size-4" />} href={contentUrl(preview, true)}>下载原文件</Button></div> : null}</Drawer>
    <Modal title="自动清理设置" open={settingsOpen} onCancel={() => setSettingsOpen(false)} onOk={() => void saveSettings()} okText="保存" cancelText="取消"><Form form={form} layout="vertical"><div className="grid grid-cols-2 gap-x-4"><Form.Item name="imageDays" label="图片保留天数"><InputNumber min={0} max={36500} className="w-full" /></Form.Item><Form.Item name="videoDays" label="视频保留天数"><InputNumber min={0} max={36500} className="w-full" /></Form.Item><Form.Item name="audioDays" label="音频保留天数"><InputNumber min={0} max={36500} className="w-full" /></Form.Item><Form.Item name="textDays" label="文本保留天数"><InputNumber min={0} max={36500} className="w-full" /></Form.Item></div><p className="text-xs text-stone-500">0 表示关闭。自动清理每天执行一次，已加入“我的素材”的资源不会自动删除。</p>{settings?.lastRunAt ? <p className="mt-2 text-xs text-stone-500">上次执行：{new Date(settings.lastRunAt).toLocaleString("zh-CN")}</p> : null}</Form></Modal>
    <Modal title="清空全部资源" open={clearOpen} onCancel={() => setClearOpen(false)} onOk={() => void clearAll()} okText="永久清空" okButtonProps={{ danger: true, disabled: clearText !== "清空全部资源" }} cancelText="取消"><p className="mb-3 text-sm text-stone-600 dark:text-stone-300">这会删除所有用户的全部资源，包括已加入“我的素材”的资源。画布节点和素材卡片会保留并显示资源已删除。</p><Input value={clearText} onChange={(e) => setClearText(e.target.value)} placeholder="请输入：清空全部资源" /></Modal>
    </AdminRequired>;
}

function contentUrl(resource: Resource, download = false) {
    return `/api/admin/resources/${encodeURIComponent(resource.resourceId)}/content?userId=${encodeURIComponent(resource.userId)}${download ? "&download=1" : resource.kind === "image" ? "&preview=1" : ""}`;
}

async function api(url: string, init?: RequestInit) {
    const response = await fetch(url, { cache: "no-store", ...init, headers: { "content-type": "application/json", ...init?.headers } });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.code !== 0) throw new Error(payload?.msg || "请求失败");
    return payload;
}
