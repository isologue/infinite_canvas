import { NextRequest } from "next/server";

import { publicUser, readSessionUser, reserveUserCredits } from "@/lib/server/auth";

export async function POST(request: NextRequest) {
    const user = await readSessionUser();
    if (!user) return Response.json({ code: 401, msg: "请先登录" }, { status: 401 });
    const body = (await request.json().catch(() => null)) as { amount?: number; reason?: string; ttlMinutes?: number } | null;
    const amount = Math.floor(Number(body?.amount) || 0);
    if (amount <= 0) return Response.json({ code: 400, msg: "点数必须大于 0" }, { status: 400 });
    try {
        const { reservationId, user: updated, expiresAt } = await reserveUserCredits({
            userId: user.id,
            amount,
            reason: body?.reason?.trim() || "系统冻结点数",
            ttlMinutes: body?.ttlMinutes,
        });
        return Response.json({ code: 0, msg: "冻结成功", data: { reservationId, expiresAt, user: publicUser(updated) } });
    } catch (error) {
        return Response.json({ code: 400, msg: error instanceof Error ? error.message : "冻结失败" }, { status: 400 });
    }
}
