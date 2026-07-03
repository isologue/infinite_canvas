"use client";

import { create } from "zustand";

export type LocalUserRole = "admin" | "user";

export type LocalUser = {
    id: string;
    username: string;
    displayName: string;
    avatarUrl: string;
    role: LocalUserRole;
    creditBalance: number;
    reservedCredits?: number;
};

type UserStore = {
    user: LocalUser | null;
    hydrated: boolean;
    setUser: (user: LocalUser | null) => void;
    setHydrated: (hydrated: boolean) => void;
    clearSession: () => void;
    refreshSession: () => Promise<boolean>;
};

export const useUserStore = create<UserStore>()((set, get) => ({
    user: null,
    hydrated: false,
    // setUser 常被 reserve/settle 的响应调用，它带的是最新 creditBalance 但不含 reservedCredits，
    // 所以保留上一份的 reservedCredits，避免余额更新时把“处理中”提示冲没。
    setUser: (user) => {
        if (!user) return set({ user: null });
        const previousReserved = get().user?.reservedCredits;
        set({ user: { ...user, reservedCredits: user.reservedCredits ?? previousReserved } });
    },
    setHydrated: (hydrated) => set({ hydrated }),
    clearSession: () => set({ user: null }),
    // 从 session 端点重新拉取余额和冻结金额。生成前后调用即可让顶栏数字实时。
    // 返回是否成功，供手动刷新按钮显示反馈；生成流程里的调用忽略返回值即可。
    refreshSession: async () => {
        try {
            const res = await fetch("/api/auth/session", { cache: "no-store" });
            if (!res.ok) return false;
            const payload = (await res.json()) as { data?: { user?: LocalUser | null } };
            set({ user: payload.data?.user || null });
            return true;
        } catch {
            // 网络失败时保持现状，不打断用户操作。
            return false;
        }
    },
}));
