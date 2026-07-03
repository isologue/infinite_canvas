"use client";

import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Button } from "antd";

import { LoginModal } from "@/components/layout/login-modal";
import { useUserStore } from "@/stores/use-user-store";

export function AuthRequired({ children, title = "请先登录" }: { children: ReactNode; title?: string }) {
    const hydrated = useUserStore((state) => state.hydrated);
    const user = useUserStore((state) => state.user);
    const [open, setOpen] = useState(false);

    useEffect(() => {
        if (hydrated && !user) setOpen(true);
    }, [hydrated, user]);

    if (!hydrated) return <main className="flex h-full items-center justify-center bg-background text-sm text-stone-500">正在加载...</main>;
    if (!user) {
        return (
            <>
                <main className="flex h-full flex-col items-center justify-center gap-4 bg-background px-6 text-center">
                    <div className="text-xl font-semibold text-stone-950 dark:text-stone-100">{title}</div>
                    <div className="text-sm text-stone-500">登录或注册后才可以访问此页面。</div>
                    <Button type="primary" onClick={() => setOpen(true)}>
                        登录 / 注册
                    </Button>
                </main>
                <LoginModal open={open} onClose={() => setOpen(false)} />
            </>
        );
    }
    return <>{children}</>;
}
