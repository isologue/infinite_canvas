"use client";

import { App, Button, Input, Segmented, Select, Spin, Tag, Upload } from "antd";
import type { UploadFile, UploadProps } from "antd";
import { Archive, Download, FileImage, FileStack, FileText, Plus, RefreshCw, Sparkles, Trash2, UploadCloud } from "lucide-react";
import { nanoid } from "nanoid";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { WorkbenchLogList, type WorkbenchLogRow } from "@/components/workbench-log-list";
import { useSharedConfigGate } from "@/hooks/use-shared-config-gate";
import { FILE_TASK_POLL_INTERVAL_MS, createEditableFileTask, downloadEditableFile, pollEditableFileTask, storeEditableFileResources } from "@/services/api/editable-files";
import { useConfigStore, useEffectiveConfig, modelOptionLabel, selectableModelsByCapability } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import type { EditableFileKind, EditableFileLog, EditableFileTask, StoredEditableFile } from "@/types/file-generation";

const KIND_OPTIONS = [{ label: "PPTX", value: "ppt" }, { label: "PSD", value: "psd" }, { label: "SVG", value: "svg" }];
const FILE_INFO: Record<EditableFileKind, { title: string; extension: string; icon: typeof FileStack; prompt: string }> = {
    ppt: { title: "演示文稿", extension: "pptx", icon: FileStack, prompt: "制作一份结构清晰、版式精致的中文演示文稿。" },
    psd: { title: "分层设计稿", extension: "psd", icon: FileImage, prompt: "参考提供的素材制作可编辑分层设计稿，并尽可能拆分背景、主体、文字和装饰图层。" },
    svg: { title: "矢量图形", extension: "svg", icon: FileText, prompt: "制作一份结构清晰、便于继续编辑的 SVG 矢量图形。" },
};
const STATUS_LABEL: Record<EditableFileTask["status"], string> = { queued: "排队中", running: "生成中", success: "已完成", error: "失败" };
const MAX_REFERENCE_IMAGES = 4;
const MAX_REFERENCE_BYTES = 32 * 1024 * 1024;

export default function FilesWorkbench() {
    const { message } = App.useApp();
    const config = useEffectiveConfig();
    const configured = useConfigStore((state) => state.config);
    const ready = useConfigStore((state) => state.isAiConfigReady);
    const configReady = useConfigStore((state) => state.configLoaded);
    const openConfig = useSharedConfigGate();
    const dark = useThemeStore((state) => state.theme === "dark");
    const modelOptions = useMemo(() => selectableModelsByCapability(configured, "file").map((value) => ({ label: modelOptionLabel(configured, value), value })), [configured]);
    const [kind, setKind] = useState<EditableFileKind>("ppt");
    const [model, setModel] = useState(configured.fileModel);
    const [prompt, setPrompt] = useState("");
    const [referenceFiles, setReferenceFiles] = useState<File[]>([]);
    const [logs, setLogs] = useState<EditableFileLog[]>([]);
    const [activeId, setActiveId] = useState("");
    const [selectedIds, setSelectedIds] = useState<string[]>([]);
    const [busy, setBusy] = useState(false);
    const [pollingIds, setPollingIds] = useState<string[]>([]);
    const [storingIds, setStoringIds] = useState<string[]>([]);
    const pollTimers = useRef(new Map<string, number>());
    const activePolls = useRef(new Set<string>());
    const logsRef = useRef<EditableFileLog[]>([]);
    const draftImageUrls = useMemo(() => referenceFiles.map((file) => URL.createObjectURL(file)), [referenceFiles]);
    const selectedLog = logs.find((log) => log.id === activeId);

    useEffect(() => { logsRef.current = logs; }, [logs]);

    const storeFiles = useCallback(async (logId: string) => {
        setStoringIds((current) => current.includes(logId) ? current : [...current, logId]);
        try {
            const saved = await storeEditableFileResources(logId);
            setLogs((current) => current.map((log) => log.id === logId ? saved : log));
            if (saved.storageError) message.warning("文件已生成，资源转存失败，可重试");
        } catch (error) {
            const storageError = error instanceof Error ? error.message : "资源转存失败";
            setLogs((current) => current.map((log) => log.id === logId ? { ...log, storageError } : log));
            message.warning("文件已生成，" + storageError);
        } finally {
            setStoringIds((current) => current.filter((id) => id !== logId));
        }
    }, [message]);

    const saveLog = useCallback(async (log: EditableFileLog) => {
        const response = await fetch("/api/user/file-generation-logs", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ log }) });
        const payload = await response.json().catch(() => null);
        if (!response.ok || payload?.code !== 0) throw new Error(payload?.msg || `文件生成记录保存失败（HTTP ${response.status}）`);
        setLogs((current) => [log, ...current.filter((item) => item.id !== log.id)].sort((a, b) => b.createdAt - a.createdAt));
        if (log.status === "success") void storeFiles(log.id);
    }, [storeFiles]);

    const refreshTask = useCallback(async (logId: string, manual = false) => {
        const log = logsRef.current.find((item) => item.id === logId);
        if (!log?.task || activePolls.current.has(logId)) return;
        if (manual) {
            const timer = pollTimers.current.get(logId);
            if (timer !== undefined) window.clearTimeout(timer);
            pollTimers.current.delete(logId);
            activePolls.current.delete(logId);
        }
        let latest = log;
        activePolls.current.add(logId);
        setPollingIds((current) => current.includes(logId) ? current : [...current, logId]);
        try {
            const task = await pollEditableFileTask(config, log.model, log.task);
            const next: EditableFileLog = { ...log, task, status: task.status, error: task.status === "error" ? task.error?.message : undefined };
            latest = next;
            await saveLog(next);
            if (task.status === "queued" || task.status === "running") {
                const timer = window.setTimeout(() => { pollTimers.current.delete(logId); void refreshTask(logId); }, FILE_TASK_POLL_INTERVAL_MS);
                pollTimers.current.set(logId, timer);
            }
        } catch (error) {
            const pollError = error instanceof Error ? error.message : "查询文件任务失败";
            const next = { ...latest, error: pollError };
            setLogs((current) => current.map((item) => item.id === logId ? next : item));
            try { await saveLog(next); } catch (saveError) { message.error(saveError instanceof Error ? saveError.message : pollError); }
            message.error(`${pollError}；已停止自动查询，可手动刷新`);
        } finally {
            activePolls.current.delete(logId);
            setPollingIds((current) => current.filter((id) => id !== logId));
        }
    }, [config, message, saveLog]);

    useEffect(() => {
        let disposed = false;
        void fetch("/api/user/file-generation-logs", { cache: "no-store" }).then(async (response) => {
            const payload = await response.json();
            if (!response.ok || payload?.code !== 0 || !Array.isArray(payload?.data?.logs)) throw new Error(payload?.msg || "文件生成记录读取失败");
            if (!disposed) {
                const loaded = payload.data.logs as EditableFileLog[];
                setLogs(loaded);
                loaded.filter((log) => (log.status === "queued" || log.status === "running") && log.task && !log.error).forEach((log) => {
                    const timer = window.setTimeout(() => { pollTimers.current.delete(log.id); void refreshTask(log.id); }, FILE_TASK_POLL_INTERVAL_MS);
                    pollTimers.current.set(log.id, timer);
                });
            }
        }).catch((error) => { if (!disposed) message.error(error instanceof Error ? error.message : "文件生成记录读取失败"); });
        return () => {
            disposed = true;
            pollTimers.current.forEach((timer) => window.clearTimeout(timer));
            pollTimers.current.clear();
        };
    }, []);

    useEffect(() => () => draftImageUrls.forEach((url) => URL.revokeObjectURL(url)), [draftImageUrls]);

    const handleUpload: UploadProps["beforeUpload"] = (file) => {
        if (!file.type.startsWith("image/")) { message.warning("参考素材仅支持图片"); return Upload.LIST_IGNORE; }
        setReferenceFiles((current) => {
            if (current.length >= MAX_REFERENCE_IMAGES) { message.warning(`最多添加 ${MAX_REFERENCE_IMAGES} 张参考图片`); return current; }
            if (current.reduce((total, item) => total + item.size, 0) + file.size > MAX_REFERENCE_BYTES) { message.warning("参考图片总大小不能超过 32 MiB"); return current; }
            return [...current, file];
        });
        return false;
    };

    const createTask = async () => {
        if (!prompt.trim()) { message.warning("请先填写生成需求"); return; }
        if (!model) { openConfig(true); message.warning("请在渠道模型中配置并选择「文件」能力的模型"); return; }
        try { if (!ready(configured, model)) { openConfig(true); message.warning("请先配置文件模型的 API Key 和 Base URL"); return; } } catch (error) { message.error(error instanceof Error ? error.message : "文件模型配置不可用"); return; }
        if (kind === "psd" && !referenceFiles.length) { message.warning("PSD 生成至少需要一张参考图"); return; }
        setBusy(true);
        const id = nanoid();
        const initial: EditableFileLog = { id, createdAt: Date.now(), kind, title: prompt.trim().replace(/\s+/g, " ").slice(0, 64), prompt: prompt.trim(), model, referenceImageCount: referenceFiles.length, status: "queued" };
        let taskLog: EditableFileLog | undefined;
        try {
            const images = await Promise.all(referenceFiles.map(fileToDataUrl));
            const task = await createEditableFileTask(config, model, { kind, prompt: prompt.trim(), clientTaskId: id, images });
            taskLog = { ...initial, task, status: task.status, error: task.status === "error" ? task.error?.message : undefined };
            await saveLog(taskLog);
            setActiveId(id);
            setPrompt("");
            if (task.status === "queued" || task.status === "running") {
                const timer = window.setTimeout(() => { pollTimers.current.delete(id); void refreshTask(id); }, FILE_TASK_POLL_INTERVAL_MS);
                pollTimers.current.set(id, timer);
            }
            message.success("文件任务已提交");
        } catch (error) {
            const reason = error instanceof Error ? error.message : "文件任务提交失败";
            if (taskLog) {
                const recoverable = { ...taskLog, error: `任务已提交，但记录保存失败：${reason}` };
                setLogs((current) => [recoverable, ...current.filter((item) => item.id !== id)]);
                setActiveId(id);
                try { await saveLog(recoverable); } catch (saveError) { message.error(saveError instanceof Error ? saveError.message : reason); }
                if (taskLog.status === "queued" || taskLog.status === "running") {
                    const timer = window.setTimeout(() => { pollTimers.current.delete(id); void refreshTask(id); }, FILE_TASK_POLL_INTERVAL_MS);
                    pollTimers.current.set(id, timer);
                }
                message.error(recoverable.error);
            } else {
                try { await saveLog({ ...initial, status: "error", error: reason }); } catch { message.error(`${reason}；任务记录保存失败`); }
                message.error(reason);
            }
        } finally { setBusy(false); }
    };

    const startNew = () => { setActiveId(""); setPrompt(""); setReferenceFiles([]); setKind("ppt"); };
    const deleteSelected = async () => {
        if (!selectedIds.length) return;
        const response = await fetch("/api/user/file-generation-logs", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: selectedIds }) });
        const payload = await response.json().catch(() => null);
        if (!response.ok || payload?.code !== 0) { message.error(payload?.msg || "删除记录失败"); return; }
        selectedIds.forEach((id) => { const timer = pollTimers.current.get(id); if (timer !== undefined) window.clearTimeout(timer); pollTimers.current.delete(id); });
        setLogs((current) => current.filter((log) => !selectedIds.includes(log.id)));
        if (selectedIds.includes(activeId)) setActiveId("");
        setSelectedIds([]);
    };

    const rows = useMemo<WorkbenchLogRow[]>(() => logs.map((log) => ({
        id: log.id, title: log.title || FILE_INFO[log.kind].title,
        status: log.status === "success" ? "成功" : log.status === "error" ? "失败" : STATUS_LABEL[log.status],
        statusTone: log.status === "success" ? "success" : log.status === "error" ? "error" : "processing",
        detail: FILE_INFO[log.kind].extension.toUpperCase(), time: new Date(log.createdAt).toLocaleString("zh-CN", { hour12: false }),
    })), [logs]);

    return (
        <main className={`flex h-full min-h-0 flex-col overflow-hidden ${dark ? "bg-neutral-950 text-neutral-100" : "bg-neutral-50 text-neutral-900"}`}>
            <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-y-auto p-3 lg:grid-cols-[300px_minmax(0,1fr)] lg:overflow-hidden xl:grid-cols-[320px_minmax(0,1fr)]">
                <aside className="hidden min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-card p-3 lg:flex">
                    <WorkbenchLogList logs={rows} selectedIds={selectedIds} activeId={activeId} onSelectedIdsChange={setSelectedIds} onCreate={startNew} onDelete={() => void deleteSelected()} onSelect={setActiveId} />
                </aside>
                <section className="min-h-[620px] min-w-0 overflow-y-auto rounded-lg border border-border bg-card p-4 md:p-6 lg:min-h-0">
                    <div className="mx-auto flex min-h-full w-full max-w-5xl flex-col">
                        <header className="mb-7 flex flex-wrap items-start justify-between gap-3 border-b border-border pb-5">
                            <div className="flex items-center gap-3"><span className="flex size-10 items-center justify-center rounded-md bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"><FileStack className="size-5" /></span><div><h1 className="text-lg font-semibold">文件工作台</h1><p className="mt-1 text-xs text-muted-foreground">生成演示文稿、分层设计稿与矢量文件</p></div></div>
                            <div className="flex items-center gap-2 lg:hidden"><Button icon={<Plus className="size-4" />} onClick={startNew}>新建</Button><span className="text-xs text-muted-foreground">{logs.length} 条记录</span></div>
                            <Button icon={<Sparkles className="size-4" />} onClick={() => openConfig(false)}>模型设置</Button>
                        </header>
                        {selectedLog ? <TaskDetail log={selectedLog} polling={pollingIds.includes(selectedLog.id)} onRefresh={() => void refreshTask(selectedLog.id, true)} storing={storingIds.includes(selectedLog.id)} onStore={() => void storeFiles(selectedLog.id)} onDownload={(url, name, stored) => void downloadEditableFile(config, selectedLog.model, url, name, stored).catch((error) => message.error(error instanceof Error ? error.message : "文件下载失败"))} /> : (
                            <>
                                <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
                                    <Segmented value={kind} onChange={(value) => setKind(value as EditableFileKind)} options={KIND_OPTIONS} />
                                    <Select className="min-w-52 max-w-full" value={model || undefined} placeholder="选择文件模型" options={modelOptions} onChange={setModel} notFoundContent="请在渠道设置中添加「文件」能力模型" loading={!configReady} showSearch optionFilterProp="label" />
                                </div>
                                <label className="mb-2 block text-sm font-medium">生成需求</label>
                                <Input.TextArea value={prompt} onChange={(event) => setPrompt(event.target.value)} autoSize={{ minRows: 7, maxRows: 15 }} maxLength={131072} showCount placeholder={FILE_INFO[kind].prompt} className="!resize-y" />
                                <div className="mt-6 flex flex-wrap items-start justify-between gap-4 border-t border-border pt-5">
                                    <div className="min-w-0 flex-1">
                                        <div className="mb-2 flex items-center gap-2 text-sm font-medium"><span>参考图片</span>{kind === "psd" ? <Tag color="red">PSD 必需</Tag> : <span className="text-xs text-muted-foreground">可选</span>}</div>
                                        <Upload accept="image/*" multiple disabled={referenceFiles.length >= MAX_REFERENCE_IMAGES} showUploadList={false} beforeUpload={handleUpload}>
                                            <Button icon={<UploadCloud className="size-4" />}>添加图片</Button>
                                        </Upload>
                                        {referenceFiles.length ? <div className="mt-3 flex flex-wrap gap-2">{referenceFiles.map((file, index) => <div key={`${file.name}-${file.lastModified}-${index}`} className="group relative size-20 overflow-hidden rounded border border-border"><img src={draftImageUrls[index]} alt={file.name} className="size-full object-cover" /><button type="button" aria-label={`移除 ${file.name}`} className="absolute right-1 top-1 rounded bg-black/70 p-1 text-white opacity-0 transition group-hover:opacity-100 focus:opacity-100" onClick={() => setReferenceFiles((current) => current.filter((_, itemIndex) => itemIndex !== index))}><Trash2 className="size-3" /></button></div>)}</div> : null}
                                    </div>
                                    <Button type="primary" size="large" icon={<Sparkles className="size-4" />} loading={busy} onClick={() => void createTask()} className="self-end">开始生成</Button>
                                </div>
                            </>
                        )}
                    </div>
                </section>
            </div>
        </main>
    );
}

function TaskDetail({ log, polling, onRefresh, onDownload, storing, onStore }: { log: EditableFileLog; polling: boolean; onRefresh: () => void; onDownload: (url: string, name: string, stored?: StoredEditableFile) => void; storing: boolean; onStore: () => void }) {
    const info = FILE_INFO[log.kind];
    const Icon = info.icon;
    const task = log.task;
    const pending = log.status === "queued" || log.status === "running";
    return (
        <div className="min-w-0">
            <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border pb-5">
                <div className="min-w-0"><div className="flex items-center gap-2"><Icon className="size-4 shrink-0 text-emerald-700 dark:text-emerald-400" /><h2 className="truncate text-base font-semibold">{log.title || info.title}</h2><Tag color={log.status === "success" ? "success" : log.status === "error" ? "error" : "processing"}>{STATUS_LABEL[log.status]}</Tag></div><p className="mt-2 text-xs text-muted-foreground">{new Date(log.createdAt).toLocaleString("zh-CN", { hour12: false })} · {info.extension.toUpperCase()} · {log.model}</p></div>
                {task && pending ? <Button icon={<RefreshCw className="size-4" />} loading={polling} onClick={onRefresh}>刷新状态</Button> : null}
            </div>
            <div className="mt-5"><h3 className="mb-2 text-sm font-medium">生成需求</h3><p className="whitespace-pre-wrap text-sm leading-7 text-muted-foreground">{log.prompt}</p></div>
            {task && pending ? <div className="mt-8 border-y border-border py-8 text-center"><Spin size="large" /><div className="mt-4 text-sm font-medium">{STATUS_LABEL[task.status]}</div><p className="mt-1 text-xs text-muted-foreground">已运行 {Math.floor(task.elapsed_seconds)} 秒</p>{log.error ? <p role="alert" className="mx-auto mt-4 max-w-xl text-sm text-red-600 dark:text-red-400">{log.error}。自动查询已停止，可手动刷新状态。</p> : null}</div> : null}
            {log.status === "error" ? <div role="alert" className="mt-8 border-y border-red-200 py-6 text-sm text-red-600 dark:border-red-900 dark:text-red-400"><div className="font-medium">文件生成失败</div><p className="mt-2 break-words">{log.error || task?.error?.message || "上游未提供失败原因"}</p>{task?.error?.code ? <p className="mt-1 text-xs">错误码：{task.error.code}</p> : null}</div> : null}
            {log.status === "success" && task?.result?.primary_url ? <div className="mt-8 border-y border-border py-8"><div className="mb-5 flex items-center gap-2"><Icon className="size-5 text-emerald-700 dark:text-emerald-400" /><span className="text-sm font-medium">文件已生成</span></div><div className="flex flex-wrap gap-2"><Button type="primary" icon={<Download className="size-4" />} onClick={() => onDownload(task.result!.primary_url!, `${safeFilename(log.title)}.${info.extension}`, log.files?.primary)}>下载 {info.extension.toUpperCase()}</Button>{task.result.zip_url ? <Button icon={<Archive className="size-4" />} onClick={() => onDownload(task.result!.zip_url!, `${safeFilename(log.title)}-素材.zip`, log.files?.zip)}>下载素材 ZIP</Button> : null}</div>{storing ? <p role="status" className="mt-4 text-xs text-muted-foreground">正在保存资源并按存储配置同步 DAV…</p> : log.storageError || !log.files?.primary || (task.result.zip_url && !log.files?.zip) ? <div className="mt-4"><p role="alert" className="text-xs text-amber-700 dark:text-amber-400">{log.storageError || "资源尚未保存，请保存后保留下载副本。"}</p><Button className="mt-2" size="small" icon={<RefreshCw className="size-3" />} onClick={onStore}>重试转存</Button></div> : <p className="mt-4 text-xs text-muted-foreground">{log.files.primary.url ? "资源已保存，已同步 DAV" : "资源已保存"}</p>}{task.result.conversation_id ? <p className="mt-4 break-all font-mono text-xs text-muted-foreground">任务会话：{task.result.conversation_id}</p> : null}</div> : null}
            {!task && log.status === "error" ? <p className="mt-5 text-xs text-muted-foreground">创建请求未被上游接受，修正问题后可重新提交。</p> : null}
        </div>
    );
}

function fileToDataUrl(file: File): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("参考图片读取失败"));
        reader.onerror = () => reject(new Error(`读取 ${file.name} 失败`));
        reader.readAsDataURL(file);
    });
}

function safeFilename(value: string) {
    return value.replace(/[\u0000-\u001f\u007f\\/:*?"<>|]/g, "_").trim().replace(/[. ]+$/g, "").slice(0, 80) || "generated-file";
}
