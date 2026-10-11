"use client";

import { App, Button, Checkbox, Form, Input, Modal, Select, Tabs } from "antd";
import { Cloud, Download, Pencil, Plus, RefreshCw, Trash2, Upload, Wifi } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { ModelPicker } from "@/components/model-picker";
import { ChannelEditorDrawer } from "@/components/layout/channel-editor-drawer";
import { ConfigPromptSources } from "@/components/layout/config-prompt-sources";
import { exportAppConfig, importAppConfig } from "@/services/config-file";
import { audioFormatOptions, audioVoiceOptions, normalizeAudioSpeedValue } from "@/lib/audio-generation";
import { createModelChannel, modelOptionsFromChannels, normalizeModelOptionValue, selectableModelsByCapability, useConfigStore, type AiConfig, type ApiCallFormat, type ConfigTabKey, type ModelCapability, type ModelChannel } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";

type ModelGroup = {
    capability: ModelCapability;
    modelKey: "imageModel" | "videoModel" | "textModel" | "audioModel";
    defaultLabel: string;
};

const modelGroups: ModelGroup[] = [
    { capability: "image", modelKey: "imageModel", defaultLabel: "默认生图模型" },
    { capability: "video", modelKey: "videoModel", defaultLabel: "默认视频模型" },
    { capability: "text", modelKey: "textModel", defaultLabel: "默认文本模型" },
    { capability: "audio", modelKey: "audioModel", defaultLabel: "默认音频模型" },
];

export function AppConfigPanel({ showDoneButton = false, initialTab = "channels" }: { showDoneButton?: boolean; initialTab?: ConfigTabKey }) {
    const { message } = App.useApp();
    const configInputRef = useRef<HTMLInputElement>(null);
    const [activeTab, setActiveTab] = useState<ConfigTabKey>(initialTab);
    const [editingChannelId, setEditingChannelId] = useState("");
    const [testingWebdav, setTestingWebdav] = useState(false);
    const [syncingWebdav, setSyncingWebdav] = useState(false);
    const config = useConfigStore((state) => state.config);
    const webdav = useConfigStore((state) => state.webdav);
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const replaceSharedConfig = useConfigStore((state) => state.replaceSharedConfig);
    const updateWebdavConfig = useConfigStore((state) => state.updateWebdavConfig);
    const canManageConfig = useConfigStore((state) => state.canManageConfig);
    const canManageUrl = useConfigStore((state) => state.canManageUrl);
    const canManagePromptSources = useUserStore((state) => state.user?.role === "admin");
    const lockedBaseUrl = useConfigStore((state) => state.lockedBaseUrl);
    const lockedBaseUrls = useConfigStore((state) => state.lockedBaseUrls);
    const lockedBaseUrlOptions = lockedBaseUrls.length ? lockedBaseUrls : lockedBaseUrl ? [lockedBaseUrl] : [];
    const shouldPromptContinue = useConfigStore((state) => state.shouldPromptContinue);
    const setConfigDialogOpen = useConfigStore((state) => state.setConfigDialogOpen);
    const clearPromptContinue = useConfigStore((state) => state.clearPromptContinue);
    const webdavReady = Boolean(webdav.url.trim() && webdav.username.trim() && webdav.publicUrlPrefix.trim() && (webdav.password.trim() || webdav.passwordConfigured));
    const editingChannel = config.channels.find((channel) => channel.id === editingChannelId) || null;
    useEffect(() => setActiveTab((initialTab === "prompt-sources" || initialTab === "webdav") && !canManagePromptSources ? "channels" : initialTab), [canManagePromptSources, initialTab]);
    const saveConfig = (nextConfig: AiConfig) => {
        (Object.keys(nextConfig) as Array<keyof AiConfig>).forEach((key) => updateConfig(key, nextConfig[key]));
    };

    const finishConfig = async () => {
        if (!canManageConfig) {
            setConfigDialogOpen(false);
            return;
        }
        const nextConfig = { ...config };
        const ready = nextConfig.channels.some((channel) => channel.baseUrl.trim() && channel.apiKey.trim() && channel.models.length);
        try {
            const response = await fetch("/api/shared-config", {
                method: "PUT",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ config: nextConfig, webdav }),
            });
            const payload = (await response.json()) as { code?: number; msg?: string; data?: { config?: AiConfig; webdav?: typeof webdav } };
            if (!response.ok || payload.code !== 0) throw new Error(payload.msg || "保存失败");
            if (payload.data?.config && payload.data?.webdav) {
                replaceSharedConfig({
                    config: payload.data.config,
                    webdav: payload.data.webdav,
                    canManage: true,
                    canManageUrl,
                    lockedBaseUrl,
                    lockedBaseUrls,
                });
            } else {
                saveConfig(nextConfig);
            }
        } catch (error) {
            message.error(error instanceof Error ? error.message : "保存失败");
            return;
        }
        setConfigDialogOpen(false);
        if (!ready) return;
        message.success(shouldPromptContinue ? "配置已保存，可以继续操作" : "配置已保存");
        clearPromptContinue();
    };

    const loadConfigFile = async (file: File) => {
        try {
            await importAppConfig(file, canManagePromptSources);
            message.success("配置与用户偏好已导入");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "配置文件读取失败");
        } finally {
            if (configInputRef.current) configInputRef.current.value = "";
        }
    };

    const updateChannels = (channels: ModelChannel[]) => saveConfig(withChannels(config, channels));

    const addChannel = () => {
        // 普通用户新建渠道时锁定 baseUrl，超管可自由填写。
        const overrides = canManageUrl ? {} : { baseUrl: lockedBaseUrl };
        const channel = createModelChannel({ name: `渠道 ${config.channels.length + 1}`, ...overrides });
        updateChannels([...config.channels, channel]);
        setEditingChannelId(channel.id);
    };

    const deleteChannel = (id: string) => {
        if (config.channels.length <= 1) {
            message.warning("至少保留一个渠道");
            return;
        }
        updateChannels(config.channels.filter((channel) => channel.id !== id));
    };

    const saveChannel = (channel: ModelChannel) => {
        updateChannels(config.channels.map((item) => (item.id === channel.id ? channel : item)));
    };

    const testWebdav = async () => {
        if (!webdavReady) {
            message.error("请先填写 WebDAV 地址");
            return;
        }
        setTestingWebdav(true);
        try {
            const response = await fetch("/api/storage/webdav/test", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(webdav) });
            const payload = await response.json() as { code?: number; msg?: string };
            if (!response.ok || payload.code !== 0) throw new Error(payload.msg || "WebDAV 连接测试失败");
            message.success(payload.msg || "WebDAV 连接可用");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "WebDAV 连接测试失败");
        } finally {
            setTestingWebdav(false);
        }
    };

    const syncWebdav = async () => {
        if (!webdavReady) {
            message.error("请先填写 WebDAV 地址");
            return;
        }
        setSyncingWebdav(true);
        try {
            const response = await fetch("/api/storage/webdav/sync", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(webdav) });
            const payload = await response.json() as { code?: number; msg?: string };
            if (!response.ok || payload.code !== 0) throw new Error(payload.msg || "WebDAV 全量同步失败");
            updateWebdavConfig("lastSyncedAt", new Date().toISOString());
            message.success(payload.msg || "WebDAV 全量同步完成");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "WebDAV 全量同步失败");
        } finally {
            setSyncingWebdav(false);
        }
    };

    return (
        <>
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-stone-200 pb-3 dark:border-stone-800">
                <div className="text-xs text-stone-500">JSON 文件包含 API Key{canManagePromptSources ? " 和 WebDAV 凭据" : ""}，请妥善保管。</div>
                <div className="flex gap-2">
                    <Button icon={<Upload className="size-4" />} onClick={() => configInputRef.current?.click()}>
                        导入配置
                    </Button>
                    <Button icon={<Download className="size-4" />} onClick={() => void exportAppConfig(canManagePromptSources).catch((error) => message.error(error instanceof Error ? error.message : "配置导出失败"))}>
                        导出配置
                    </Button>
                    <input ref={configInputRef} type="file" accept="application/json,.json" className="hidden" onChange={(event) => event.target.files?.[0] && void loadConfigFile(event.target.files[0])} />
                </div>
            </div>
            <Tabs
                activeKey={activeTab}
                onChange={(key) => setActiveTab(key as ConfigTabKey)}
                items={[
                    {
                        key: "channels",
                        label: "渠道",
                        children: (
                            <div>
                                <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                                    <div className="text-xs text-stone-500">每个渠道选择一个协议并拉取模型，为每个模型指定能力（生图/视频/文本/音频），并可自定义调用脚本。</div>
                                    <Button type="primary" icon={<Plus className="size-4" />} onClick={addChannel}>
                                        新增渠道
                                    </Button>
                                </div>
                                <div className="space-y-2">
                                    {config.channels.map((channel) => (
                                        <div key={channel.id} className="flex items-center justify-between gap-3 rounded-lg border border-stone-200 px-4 py-3 dark:border-stone-800">
                                            <div className="min-w-0">
                                                <div className="truncate text-sm font-semibold">{channel.name || "未命名渠道"}</div>
                                                <div className="mt-1 truncate text-xs text-stone-500">
                                                    {apiFormatLabel(channel.apiFormat)} · {channel.models.length} 个模型 · {channel.baseUrl || "未填写接口地址"}
                                                </div>
                                            </div>
                                            <div className="flex shrink-0 gap-2">
                                                <Button size="small" icon={<Pencil className="size-3.5" />} onClick={() => setEditingChannelId(channel.id)}>
                                                    编辑
                                                </Button>
                                                <Button size="small" danger icon={<Trash2 className="size-3.5" />} onClick={() => deleteChannel(channel.id)} />
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        ),
                    },
                    {
                        key: "preferences",
                        label: "偏好设置",
                        children: (
                            <Form layout="vertical" requiredMark={false}>
                                <div className="mb-2 text-sm font-semibold">默认模型</div>
                                <div className="mb-4 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                                    {modelGroups.map((group) => (
                                        <Form.Item key={group.modelKey} label={group.defaultLabel} className="mb-0">
                                            <ModelPicker config={config} value={config[group.modelKey]} onChange={(model) => updateConfig(group.modelKey, model)} capability={group.capability} fullWidth />
                                        </Form.Item>
                                    ))}
                                </div>
                                <div className="mb-2 text-sm font-semibold">生成偏好</div>
                                <div className="grid gap-4 md:grid-cols-4">
                                    <Form.Item label="画布默认生图张数" extra="新建画布生图和配置节点默认使用，单个节点仍可单独覆盖。" className="mb-4">
                                        <Input
                                            type="number"
                                            min={1}
                                            max={15}
                                            value={config.canvasImageCount}
                                            onChange={(event) => updateConfig("canvasImageCount", event.target.value)}
                                            onBlur={(event) => updateConfig("canvasImageCount", normalizeImageCount(event.target.value))}
                                        />
                                    </Form.Item>
                                    <Form.Item label="默认音频声音" className="mb-4">
                                        <Select value={config.audioVoice} options={audioVoiceOptions} onChange={(value) => updateConfig("audioVoice", value)} />
                                    </Form.Item>
                                    <Form.Item label="默认音频格式" className="mb-4">
                                        <Select value={config.audioFormat} options={audioFormatOptions} onChange={(value) => updateConfig("audioFormat", value)} />
                                    </Form.Item>
                                    <Form.Item label="默认音频语速" className="mb-4">
                                        <Input
                                            type="number"
                                            min={0.25}
                                            max={4}
                                            step={0.05}
                                            value={config.audioSpeed}
                                            onChange={(event) => updateConfig("audioSpeed", event.target.value)}
                                            onBlur={(event) => updateConfig("audioSpeed", normalizeAudioSpeedValue(event.target.value))}
                                        />
                                    </Form.Item>
                                </div>
                                <Form.Item label="默认音频指令" className="mb-4">
                                    <Input.TextArea rows={2} value={config.audioInstructions} placeholder="例如：自然、温暖、适合旁白。" onChange={(event) => updateConfig("audioInstructions", event.target.value)} />
                                </Form.Item>
                                <Form.Item label="系统提示词" className="mb-0">
                                    <Input.TextArea rows={4} value={config.systemPrompt} placeholder="例如：你是一位擅长视觉叙事的创作者。" onChange={(event) => updateConfig("systemPrompt", event.target.value)} />
                                </Form.Item>
                            </Form>
                        ),
                    },
                    ...(canManagePromptSources
                        ? [
                              {
                                  key: "prompt-sources",
                                  label: "提示词来源",
                                  children: <ConfigPromptSources />,
                              },
                          ]
                        : []),
                    ...(canManagePromptSources
                        ? [{
                            key: "webdav",
                            label: "WebDAV",
                            children: (
                            <Form layout="vertical" requiredMark={false}>
                                <section className="rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                                    <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
                                        <div>
                                            <div className="flex items-center gap-2 text-sm font-semibold">
                                                <Cloud className="size-4" />
                                                媒体存储
                                            </div>
                                            <div className="mt-1 text-xs text-stone-500">生成和上传的图片、视频、音频会保留本地副本，并按配置同步至 WebDAV；公开访问前缀用于生成可直接访问的媒体 URL。</div>
                                        </div>
                                        <div className="text-xs text-stone-500">{webdav.lastSyncedAt ? `上次同步 ${formatWebdavTime(webdav.lastSyncedAt)}` : "尚未同步"}</div>
                                    </div>
                                    <Form.Item className="mb-4">
                                        <Checkbox checked={webdav.enabled} onChange={(event) => updateWebdavConfig("enabled", event.target.checked)}>启用 WebDAV 媒体存储</Checkbox>
                                    </Form.Item>
                                    <Form.Item label="存储模式" className="mb-4">
                                        <Select value={webdav.storageMode} options={[{ value: "local", label: "本地" }, { value: "webdav", label: "WebDAV" }, { value: "local+webdav", label: "本地 + WebDAV" }]} onChange={(value) => updateWebdavConfig("storageMode", value)} />
                                    </Form.Item>
                                    <div className="grid gap-4 md:grid-cols-2">
                                        <Form.Item label="WebDAV URL" className="mb-4 md:col-span-2">
                                            <Input value={webdav.url} placeholder="https://nas.example.com/webdav" onChange={(event) => updateWebdavConfig("url", event.target.value)} />
                                        </Form.Item>
                                        <Form.Item label="用户名" className="mb-4">
                                            <Input value={webdav.username} autoComplete="username" onChange={(event) => updateWebdavConfig("username", event.target.value)} />
                                        </Form.Item>
                                        <Form.Item label="密码" className="mb-4">
                                            <Input.Password value={webdav.password} placeholder={webdav.passwordConfigured ? "已配置，留空不修改" : "请输入密码或应用密码"} autoComplete="new-password" onChange={(event) => updateWebdavConfig("password", event.target.value)} />
                                        </Form.Item>
                                        <Form.Item label="根路径" className="mb-4 md:col-span-2">
                                            <Input value={webdav.directory} placeholder="chatgpt2api/images" onChange={(event) => updateWebdavConfig("directory", event.target.value)} />
                                        </Form.Item>
                                        <Form.Item label="公开访问前缀" className="mb-0 md:col-span-2">
                                            <Input value={webdav.publicUrlPrefix} placeholder="https://cdn.example.com/images" onChange={(event) => updateWebdavConfig("publicUrlPrefix", event.target.value)} />
                                        </Form.Item>
                                    </div>
                                    <div className="mt-4 flex flex-wrap items-center gap-2">
                                        <Button icon={<Wifi className="size-4" />} disabled={!webdavReady || syncingWebdav} loading={testingWebdav} onClick={() => void testWebdav()}>
                                            测试 WebDAV
                                        </Button>
                                        <Button type="primary" icon={<RefreshCw className="size-4" />} disabled={!webdavReady || testingWebdav} loading={syncingWebdav} onClick={() => void syncWebdav()}>
                                            {syncingWebdav ? "同步中" : "全量同步"}
                                        </Button>
                                    </div>
                                </section>
                            </Form>
                            ),
                        }]
                        : []),
                ]}
            />
            {showDoneButton ? (
                <div className="mt-4 flex justify-end">
                    <Button type="primary" onClick={finishConfig}>
                        完成
                    </Button>
                </div>
            ) : null}
            <ChannelEditorDrawer open={Boolean(editingChannel)} channel={editingChannel} canManageUrl={canManageUrl} lockedBaseUrlOptions={lockedBaseUrlOptions} onSave={saveChannel} onClose={() => setEditingChannelId("")} />
        </>
    );
}

export function AppConfigModal() {
    const isConfigOpen = useConfigStore((state) => state.isConfigOpen);
    const configTab = useConfigStore((state) => state.configTab);
    const setConfigDialogOpen = useConfigStore((state) => state.setConfigDialogOpen);
    return (
        <Modal
            title={
                <div>
                    <div className="text-lg font-semibold">配置与用户偏好</div>
                    <div className="mt-1 text-xs font-normal text-stone-500">渠道聚合、默认模型和同步偏好</div>
                </div>
            }
            open={isConfigOpen}
            width={980}
            centered
            onCancel={() => setConfigDialogOpen(false)}
            styles={{ body: { maxHeight: "72vh", overflowY: "auto", paddingRight: 12 } }}
            footer={null}
        >
            <AppConfigPanel showDoneButton initialTab={configTab} />
        </Modal>
    );
}

function withChannels(config: AiConfig, channels: ModelChannel[]): AiConfig {
    const next: AiConfig = {
        ...config,
        channels,
        models: modelOptionsFromChannels(channels),
        baseUrl: channels[0]?.baseUrl || config.baseUrl,
        apiKey: channels[0]?.apiKey || config.apiKey,
        apiFormat: channels[0]?.apiFormat || config.apiFormat,
        imageResponseFormat: channels[0]?.imageResponseFormat || "url",
        referenceImageRequestFormat: channels[0]?.referenceImageRequestFormat || "json",
    };
    return {
        ...next,
        imageModel: pickDefaultModel(next, "image", config.imageModel),
        videoModel: pickDefaultModel(next, "video", config.videoModel),
        textModel: pickDefaultModel(next, "text", config.textModel),
        audioModel: pickDefaultModel(next, "audio", config.audioModel),
    };
}

function pickDefaultModel(config: AiConfig, capability: ModelCapability, current: string) {
    const options = selectableModelsByCapability(config, capability);
    const normalized = normalizeModelOptionValue(current, config.channels);
    return options.includes(normalized) ? normalized : options[0] || "";
}

function normalizeImageCount(value: string) {
    return String(Math.max(1, Math.min(500, Math.floor(Math.abs(Number(value)) || 3))));
}

function apiFormatLabel(apiFormat: ApiCallFormat) {
    if (apiFormat === "gemini") return "Gemini";
    if (apiFormat === "minimax") return "MiniMax H3";
    return "OpenAI";
}

function formatWebdavTime(value: string) {
    return new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}
