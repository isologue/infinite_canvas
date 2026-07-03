"use client";

import { useUserStore, type LocalUser } from "@/stores/use-user-store";

export type CreditReservation = { reservationId: string; expiresAt: string };

export async function reserveUserCredits(amount: number, reason: string, ttlMinutes?: number): Promise<CreditReservation> {
    const response = await fetch("/api/user/credits/reserve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amount, reason, ttlMinutes }),
    });
    const payload = (await response.json().catch(() => null)) as {
        code?: number;
        msg?: string;
        data?: { reservationId?: string; expiresAt?: string; user?: LocalUser };
    } | null;
    if (!response.ok || payload?.code !== 0 || !payload.data?.reservationId) {
        throw new Error(payload?.msg || "点数冻结失败");
    }
    if (payload.data.user) useUserStore.getState().setUser(payload.data.user);
    return { reservationId: payload.data.reservationId, expiresAt: payload.data.expiresAt || "" };
}

export async function settleUserCreditReservation(reservationId: string, status: "success" | "failed") {
    const response = await fetch("/api/user/credits/settle", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reservationId, status }),
    });
    const payload = (await response.json().catch(() => null)) as { code?: number; msg?: string; data?: { user?: LocalUser } } | null;
    if (!response.ok || payload?.code !== 0 || !payload.data?.user) throw new Error(payload?.msg || "点数结算失败");
    useUserStore.getState().setUser(payload.data.user);
    return payload.data.user;
}
