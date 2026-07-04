"use client";

import { create } from "zustand";

export type LocalUserRole = "admin" | "user";

export type LocalUser = {
    id: string;
    username: string;
    displayName: string;
    avatarUrl: string;
    role: LocalUserRole;
};

type UserStore = {
    user: LocalUser | null;
    hydrated: boolean;
    setUser: (user: LocalUser | null) => void;
    setHydrated: (hydrated: boolean) => void;
    clearSession: () => void;
    refreshSession: () => Promise<boolean>;
};

export const useUserStore = create<UserStore>()((set) => ({
    user: null,
    hydrated: false,
    setUser: (user) => set({ user }),
    setHydrated: (hydrated) => set({ hydrated }),
    clearSession: () => set({ user: null }),
    // 从 session 端点重新拉取登录态。
    refreshSession: async () => {
        try {
            const res = await fetch("/api/auth/session", { cache: "no-store" });
            if (!res.ok) return false;
            const payload = (await res.json()) as { data?: { user?: LocalUser | null } };
            set({ user: payload.data?.user || null });
            return true;
        } catch {
            return false;
        }
    },
}));
