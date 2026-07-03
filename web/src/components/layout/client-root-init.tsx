"use client";

import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import { App } from "antd";

import { migrateLocalDataToServer } from "@/services/local-data-migration";
import { useConfigStore, type AiConfig, type WebdavSyncConfig } from "@/stores/use-config-store";
import { useUserStore, type LocalUser } from "@/stores/use-user-store";

type SessionResponse = { code: number; data?: { user?: LocalUser | null } };
type SharedConfigResponse = { code: number; data?: { config?: AiConfig; webdav?: WebdavSyncConfig; canManage?: boolean } };

export function ClientRootInit({ children }: { children: ReactNode }) {
    const { message } = App.useApp();
    const booted = useRef(false);
    const replaceSharedConfig = useConfigStore((state) => state.replaceSharedConfig);
    const setUser = useUserStore((state) => state.setUser);
    const setUserHydrated = useUserStore((state) => state.setHydrated);

    useEffect(() => {
        if (booted.current) return;
        booted.current = true;
        void (async () => {
            try {
                const [sessionRes, configRes] = await Promise.all([fetch("/api/auth/session", { cache: "no-store" }), fetch("/api/shared-config", { cache: "no-store" })]);
                const session = (await sessionRes.json()) as SessionResponse;
                const shared = (await configRes.json()) as SharedConfigResponse;

                if (session.data?.user) {
                    const migration = await migrateLocalDataToServer(session.data.user);
                    if (migration.migrated) message.success(`已迁移本地数据：${migration.projects} 个画布，${migration.assets} 个素材，${migration.imageLogs + migration.videoLogs} 条记录`);
                }

                setUser(session.data?.user || null);
                if (shared.data?.config && shared.data?.webdav) {
                    replaceSharedConfig({
                        config: shared.data.config,
                        webdav: shared.data.webdav,
                        canManage: Boolean(shared.data.canManage),
                    });
                }
            } catch {
                message.error("读取共享配置失败");
            } finally {
                setUserHydrated(true);
            }
        })();
    }, [message, replaceSharedConfig, setUser, setUserHydrated]);

    return <>{children}</>;
}
