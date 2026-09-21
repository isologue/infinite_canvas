import { App, Button, Select, Switch, Tag } from "antd";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { PromptSourceEditorDrawer } from "./prompt-source-editor-drawer";
import { PromptSourceContentModal } from "./prompt-source-content-modal";
import { deletePromptSource, fetchPromptSourceSettings, PROMPT_SOURCE_INTERVALS, refreshAllSources, refreshSource, savePromptSource, togglePromptSource, updatePromptSourceSchedule } from "@/services/api/prompts";
import { createPromptSource, type PromptSource } from "@/services/api/prompt-source-presets";

const SETTINGS_QUERY_KEY = ["prompt-source-settings"];

export function ConfigPromptSources() {
    const { message, modal } = App.useApp();
    const { i18n, t } = useTranslation();
    const queryClient = useQueryClient();
    const settingsQuery = useQuery({ queryKey: SETTINGS_QUERY_KEY, queryFn: fetchPromptSourceSettings });
    const settings = settingsQuery.data;
    const sources = settings?.sources || [];
    const schedule = settings?.schedule || { intervalMinutes: 30, lastFetchedAt: "" };
    const [editingSource, setEditingSource] = useState<PromptSource | null>(null);
    const [viewingId, setViewingId] = useState("");
    const [refreshingId, setRefreshingId] = useState("");
    const [refreshingAll, setRefreshingAll] = useState(false);
    const viewingSource = sources.find((item) => item.id === viewingId) || null;
    const intervalOptions = PROMPT_SOURCE_INTERVALS.map((value) => ({ value, label: t(`config.promptSources.intervals.${intervalKey(value)}`) }));

    const invalidateAll = async () => {
        await Promise.all([
            queryClient.invalidateQueries({ queryKey: SETTINGS_QUERY_KEY }),
            queryClient.invalidateQueries({ queryKey: ["prompts"] }),
            queryClient.invalidateQueries({ queryKey: ["side-panel-prompts"] }),
            queryClient.invalidateQueries({ queryKey: ["admin-prompt-resources"] }),
        ]);
    };

    const handleSave = async (source: PromptSource) => {
        try {
            await savePromptSource(source);
            await invalidateAll();
            message.success(t("common.saved"));
        } catch (error) {
            message.error(error instanceof Error ? error.message : "保存失败");
            throw error;
        }
    };

    const handleDelete = (source: PromptSource) => {
        modal.confirm({
            title: t("config.promptSources.deleteTitle", { name: source.name }),
            content: "删除来源会同时物理删除该来源的全部提示词正文、图片和删除标记，且不可恢复。",
            okText: t("common.delete"),
            okButtonProps: { danger: true },
            cancelText: t("common.cancel"),
            onOk: async () => {
                await deletePromptSource(source.id);
                await invalidateAll();
                message.success("来源及其全部资源已删除");
            },
        });
    };

    const handleRefreshOne = async (source: PromptSource) => {
        setRefreshingId(source.id);
        try {
            const result = await refreshSource(source.id);
            await invalidateAll();
            message.success(t("config.promptSources.refreshed", { name: source.name, count: result.count }));
        } catch (error) {
            await invalidateAll();
            message.error(error instanceof Error ? error.message : t("config.promptSources.refreshFailedCached"));
        } finally {
            setRefreshingId("");
        }
    };

    const handleRefreshAll = async () => {
        setRefreshingAll(true);
        try {
            const result = await refreshAllSources();
            await invalidateAll();
            if (result.failureCount) message.warning(t("config.promptSources.refreshPartial", { success: result.successCount, failed: result.failureCount }));
            else message.success(t("config.promptSources.refreshAllSuccess", { sources: result.successCount, total: result.total }));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("config.promptSources.refreshFailed"));
        } finally {
            setRefreshingAll(false);
        }
    };

    return (
        <div>
            <div className="mb-4 flex flex-wrap items-center justify-end gap-3">
                <Button type="primary" icon={<Plus className="size-4" />} onClick={() => setEditingSource(createPromptSource())}>{t("config.promptSources.add")}</Button>
            </div>
            <div className="space-y-2">
                {sources.map((source) => {
                    const status = settings?.statuses[source.id];
                    return (
                        <div key={source.id} className="rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                            <div className="flex flex-wrap items-start justify-between gap-3">
                                <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-2"><span className="truncate font-medium">{source.name}</span>{status?.lastError ? <Tag color="error" className="m-0">同步失败</Tag> : status?.lastSuccessAt ? <Tag color="success" className="m-0">已同步</Tag> : <Tag className="m-0">未同步</Tag>}</div>
                                    <div className="mt-1 truncate text-xs text-stone-500">{source.url}</div>
                                    <div className="mt-1 text-xs text-stone-500">{status ? `${status.count} 条 · ${status.lastSuccessAt ? new Date(status.lastSuccessAt).toLocaleString(i18n.language) : "暂无成功同步"}` : "暂无同步记录"}</div>
                                    {status?.lastError ? <div className="mt-1 line-clamp-2 text-xs text-red-500">{status.lastError}</div> : null}
                                </div>
                                <Switch checked={source.enabled} onChange={async (enabled) => { try { await togglePromptSource(source.id, enabled); await invalidateAll(); } catch (error) { message.error(error instanceof Error ? error.message : "保存失败"); } }} />
                            </div>
                            <div className="mt-3 flex flex-wrap justify-end gap-2">
                                <Button size="small" icon={<Eye className="size-3.5" />} onClick={() => setViewingId(source.id)}>{t("config.promptSources.view")}</Button>
                                <Button size="small" icon={<RefreshCw className="size-3.5" />} loading={refreshingId === source.id} onClick={() => void handleRefreshOne(source)}>{t("config.promptSources.refresh")}</Button>
                                <Button size="small" icon={<Pencil className="size-3.5" />} onClick={() => setEditingSource(source)}>{t("config.promptSources.edit")}</Button>
                                <Button size="small" danger icon={<Trash2 className="size-3.5" />} onClick={() => handleDelete(source)}>{t("common.delete")}</Button>
                            </div>
                        </div>
                    );
                })}
            </div>
            <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-stone-200 pt-4 dark:border-stone-800">
                <div>
                    <div className="text-sm font-medium">{t("config.promptSources.schedule")}</div>
                    <div className="mt-0.5 text-xs text-stone-500">{schedule.lastFetchedAt ? t("config.promptSources.lastFetched", { time: new Date(schedule.lastFetchedAt).toLocaleString(i18n.language) }) : t("config.promptSources.neverFetched")}</div>
                </div>
                <div className="flex items-center gap-2">
                    <Select className="w-36" value={schedule.intervalMinutes} options={intervalOptions} onChange={async (value) => { await updatePromptSourceSchedule(value); await invalidateAll(); }} />
                    <Button icon={<RefreshCw className="size-4" />} loading={refreshingAll} onClick={() => void handleRefreshAll()}>{t("config.promptSources.refreshAll")}</Button>
                </div>
            </div>
            <PromptSourceEditorDrawer open={Boolean(editingSource)} source={editingSource} onSave={handleSave} onClose={() => setEditingSource(null)} />
            <PromptSourceContentModal source={viewingSource} onClose={() => setViewingId("")} />
        </div>
    );
}

function intervalKey(value: number) {
    if (value === 0) return "disabled";
    if (value === 30) return "minutes30";
    if (value === 60) return "hour1";
    if (value === 360) return "hours6";
    return "hours24";
}
