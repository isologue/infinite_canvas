"use client";

import { useCallback, useEffect, useState } from "react";
import { App, Button, Input, Modal, Select, Space, Table, Tag } from "antd";
import type { ColumnsType } from "antd/es/table";
import { RefreshCw } from "lucide-react";

import { AdminRequired } from "@/components/layout/admin-required";

type AiCallKind = "image" | "video" | "audio" | "text" | "other";
type AiCallStatus = "pending" | "success" | "failed";

type AiCallLog = {
    id: string;
    userId: string;
    username: string;
    kind: AiCallKind;
    model: string;
    status: AiCallStatus;
    credits: number;
    reason: string;
    requestParams: unknown | null;
    responseResult: unknown | null;
    errorMessage: string | null;
    createdAt: string;
    updatedAt: string;
};

const KIND_META: Record<AiCallKind, { label: string; color: string }> = {
    image: { label: "图片", color: "blue" },
    video: { label: "视频", color: "purple" },
    audio: { label: "音频", color: "cyan" },
    text: { label: "文本", color: "geekblue" },
    other: { label: "其他", color: "default" },
};

const STATUS_META: Record<AiCallStatus, { label: string; color: string }> = {
    pending: { label: "处理中", color: "processing" },
    success: { label: "成功", color: "success" },
    failed: { label: "失败", color: "error" },
};

export default function AdminAiLogsPage() {
    const { message } = App.useApp();
    const [logs, setLogs] = useState<AiCallLog[]>([]);
    const [loading, setLoading] = useState(false);
    const [total, setTotal] = useState(0);
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(20);
    const [kind, setKind] = useState<AiCallKind | undefined>(undefined);
    const [status, setStatus] = useState<AiCallStatus | undefined>(undefined);
    const [keyword, setKeyword] = useState("");
    const [detail, setDetail] = useState<AiCallLog | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const query = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
            if (kind) query.set("kind", kind);
            if (status) query.set("status", status);
            if (keyword.trim()) query.set("keyword", keyword.trim());
            const payload = (await fetch(`/api/admin/ai-logs?${query.toString()}`, { cache: "no-store" }).then((res) => res.json())) as {
                code: number;
                msg?: string;
                data?: { logs?: AiCallLog[]; total?: number };
            };
            if (payload.code !== 0) throw new Error(payload.msg || "加载失败");
            setLogs(payload.data?.logs || []);
            setTotal(payload.data?.total || 0);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "加载失败");
        } finally {
            setLoading(false);
        }
    }, [page, pageSize, kind, status, keyword, message]);

    useEffect(() => {
        void load();
    }, [load]);

    const columns: ColumnsType<AiCallLog> = [
        { title: "时间", dataIndex: "createdAt", key: "createdAt", width: 180, render: (value: string) => new Date(value).toLocaleString("zh-CN") },
        { title: "用户", dataIndex: "username", key: "username", width: 140 },
        {
            title: "类型",
            dataIndex: "kind",
            key: "kind",
            width: 90,
            render: (value: AiCallKind) => <Tag color={KIND_META[value].color}>{KIND_META[value].label}</Tag>,
        },
        { title: "模型", dataIndex: "model", key: "model", ellipsis: true, render: (value: string) => value || <span className="text-stone-400">—</span> },
        {
            title: "状态",
            dataIndex: "status",
            key: "status",
            width: 100,
            render: (value: AiCallStatus) => <Tag color={STATUS_META[value].color}>{STATUS_META[value].label}</Tag>,
        },
        { title: "点数", dataIndex: "credits", key: "credits", width: 80 },
        {
            title: "操作",
            key: "actions",
            width: 90,
            render: (_, record) => (
                <Button size="small" onClick={() => setDetail(record)}>
                    详情
                </Button>
            ),
        },
    ];

    return (
        <AdminRequired>
            <main className="h-full overflow-auto bg-background text-stone-950 dark:text-stone-100">
                <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-10">
                    <div className="flex flex-wrap items-end justify-between gap-4 border-b border-stone-200 pb-6 dark:border-stone-800">
                        <div>
                            <div className="text-xs text-stone-500">超级管理员</div>
                            <h1 className="mt-3 text-3xl font-semibold">AI 调用日志</h1>
                            <p className="mt-2 text-sm text-stone-500">查看所有用户的 AI 生成调用记录，方便管理与排查。</p>
                        </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                        <Select
                            placeholder="全部类型"
                            allowClear
                            value={kind}
                            onChange={(value) => {
                                setKind(value);
                                setPage(1);
                            }}
                            className="w-32"
                            options={(Object.keys(KIND_META) as AiCallKind[]).map((k) => ({ label: KIND_META[k].label, value: k }))}
                        />
                        <Select
                            placeholder="全部状态"
                            allowClear
                            value={status}
                            onChange={(value) => {
                                setStatus(value);
                                setPage(1);
                            }}
                            className="w-32"
                            options={(Object.keys(STATUS_META) as AiCallStatus[]).map((s) => ({ label: STATUS_META[s].label, value: s }))}
                        />
                        <Input.Search
                            placeholder="搜索用户名 / 模型 / 原因"
                            value={keyword}
                            onChange={(event) => setKeyword(event.target.value)}
                            onSearch={() => {
                                setPage(1);
                                void load();
                            }}
                            className="w-72"
                            allowClear
                        />
                        <Button icon={<RefreshCw className="size-4" />} onClick={() => void load()}>
                            刷新
                        </Button>
                    </div>

                    <Table
                        rowKey="id"
                        loading={loading}
                        columns={columns}
                        dataSource={logs}
                        pagination={{
                            current: page,
                            pageSize,
                            total,
                            showSizeChanger: true,
                            showTotal: (count) => `共 ${count} 条`,
                            onChange: (nextPage, nextSize) => {
                                setPage(nextPage);
                                setPageSize(nextSize);
                            },
                        }}
                    />
                </div>

                <Modal title="调用详情" open={Boolean(detail)} footer={null} onCancel={() => setDetail(null)} width={720} destroyOnHidden>
                    {detail ? (
                        <div className="flex flex-col gap-3 text-sm">
                            <DetailRow label="时间" value={new Date(detail.createdAt).toLocaleString("zh-CN")} />
                            <DetailRow label="用户" value={detail.username} />
                            <DetailRow label="类型" value={KIND_META[detail.kind].label} />
                            <DetailRow label="模型" value={detail.model || "—"} />
                            <DetailRow label="状态" value={STATUS_META[detail.status].label} />
                            <DetailRow label="点数" value={String(detail.credits)} />
                            <DetailRow label="原因" value={detail.reason || "—"} />
                            {detail.errorMessage ? <DetailRow label="错误信息" value={detail.errorMessage} /> : null}
                            <MediaPreview userId={detail.userId} kind={detail.kind} result={detail.responseResult} />
                            <DetailBlock label="请求参数" value={detail.requestParams} />
                            <DetailBlock label="返回结果" value={detail.responseResult} />
                            {detail.requestParams === null && detail.responseResult === null ? (
                                <div className="rounded-lg border border-dashed border-stone-200 px-3 py-3 text-xs text-stone-500 dark:border-stone-800">
                                    该记录没有请求参数和返回结果（可能是早期记录，或该次调用未上报）。
                                </div>
                            ) : null}
                        </div>
                    ) : null}
                </Modal>
            </main>
        </AdminRequired>
    );
}

function DetailRow({ label, value }: { label: string; value: string }) {
    return (
        <div className="flex gap-3">
            <div className="w-20 shrink-0 text-stone-500">{label}</div>
            <div className="min-w-0 break-words">{value}</div>
        </div>
    );
}

function DetailBlock({ label, value }: { label: string; value: unknown }) {
    if (value === null || value === undefined) return null;
    return (
        <div className="flex flex-col gap-1">
            <div className="text-stone-500">{label}</div>
            <pre className="max-h-64 overflow-auto rounded-lg bg-stone-100 p-3 text-xs dark:bg-stone-800">{JSON.stringify(value, null, 2)}</pre>
        </div>
    );
}

// 从日志的 responseResult 里抽出媒体的 storageKey。图片是 { items: [{ storageKey }] }，视频是 { storageKey }。
function extractStorageKeys(result: unknown): string[] {
    if (!result || typeof result !== "object") return [];
    const obj = result as Record<string, unknown>;
    const keys: string[] = [];
    if (typeof obj.storageKey === "string") keys.push(obj.storageKey);
    if (Array.isArray(obj.items)) {
        for (const item of obj.items) {
            if (item && typeof item === "object" && typeof (item as Record<string, unknown>).storageKey === "string") {
                keys.push((item as Record<string, unknown>).storageKey as string);
            }
        }
    }
    return keys.filter(Boolean);
}

function MediaPreview({ userId, kind, result }: { userId: string; kind: AiCallKind; result: unknown }) {
    const keys = extractStorageKeys(result);
    if (!keys.length) {
        if (kind === "audio") {
            return <div className="rounded-lg border border-dashed border-stone-200 px-3 py-2 text-xs text-stone-500 dark:border-stone-800">音频调用未记录可回放文件，仅有下方元信息。</div>;
        }
        return null;
    }
    return (
        <div className="flex flex-col gap-2">
            <div className="text-stone-500">生成结果预览</div>
            <div className="flex flex-wrap gap-3">
                {keys.map((key) => (
                    <MediaItem key={key} userId={userId} storageKey={key} kind={kind} />
                ))}
            </div>
        </div>
    );
}

function MediaItem({ userId, storageKey, kind }: { userId: string; storageKey: string; kind: AiCallKind }) {
    const [url, setUrl] = useState<string | null>(null);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        let revoked = false;
        let objectUrl = "";
        void (async () => {
            try {
                const res = await fetch(`/api/admin/storage?userId=${encodeURIComponent(userId)}&key=${encodeURIComponent(storageKey)}`, { cache: "no-store" });
                if (!res.ok) throw new Error("not found");
                const blob = await res.blob();
                if (revoked) return;
                objectUrl = URL.createObjectURL(blob);
                setUrl(objectUrl);
            } catch {
                if (!revoked) setFailed(true);
            }
        })();
        return () => {
            revoked = true;
            if (objectUrl) URL.revokeObjectURL(objectUrl);
        };
    }, [userId, storageKey]);

    if (failed) {
        return <div className="flex h-24 w-24 items-center justify-center rounded-lg border border-dashed border-stone-200 text-center text-xs text-stone-400 dark:border-stone-800">文件已删除</div>;
    }
    if (!url) {
        return <div className="flex h-24 w-24 items-center justify-center rounded-lg bg-stone-100 text-xs text-stone-400 dark:bg-stone-800">加载中…</div>;
    }
    if (kind === "video") {
        return <video src={url} controls className="max-h-64 max-w-full rounded-lg" />;
    }
    if (kind === "audio") {
        return <audio src={url} controls className="w-full" />;
    }
    return (
        <a href={url} target="_blank" rel="noreferrer">
            <img src={url} alt="生成结果" className="max-h-48 rounded-lg border border-stone-200 object-contain dark:border-stone-800" />
        </a>
    );
}
