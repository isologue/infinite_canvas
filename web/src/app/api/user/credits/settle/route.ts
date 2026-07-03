import { NextRequest } from "next/server";

import { publicUser, readSessionUser, settleCreditReservation } from "@/lib/server/auth";

export async function POST(request: NextRequest) {
    const user = await readSessionUser();
    if (!user) return Response.json({ code: 401, msg: "请先登录" }, { status: 401 });
    const body = (await request.json().catch(() => null)) as { reservationId?: string; status?: "success" | "failed" } | null;
    const reservationId = body?.reservationId?.trim() || "";
    const status = body?.status === "success" ? "success" : body?.status === "failed" ? "failed" : null;
    if (!reservationId) return Response.json({ code: 400, msg: "缺少 reservationId" }, { status: 400 });
    if (!status) return Response.json({ code: 400, msg: "status 必须是 success 或 failed" }, { status: 400 });
    try {
        const updated = await settleCreditReservation({ userId: user.id, reservationId, status });
        return Response.json({ code: 0, msg: "结算成功", data: { user: publicUser(updated) } });
    } catch (error) {
        return Response.json({ code: 400, msg: error instanceof Error ? error.message : "结算失败" }, { status: 400 });
    }
}
