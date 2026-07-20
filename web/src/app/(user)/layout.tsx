"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";

import { AuthRequired } from "@/components/layout/auth-required";
import { AgentPanel } from "@/components/agent/agent-panel";
import { AppTopNav } from "@/components/layout/app-top-nav";

export default function UserLayout({ children }: { children: ReactNode }) {
    const pathname = usePathname();
    const needAuth = pathname === "/assets" || pathname === "/image" || pathname === "/video" || pathname === "/canvas" || pathname.startsWith("/canvas/");

    return (
        <div className="flex h-dvh overflow-hidden bg-background text-foreground">
            <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
                <AppTopNav />
                <div className="min-h-0 flex-1 overflow-hidden">{needAuth ? <AuthRequired title="请先登录后继续使用">{children}</AuthRequired> : children}</div>
            </div>
            <AgentPanel />
        </div>
    );
}
