"use client";

import type { ReactNode } from "react";

import { AuthRequired } from "@/components/layout/auth-required";
import { useUserStore } from "@/stores/use-user-store";

export function AdminRequired({ children }: { children: ReactNode }) {
    const hydrated = useUserStore((state) => state.hydrated);
    const user = useUserStore((state) => state.user);

    return (
        <AuthRequired title="请先登录后继续使用">
            {!hydrated ? (
                <main className="flex h-full items-center justify-center bg-background text-sm text-stone-500">正在加载...</main>
            ) : user?.role === "admin" ? (
                children
            ) : (
                <main className="flex h-full items-center justify-center bg-background text-sm text-stone-500">只有超级管理员可以访问此页面。</main>
            )}
        </AuthRequired>
    );
}
