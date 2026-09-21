import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { refreshDueSources } from "@/services/api/prompts";
import { useUserStore } from "@/stores/use-user-store";

const CHECK_INTERVAL_MS = 60_000;

export function usePromptSourceScheduler() {
    const queryClient = useQueryClient();
    const isAdmin = useUserStore((state) => state.user?.role === "admin");
    const hydrated = useUserStore((state) => state.hydrated);

    useEffect(() => {
        if (!hydrated || !isAdmin) return;
        let running = false;
        const tick = async () => {
            if (running) return;
            running = true;
            try {
                const result = await refreshDueSources();
                if (!result.results.length) return;
                await Promise.all([
                    queryClient.invalidateQueries({ queryKey: ["prompts"] }),
                    queryClient.invalidateQueries({ queryKey: ["side-panel-prompts"] }),
                    queryClient.invalidateQueries({ queryKey: ["prompt-source-settings"] }),
                ]);
            } catch {
                // 服务端会保存每个来源的错误，下次检查时继续重试。
            } finally {
                running = false;
            }
        };
        void tick();
        const timer = window.setInterval(() => void tick(), CHECK_INTERVAL_MS);
        return () => window.clearInterval(timer);
    }, [hydrated, isAdmin, queryClient]);
}
