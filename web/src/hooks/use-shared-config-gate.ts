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
        message.warning("当前为共享配置模式，只有 admin 可以进入配置页面，请联系管理员修改全局配置。");
    };
}
