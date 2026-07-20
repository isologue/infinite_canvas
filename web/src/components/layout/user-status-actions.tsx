"use client";

import type { CSSProperties } from "react";
import { Keyboard, LogIn, LogOut, Puzzle, Settings2 } from "lucide-react";
import { useState } from "react";
import { App } from "antd";

import { AboutModal } from "@/components/layout/about-modal";
import { AnimatedThemeToggler } from "@/components/ui/animated-theme-toggler";
import { LoginModal } from "@/components/layout/login-modal";
import { flushPendingUserData, reloadUserScopedData } from "@/services/session-reload";
import { canvasThemes } from "@/lib/canvas-theme";
import { useConfigStore } from "@/stores/use-config-store";
import { useSharedConfigGate } from "@/hooks/use-shared-config-gate";
import { useThemeStore } from "@/stores/use-theme-store";
import { useUserStore } from "@/stores/use-user-store";

type UserStatusActionsProps = {
    showConfig?: boolean;
    variant?: "default" | "canvas";
    onOpenShortcuts?: () => void;
    onOpenPlugins?: () => void;
};

export function UserStatusActions({ showConfig = true, variant = "default", onOpenShortcuts, onOpenPlugins }: UserStatusActionsProps) {
    const { message } = App.useApp();
    const [loginOpen, setLoginOpen] = useState(false);
    const theme = useThemeStore((state) => state.theme);
    const setTheme = useThemeStore((state) => state.setTheme);
    const user = useUserStore((state) => state.user);
    const clearSession = useUserStore((state) => state.clearSession);
    const openConfigDialog = useSharedConfigGate();
    const canManageConfig = useConfigStore((state) => state.canManageConfig);
    const canvasTheme = canvasThemes[theme];
    const naturalIconClass = "inline-flex size-7 shrink-0 items-center justify-center text-stone-600 transition hover:text-stone-950 dark:text-stone-300 dark:hover:text-white [&_svg]:size-4";
    const iconStyle: CSSProperties | undefined = variant === "canvas" ? { color: canvasTheme.node.text } : undefined;

    const reloadSharedConfig = async () => {
        const shared = await fetch("/api/shared-config", { cache: "no-store" })
            .then((res) => res.json() as Promise<{ data?: { config?: unknown; webdav?: unknown; canManage?: boolean; canManageUrl?: boolean; lockedBaseUrl?: string; lockedBaseUrls?: string[] } }>)
            .catch(() => null);
        if (shared?.data?.config && shared.data.webdav) {
            useConfigStore.getState().replaceSharedConfig({
                config: shared.data.config as never,
                webdav: shared.data.webdav as never,
                canManage: Boolean(shared.data.canManage),
                canManageUrl: Boolean(shared.data.canManageUrl),
                lockedBaseUrl: shared.data.lockedBaseUrl,
                lockedBaseUrls: shared.data.lockedBaseUrls,
            });
        }
    };

    const logout = async () => {
        // 先把待保存的画布刷到服务端（此时 cookie 仍在），再清 cookie，避免丢掉最后一笔编辑。
        await flushPendingUserData();
        await fetch("/api/auth/logout", { method: "POST" }).catch(() => null);
        clearSession();
        await reloadUserScopedData();
        await reloadSharedConfig();
        message.success("已退出登录");
    };

    return (
        <>
            <div className="inline-flex shrink-0 items-center gap-1">
                {onOpenPlugins ? (
                    <button type="button" className={naturalIconClass} style={iconStyle} onClick={onOpenPlugins} aria-label="节点插件" title="节点插件">
                        <Puzzle className="size-4" />
                    </button>
                ) : null}
                {showConfig && canManageConfig ? (
                    <button type="button" className={naturalIconClass} style={iconStyle} onClick={() => openConfigDialog(false)} aria-label="配置" title="配置">
                        <Settings2 className="size-4" />
                    </button>
                ) : null}
                <AnimatedThemeToggler theme={theme} onThemeChange={setTheme} className={naturalIconClass} style={iconStyle} aria-label={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"} title={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"} />
                <AboutModal style={iconStyle} />
                {user ? (
                    <button type="button" className={naturalIconClass} style={iconStyle} onClick={() => void logout()} aria-label="退出登录" title={`退出登录（${user.username}）`}>
                        <LogOut className="size-4" />
                    </button>
                ) : (
                    <button type="button" className={naturalIconClass} style={iconStyle} onClick={() => setLoginOpen(true)} aria-label="登录" title="管理员登录">
                        <LogIn className="size-4" />
                    </button>
                )}
                {onOpenShortcuts ? (
                    <button type="button" className={naturalIconClass} style={iconStyle} onClick={onOpenShortcuts} aria-label="快捷键" title="快捷键">
                        <Keyboard className="size-4" />
                    </button>
                ) : null}
            </div>
            <LoginModal open={loginOpen} onClose={() => setLoginOpen(false)} />
        </>
    );
}
