import { saveAs } from "file-saver";

import { useConfigStore, type AiConfig, type WebdavSyncConfig } from "@/stores/use-config-store";
import { usePromptSourceStore, type PromptSourceSchedule } from "@/stores/use-prompt-source-store";
import type { PromptSource } from "@/services/api/prompt-source-presets";

type AppConfigFile = {
    app: "infinite-canvas";
    version: 1;
    exportedAt: string;
    config: AiConfig;
    webdav: WebdavSyncConfig;
    promptSources?: {
        sources: PromptSource[];
        schedule: PromptSourceSchedule;
    };
};

export function exportAppConfig(includePromptSources = false) {
    const { config, webdav } = useConfigStore.getState();
    const data: AppConfigFile = { app: "infinite-canvas", version: 1, exportedAt: new Date().toISOString(), config, webdav };
    if (includePromptSources) {
        const { sources, schedule } = usePromptSourceStore.getState();
        data.promptSources = { sources, schedule };
    }
    saveAs(new Blob([JSON.stringify(data, null, 2)], { type: "application/json;charset=utf-8" }), "infinite-canvas-config.json");
}

export async function importAppConfig(file: File, includePromptSources = false) {
    let data: AppConfigFile;
    try {
        data = JSON.parse(await file.text()) as AppConfigFile;
    } catch {
        throw new Error("配置文件格式不正确");
    }
    if (data.app !== "infinite-canvas" || data.version !== 1 || !data.config || !data.webdav) throw new Error("配置文件格式不正确");
    useConfigStore.setState({ config: data.config, webdav: data.webdav });
    if (includePromptSources && data.promptSources) usePromptSourceStore.setState(data.promptSources);
}
