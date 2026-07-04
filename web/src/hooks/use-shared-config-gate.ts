"use client";

import { App } from "antd";

import { useConfigStore } from "@/stores/use-config-store";

export function useSharedConfigGate() {
    const { message } = App.useApp();
    const canManageConfig = useConfigStore((state) => state.canManageConfig);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);

    return (shouldPromptContinue = false) => {
        if (canManageConfig) {
            openConfigDialog(shouldPromptContinue);
            return;
        }
        message.warning("请先登录后再进行配置。");
    };
}
