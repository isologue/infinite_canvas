import { NextRequest } from "next/server";

import { adjustUserCredits, listCreditReservations, listCreditTransactions, publicUser, readSessionUser } from "@/lib/server/auth";

function unauthorized() {
    return Response.json({ code: 403, msg: "只有超级管理员可以访问" }, { status: 403 });
}

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
    const user = await readSessionUser();
    if (user?.role !== "admin") return unauthorized();
    const { id } = await context.params;
    const [transactions, reservations] = await Promise.all([listCreditTransactions(id), listCreditReservations(id)]);
    return Response.json({ code: 0, data: { transactions, reservations } });
}

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
    const user = await readSessionUser();
    if (user?.role !== "admin") return unauthorized();
    const { id } = await context.params;
    const body = (await request.json().catch(() => null)) as { amount?: number; reason?: string; action?: "refund" | "consume" } | null;
    const amount = Math.floor(Number(body?.amount) || 0);
    if (amount <= 0) return Response.json({ code: 400, msg: "点数必须大于 0" }, { status: 400 });
    const updated = await adjustUserCredits({
        userId: id,
        amount,
        reason: body?.reason?.trim() || "管理员调整",
        type: body?.action === "consume" ? "consume" : "refund",
        operatorUserId: user.id,
    });
    return Response.json({ code: 0, msg: "调整成功", data: { user: publicUser(updated) } });
}
