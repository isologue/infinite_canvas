"use client";
import { App, Button, Form, Input, Modal, Progress, Segmented, Select, Tabs } from "antd";
import { CircleAlert, Cloud, Plus, RefreshCw, Trash2, Wifi } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ModelPicker } from "@/components/model-picker";
import { fetchChannelModels } from "@/services/api/image";
import { syncAppDataToWebdav, type AppSyncDomainKey, type AppSyncProgressEvent } from "@/services/app-sync";
import { testWebdavConnection, WEBDAV_MANIFEST_FILE_NAME } from "@/services/webdav-sync";
import { audioFormatOptions, audioVoiceOptions, normalizeAudioSpeedValue } from "@/lib/audio-generation";
import { createModelChannel, defaultBaseUrlForApiFormat, filterModelsByCapability, modelOptionLabel, modelOptionsFromChannels, normalizeModelOptionValue, useConfigStore, type AiConfig, type ApiCallFormat, type ModelCapability, type ModelChannel } from "@/stores/use-config-store";
type ModelGroup = {
    capability: ModelCapability;
    modelKey: "imageModel" | "videoModel" | "textModel" | "audioModel";
    modelsKey: "imageModels" | "videoModels" | "textModels" | "audioModels";
    defaultLabel: string;
    optionsLabel: string;
};
type WebdavDomainProgress = {
    label: string;
    stage: string;
    current?: number;
    total?: number;
    status?: "active" | "success" | "exception";
};
const modelGroups: ModelGroup[] = [
    { capability: "image", modelKey: "imageModel", modelsKey: "imageModels", defaultLabel: "榛樿鐢熷浘妯″瀷", optionsLabel: "鐢熷浘妯″瀷鍙€夐」" },
    { capability: "video", modelKey: "videoModel", modelsKey: "videoModels", defaultLabel: "榛樿瑙嗛妯″瀷", optionsLabel: "瑙嗛妯″瀷鍙€夐」" },
    { capability: "text", modelKey: "textModel", modelsKey: "textModels", defaultLabel: "榛樿鏂囨湰妯″瀷", optionsLabel: "鏂囨湰妯″瀷鍙€夐」" },
    { capability: "audio", modelKey: "audioModel", modelsKey: "audioModels", defaultLabel: "榛樿闊抽妯″瀷", optionsLabel: "闊抽妯″瀷鍙€夐」" },
];
const apiFormatOptions: Array<{ label: string; value: ApiCallFormat }> = [
    { label: "OpenAI", value: "openai" },
    { label: "Gemini", value: "gemini" },
];
const webdavDomainKeys: AppSyncDomainKey[] = ["canvas", "assets", "image-workbench", "video-workbench"];
const webdavDomainLabels: Record<AppSyncDomainKey, string> = {
    canvas: "鐢诲竷",
    assets: "鎴戠殑绱犳潗",
    "image-workbench": "鐢熷浘宸ヤ綔鍙?,
    "video-workbench": "瑙嗛鍒涗綔鍙?,
};
function createWebdavDomainProgress(): Record<AppSyncDomainKey, WebdavDomainProgress> {
    return webdavDomainKeys.reduce(
        (progress, key) => ({
            ...progress,
            [key]: { label: webdavDomainLabels[key], stage: "绛夊緟鍚屾" },
        }),
        {} as Record<AppSyncDomainKey, WebdavDomainProgress>,
    );
}
export function AppConfigModal() {
    const { message } = App.useApp();
    const [activeTab, setActiveTab] = useState("channels");
    const [loadingChannelId, setLoadingChannelId] = useState("");
    const [testingWebdav, setTestingWebdav] = useState(false);
    const [syncingWebdav, setSyncingWebdav] = useState(false);
    const [webdavSyncStatus, setWebdavSyncStatus] = useState("");
    const [webdavDomainProgress, setWebdavDomainProgress] = useState(createWebdavDomainProgress);
    const config = useConfigStore((state) => state.config);
    const webdav = useConfigStore((state) => state.webdav);
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const replaceSharedConfig = useConfigStore((state) => state.replaceSharedConfig);
    const updateWebdavConfig = useConfigStore((state) => state.updateWebdavConfig);
    const canManageConfig = useConfigStore((state) => state.canManageConfig);
    const canManageUrl = useConfigStore((state) => state.canManageUrl);
   const lockedBaseUrl = useConfigStore((state) => state.lockedBaseUrl);
     const lockedBaseUrls = useConfigStore((state) => state.lockedBaseUrls);
   const isConfigOpen = useConfigStore((state) => state.isConfigOpen);
    const shouldPromptContinue = useConfigStore((state) => state.shouldPromptContinue);
    const setConfigDialogOpen = useConfigStore((state) => state.setConfigDialogOpen);
    const clearPromptContinue = useConfigStore((state) => state.clearPromptContinue);
    const modelOptions = config.models.map((model) => ({ label: modelOptionLabel(config, model), value: model }));
    const webdavReady = Boolean(webdav.url.trim());
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
            if (!response.ok || payload.code !== 0) throw new Error(payload.msg || "淇濆瓨澶辫触");
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
            message.error(error instanceof Error ? error.message : "淇濆瓨澶辫触");
            return;
        }
        setConfigDialogOpen(false);
        if (!ready) return;
        message.success(shouldPromptContinue ? "閰嶇疆宸蹭繚瀛橈紝鍙互缁х画鎿嶄綔" : "閰嶇疆宸蹭繚瀛?);
        clearPromptContinue();
    };
    const updateChannels = (channels: ModelChannel[]) => {
        const nextConfig = withChannels(config, channels);
        saveConfig(nextConfig);
    };
    const updateChannel = (id: string, patch: Partial<ModelChannel>) => {
        updateChannels(config.channels.map((channel) => (channel.id === id ? { ...channel, ...patch, models: patch.models ? uniqueModels(patch.models) : channel.models } : channel)));
    };
    const updateChannelApiFormat = (channel: ModelChannel, apiFormat: ApiCallFormat) => {
        const baseUrl = !channel.baseUrl.trim() || channel.baseUrl.trim() === defaultBaseUrlForApiFormat(channel.apiFormat) ? defaultBaseUrlForApiFormat(apiFormat) : channel.baseUrl;
        updateChannel(channel.id, { apiFormat, baseUrl });
    };
    const addChannel = () => {
        // 鏅€氱敤鎴锋柊寤烘笭閬撴椂閿佸畾 baseUrl锛堣秴绠″彲鑷敱濉級銆傛湇鍔＄淇濆瓨鏃惰繕浼氬啀寮哄埗鍥炲～涓€娆°€?
        const overrides = canManageUrl ? {} : { baseUrl: lockedBaseUrl };
        updateChannels([...config.channels, createModelChannel({ name: `娓犻亾 ${config.channels.length + 1}`, ...overrides })]);
    };
    const deleteChannel = (id: string) => {
        if (config.channels.length <= 1) {
            message.warning("鑷冲皯淇濈暀涓€涓笭閬?);
            return;
        }
        updateChannels(config.channels.filter((channel) => channel.id !== id));
    };
    const refreshChannelModels = async (channel: ModelChannel) => {
        if (!channel.baseUrl.trim() || !channel.apiKey.trim()) {
            message.error("璇峰厛濉啓璇ユ笭閬撶殑 Base URL 鍜?API Key");
            return;
        }
        setLoadingChannelId(channel.id);
        try {
            const models = await fetchChannelModels(channel);
            updateChannels(config.channels.map((item) => (item.id === channel.id ? { ...item, models } : item)));
            message.success(`${channel.name} 妯″瀷鍒楄〃宸叉洿鏂癭);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "璇诲彇妯″瀷澶辫触");
        } finally {
            setLoadingChannelId("");
        }
    };
    const refreshAllModels = async () => {
        const runnable = config.channels.filter((channel) => channel.baseUrl.trim() && channel.apiKey.trim());
        if (!runnable.length) {
            message.error("璇峰厛濉啓鑷冲皯涓€涓笭閬撶殑 Base URL 鍜?API Key");
            return;
        }
        setLoadingChannelId("all");
        try {
            const entries = await Promise.all(runnable.map(async (channel) => [channel.id, await fetchChannelModels(channel)] as const));
            const modelMap = new Map(entries);
            updateChannels(config.channels.map((channel) => (modelMap.has(channel.id) ? { ...channel, models: modelMap.get(channel.id) || [] } : channel)));
            message.success("妯″瀷鍒楄〃宸叉洿鏂?);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "璇诲彇妯″瀷澶辫触");
        } finally {
            setLoadingChannelId("");
        }
    };
    const updateCapabilityModels = (group: ModelGroup, models: string[]) => {
        const next = uniqueModels(models.map((model) => normalizeModelOptionValue(model, config.channels)).filter(Boolean));
        updateConfig(group.modelsKey, next);
        if (!next.includes(config[group.modelKey])) updateConfig(group.modelKey, next[0] || "");
    };
    const testWebdav = async () => {
        if (!webdavReady) {
            message.error("璇峰厛濉啓 WebDAV 鍦板潃");
            return;
        }
        setTestingWebdav(true);
        try {
            await testWebdavConnection(webdav);
            message.success("WebDAV 杩炴帴鍙敤");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "WebDAV 杩炴帴娴嬭瘯澶辫触");
        } finally {
            setTestingWebdav(false);
        }
    };
    const updateWebdavProgress = (event: AppSyncProgressEvent) => {
        setWebdavSyncStatus(event.stage);
        if (!event.domain) return;
        setWebdavDomainProgress((current) => ({
            ...current,
            [event.domain as AppSyncDomainKey]: {
                label: event.label || webdavDomainLabels[event.domain as AppSyncDomainKey],
                stage: event.stage,
                current: event.current,
                total: event.total,
                status: event.status,
            },
        }));
    };
    const syncWebdav = async () => {
        if (!webdavReady) {
            message.error("璇峰厛濉啓 WebDAV 鍦板潃");
            return;
        }
        setSyncingWebdav(true);
        setWebdavDomainProgress(createWebdavDomainProgress());
        setWebdavSyncStatus("鍑嗗鍚屾");
        try {
            const result = await syncAppDataToWebdav(webdav, updateWebdavProgress);
            updateWebdavConfig("lastSyncedAt", result.syncedAt);
            message.success(`鍚屾瀹屾垚锛?{result.projects} 涓敾甯冿紝${result.assets} 涓礌鏉愶紝${result.imageLogs + result.videoLogs} 鏉¤褰曪紝鏈涓婁紶 ${result.uploadedFiles} 涓枃浠讹紝${formatBytes(result.uploadedBytes)}`);
        } catch (error) {
            setWebdavSyncStatus(error instanceof Error ? error.message : "WebDAV 鍚屾澶辫触");
            message.error(error instanceof Error ? error.message : "WebDAV 鍚屾澶辫触");
        } finally {
            setSyncingWebdav(false);
        }
    };
    return (
        <Modal
            title={
                <div>
                    <div className="text-lg font-semibold">閰嶇疆涓庣敤鎴峰亸濂?/div>
                    <div className="mt-1 text-xs font-normal text-stone-500">娓犻亾鑱氬悎銆佹ā鍨嬮€夋嫨鍜屽悓姝ュ亸濂?/div>
                </div>
            }
            open={isConfigOpen}
            width={980}
            centered
            onCancel={() => setConfigDialogOpen(false)}
            styles={{ body: { maxHeight: "72vh", overflowY: "auto", paddingRight: 12 } }}
            footer={
                <Button type="primary" onClick={() => void finishConfig()}>
                    瀹屾垚
                </Button>
            }
        >
           {!canManageUrl ? <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/30 dark:text-amber-100">娓犻亾鍦板潃锛圔ase URL锛夌敱绠＄悊鍛樼粺涓€閰嶇疆锛屼笉鍙慨鏀癸紱API Key 鍜屽叾浠栧弬鏁颁綘鍙互鑷璋冩暣銆?/div> : null}
            {!canManageUrl ? <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/30 dark:text-amber-100">娓犻亾鍦板潃锛圔ase URL锛夌敱绠＄悊鍛樼粺涓€閰嶇疆锛屽彲浠庡垪琛ㄤ腑閫夋嫨锛汚PI Key 鍜屽叾浠栧弬鏁颁綘鍙互鑷璋冩暣銆?/div> : null}
            <Tabs
                activeKey={activeTab}
                onChange={setActiveTab}
                items={[
                    {
                        key: "channels",
                        label: "娓犻亾",
                        children: (
                            <Form layout="vertical" requiredMark={false}>
                                <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                                    <div className="min-w-0 flex-1">
                                        <div className="flex w-fit max-w-full flex-wrap items-center gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/30 dark:text-amber-100">
                                            <CircleAlert className="size-3.5 shrink-0" />
                                            <span className="font-semibold">閲嶈锛?/span>
                                            <span>鏂板鎴栨媺鍙栨ā鍨嬪悗锛岄渶瑕佸埌鈥滄ā鍨嬧€漈ab 閫夋嫨鍙€夐」鎵嶄細鏄剧ず銆?/span>
                                            <Button type="link" size="small" className="h-auto p-0 text-xs font-semibold text-amber-900 dark:text-amber-100" onClick={() => setActiveTab("models")}>
                                                鍘绘ā鍨嬭缃?
                                            </Button>
                                        </div>
                                    </div>
                                    <div className="flex shrink-0 gap-2">
                                        <Button icon={<RefreshCw className="size-4" />} loading={Boolean(loadingChannelId)} onClick={() => void refreshAllModels()}>
                                            鎷夊彇鍏ㄩ儴
                                        </Button>
                                        <Button type="primary" icon={<Plus className="size-4" />} onClick={addChannel}>
                                            鏂板娓犻亾
                                        </Button>
                                    </div>
                                </div>
                                <div className="space-y-3">
                                    {config.channels.map((channel) => (
                                        <section key={channel.id} className="rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                                            <div className="mb-3 flex items-center justify-between gap-3">
                                                <div className="min-w-0">
                                                    <div className="truncate text-sm font-semibold">{channel.name || "鏈懡鍚嶆笭閬?}</div>
                                                    <div className="mt-1 text-xs text-stone-500">
                                                        {apiFormatLabel(channel.apiFormat)} 路 宸蹭繚瀛?{channel.models.length} 涓ā鍨?
                                                    </div>
                                                </div>
                                                <div className="flex shrink-0 gap-2">
                                                    <Button size="small" loading={loadingChannelId === channel.id} onClick={() => void refreshChannelModels(channel)}>
                                                        鎷夊彇妯″瀷
                                                    </Button>
                                                    <Button size="small" danger icon={<Trash2 className="size-3.5" />} onClick={() => deleteChannel(channel.id)} />
                                                </div>
                                            </div>
                                            <div className="grid gap-4 md:grid-cols-2">
                                                <Form.Item label="娓犻亾鍚嶇О" className="mb-0">
                                                    <Input value={channel.name} onChange={(event) => updateChannel(channel.id, { name: event.target.value })} />
                                                </Form.Item>
                                                <Form.Item label="璋冪敤鏍煎紡" className="mb-0">
                                                    <Select value={channel.apiFormat} options={apiFormatOptions} onChange={(value: ApiCallFormat) => updateChannelApiFormat(channel, value)} />
                                                </Form.Item>
                                                <Form.Item label="Base URL" className="mb-0" extra={!canManageUrl ? "鐢辩鐞嗗憳缁熶竴閰嶇疆" : undefined}>
                                                    {canManageUrl ? (
                                                        <Input value={channel.baseUrl} onChange={(event) => updateChannel(channel.id, { baseUrl: event.target.value })} />
                                                    ) : (
                                                        <Select value={channel.baseUrl} onChange={(value) => updateChannel(channel.id, { baseUrl: value })} options={lockedBaseUrls.map((url) => ({ label: url, value: url }))} />
                                                    )}
                                                </Form.Item>
                                                <Form.Item label="API Key" className="mb-0">
                                                    <Input.Password value={channel.apiKey} onChange={(event) => updateChannel(channel.id, { apiKey: event.target.value })} />
                                                </Form.Item>
                                                <Form.Item label="妯″瀷鍒楄〃" className="mb-0 md:col-span-2">
                                                    <Select mode="tags" showSearch allowClear maxTagCount="responsive" placeholder="杈撳叆妯″瀷鍚嶏紝鎴栫偣鍑绘媺鍙栨ā鍨? value={channel.models} onChange={(models) => updateChannel(channel.id, { models })} />
                                                </Form.Item>
                                            </div>
                                        </section>
                                    ))}
                                </div>
                            </Form>
                        ),
                    },
                    {
                        key: "models",
                        label: "妯″瀷",
                        children: (
                            <Form layout="vertical" requiredMark={false}>
                                <div className="mb-4 rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                                    <div className="text-sm font-semibold">榛樿妯″瀷鍜屽彲閫夐」</div>
                                    <div className="mt-1 text-xs leading-5 text-stone-500">鍙€夐」鍐冲畾鍚勫涓嬫媺妗嗘樉绀哄摢浜涙ā鍨嬶紱鍚屽悕妯″瀷浼氫互鎷彿閲岀殑娓犻亾鍚嶅尯鍒嗐€?/div>
                                </div>
                                <div className="grid gap-4 md:grid-cols-2">
                                    {modelGroups.map((group) => (
                                        <Form.Item key={group.modelsKey} label={group.optionsLabel} className="mb-0">
                                            <Select
                                                mode="tags"
                                                showSearch
                                                allowClear
                                                maxTagCount="responsive"
                                                placeholder={config.models.length ? `璇烽€夋嫨鎴栬緭鍏?${group.optionsLabel}` : "鍏堝埌娓犻亾閲屽～鍐欐垨鎷夊彇妯″瀷"}
                                                value={config[group.modelsKey]}
                                                options={modelOptions}
                                                onChange={(models) => updateCapabilityModels(group, models)}
                                            />
                                        </Form.Item>
                                    ))}
                                </div>
                                <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                                    {modelGroups.map((group) => (
                                        <Form.Item key={group.modelKey} label={group.defaultLabel} className="mb-0">
                                            <ModelPicker config={config} value={config[group.modelKey]} onChange={(model) => updateConfig(group.modelKey, model)} capability={group.capability} fullWidth />
                                        </Form.Item>
                                    ))}
                                </div>
                            </Form>
                        ),
                    },
                    {
                        key: "preferences",
                        label: "鐢熸垚鍋忓ソ",
                        children: (
                            <Form layout="vertical" requiredMark={false}>
                                <div className="grid gap-4 md:grid-cols-4">
                                    <Form.Item label="鐢诲竷榛樿鐢熷浘寮犳暟" extra="鏂板缓鐢诲竷鐢熷浘鍜岄厤缃妭鐐归粯璁や娇鐢紝鍗曚釜鑺傜偣浠嶅彲鍗曠嫭瑕嗙洊銆? className="mb-4">
                                        <Input
                                            type="number"
                                            min={1}
                                            max={15}
                                            value={config.canvasImageCount}
                                            onChange={(event) => updateConfig("canvasImageCount", event.target.value)}
                                            onBlur={(event) => updateConfig("canvasImageCount", normalizeImageCount(event.target.value))}
                                        />
                                    </Form.Item>
                                    <Form.Item label="榛樿闊抽澹伴煶" className="mb-4">
                                        <Select value={config.audioVoice} options={audioVoiceOptions} onChange={(value) => updateConfig("audioVoice", value)} />
                                    </Form.Item>
                                    <Form.Item label="榛樿闊抽鏍煎紡" className="mb-4">
                                        <Select value={config.audioFormat} options={audioFormatOptions} onChange={(value) => updateConfig("audioFormat", value)} />
                                    </Form.Item>
                                    <Form.Item label="榛樿闊抽璇€? className="mb-4">
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
                                <Form.Item label="榛樿闊抽鎸囦护" className="mb-4">
                                    <Input.TextArea rows={2} value={config.audioInstructions} placeholder="渚嬪锛氳嚜鐒躲€佹俯鏆栥€侀€傚悎鏃佺櫧銆? onChange={(event) => updateConfig("audioInstructions", event.target.value)} />
                                </Form.Item>
                                <Form.Item label="绯荤粺鎻愮ず璇? className="mb-0">
                                    <Input.TextArea rows={4} value={config.systemPrompt} placeholder="渚嬪锛氫綘鏄竴浣嶆搮闀胯瑙夊彊浜嬬殑鍒涗綔鑰呫€? onChange={(event) => updateConfig("systemPrompt", event.target.value)} />
                                </Form.Item>
                            </Form>
                        ),
                    },
                    {
                        key: "webdav",
                        label: "WebDAV",
                        children: (
                            <Form layout="vertical" requiredMark={false}>
                                <section className="rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                                    <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
                                        <div>
                                            <div className="flex items-center gap-2 text-sm font-semibold">
                                                <Cloud className="size-4" />
                                                WebDAV 鍚屾
                                            </div>
                                            <div className="mt-1 text-xs text-stone-500">鍚屾鐢诲竷銆佹垜鐨勭礌鏉愩€佺敓鎴愯褰曞拰鏈湴濯掍綋鏂囦欢锛屼笉鍖呭惈 AI API Key锛涙湇鍔′笉鏀寔 CORS 鏃跺彲璧?Next.js 杞彂銆?/div>
                                        </div>
                                        <div className="text-xs text-stone-500">{webdav.lastSyncedAt ? `涓婃鍚屾 ${formatWebdavTime(webdav.lastSyncedAt)}` : "灏氭湭鍚屾"}</div>
                                    </div>
                                    <div className="grid gap-4 md:grid-cols-2">
                                        <Form.Item label="杩炴帴鏂瑰紡" className="mb-4 md:col-span-2">
                                            <Segmented
                                                block
                                                value={webdav.proxyMode}
                                                onChange={(value) => updateWebdavConfig("proxyMode", value as typeof webdav.proxyMode)}
                                                options={[
                                                    { label: "鍓嶇鐩磋繛", value: "direct" },
                                                    { label: "Next.js 杞彂", value: "nextjs" },
                                                ]}
                                            />
                                        </Form.Item>
                                        <Form.Item label="WebDAV 鍦板潃" className="mb-4">
                                            <Input value={webdav.url} placeholder="https://nas.example.com/webdav" onChange={(event) => updateWebdavConfig("url", event.target.value)} />
                                        </Form.Item>
                                        <Form.Item label="杩滅▼鐩綍" extra={`浼氬湪璇ョ洰褰曚笅鎸変笟鍔＄洰褰曚繚瀛橈紝姣忎釜鐩綍鍖呭惈 ${WEBDAV_MANIFEST_FILE_NAME} 鍜?files/`} className="mb-4">
                                            <Input value={webdav.directory} placeholder="infinite-canvas" onChange={(event) => updateWebdavConfig("directory", event.target.value)} />
                                        </Form.Item>
                                        <Form.Item label="鐢ㄦ埛鍚? className="mb-0">
                                            <Input value={webdav.username} autoComplete="username" onChange={(event) => updateWebdavConfig("username", event.target.value)} />
                                        </Form.Item>
                                        <Form.Item label="瀵嗙爜 / 搴旂敤瀵嗙爜" className="mb-0">
                                            <Input.Password value={webdav.password} autoComplete="current-password" onChange={(event) => updateWebdavConfig("password", event.target.value)} />
                                        </Form.Item>
                                    </div>
                                    <div className="mt-4 flex flex-wrap items-center gap-2">
                                        <Button icon={<Wifi className="size-4" />} disabled={!webdavReady || syncingWebdav} loading={testingWebdav} onClick={() => void testWebdav()}>
                                            娴嬭瘯杩炴帴
                                        </Button>
                                        <Button type="primary" icon={<RefreshCw className="size-4" />} disabled={!webdavReady || testingWebdav} loading={syncingWebdav} onClick={() => void syncWebdav()}>
                                            {syncingWebdav ? "鍚屾涓? : "绔嬪嵆鍚屾"}
                                        </Button>
                                        {webdavSyncStatus ? <span className="text-xs text-stone-500">{webdavSyncStatus}</span> : null}
                                    </div>
                                    {syncingWebdav || webdavSyncStatus ? <WebdavProgressGrid progress={webdavDomainProgress} /> : null}
                                </section>
                            </Form>
                        ),
                    },
                ]}
            />
        </Modal>
    );
}
function withChannels(config: AiConfig, channels: ModelChannel[]): AiConfig {
    const models = modelOptionsFromChannels(channels);
    const imageModels = keepOrSuggest(config.imageModels, filterModelsByCapability(models, "image"), models);
    const videoModels = keepOrSuggest(config.videoModels, filterModelsByCapability(models, "video"), models);
    const textModels = keepOrSuggest(config.textModels, filterModelsByCapability(models, "text"), models);
    const audioModels = keepOrSuggest(config.audioModels, filterModelsByCapability(models, "audio"), models);
    return {
        ...config,
        channels,
        models,
        baseUrl: channels[0]?.baseUrl || config.baseUrl,
        apiKey: channels[0]?.apiKey || config.apiKey,
        apiFormat: channels[0]?.apiFormat || config.apiFormat,
        imageModels,
        videoModels,
        textModels,
        audioModels,
        imageModel: normalizeDefaultModel(config.imageModel, imageModels),
        videoModel: normalizeDefaultModel(config.videoModel, videoModels),
        textModel: normalizeDefaultModel(config.textModel, textModels),
        audioModel: normalizeDefaultModel(config.audioModel, audioModels),
    };
}
function keepOrSuggest(current: string[], suggested: string[], allModels: string[]) {
    const available = new Set(allModels);
    const kept = uniqueModels(current).filter((model) => available.has(model));
    return kept.length ? kept : suggested;
}
function normalizeDefaultModel(value: string, options: string[]) {
    if (options.includes(value)) return value;
    return options[0] || value;
}
function normalizeImageCount(value: string) {
    return String(Math.max(1, Math.min(15, Math.floor(Math.abs(Number(value)) || 3))));
}
function uniqueModels(models: string[]) {
    return Array.from(new Set(models.map((model) => model.trim()).filter(Boolean)));
}
function apiFormatLabel(apiFormat: ApiCallFormat) {
    return apiFormat === "gemini" ? "Gemini" : "OpenAI";
}
function formatWebdavTime(value: string) {
    return new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}
function WebdavProgressGrid({ progress }: { progress: Record<AppSyncDomainKey, WebdavDomainProgress> }) {
    return (
        <div className="mt-3 grid gap-2">
            {webdavDomainKeys.map((key) => {
                const item = progress[key];
                const count = item.total ? `${item.current || 0}/${item.total}` : "";
                return (
                    <div key={key} className="rounded-md border border-stone-200 px-3 py-2 dark:border-stone-800">
                        <div className="mb-1 flex min-w-0 items-center justify-between gap-3 text-xs">
                            <span className="shrink-0 font-medium text-stone-700 dark:text-stone-200">{item.label}</span>
                            <span className="min-w-0 truncate text-right text-stone-500">
                                {item.stage}
                                {count ? ` 路 ${count}` : ""}
                            </span>
                        </div>
                        <Progress percent={getWebdavProgressPercent(item)} size="small" status={getWebdavProgressStatus(item)} showInfo={false} />
                    </div>
                );
            })}
        </div>
    );
}
function getWebdavProgressPercent(item: WebdavDomainProgress) {
    if (item.status === "success") return 100;
    if (item.total) return Math.min(100, Math.round(((item.current || 0) / item.total) * 100));
    if (item.status === "exception") return 100;
    if (item.stage === "绛夊緟鍚屾") return 0;
    if (item.stage === "璇诲彇杩滅娓呭崟") return 12;
    if (item.stage === "璇诲彇鏈湴鏁版嵁") return 24;
    if (item.stage === "涓嬭浇缂哄け濯掍綋") return 36;
    if (item.stage === "鍐欏叆鏈湴鍚堝苟缁撴灉") return 58;
    if (item.stage === "涓婁紶鏂板濯掍綋") return 66;
    if (item.stage === "濯掍綋宸查綈鍏? || item.stage === "濯掍綋鏃犻渶涓婁紶") return 74;
    if (item.stage.startsWith("涓婁紶娓呭崟")) return 90;
    return item.status === "active" ? 30 : 0;
}
function getWebdavProgressStatus(item: WebdavDomainProgress): "normal" | "active" | "success" | "exception" {
    if (item.status === "success" || item.status === "exception") return item.status;
    return item.status === "active" ? "active" : "normal";
}
function formatBytes(bytes: number) {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}
