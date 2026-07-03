import { NextRequest } from "next/server";

import { readSessionUser } from "@/lib/server/auth";
import { readUserLogs, writeUserLogs } from "@/lib/server/user-data-db";

type Kind = "image" | "video";

export async function GET(_request: NextRequest, context: { params: Promise<{ kind: string }> }) {
    const user = await readSessionUser();
    if (!user) return Response.json({ code: 401, msg: "请先登录" }, { status: 401 });
    const { kind } = await context.params;
    if (kind !== "image" && kind !== "video") return Response.json({ code: 400, msg: "无效类型" }, { status: 400 });
    const logs = await readUserLogs(user.id, kind as Kind);
    return Response.json({ code: 0, data: { logs } });
}

export async function PUT(request: NextRequest, context: { params: Promise<{ kind: string }> }) {
    const user = await readSessionUser();
    if (!user) return Response.json({ code: 401, msg: "请先登录" }, { status: 401 });
    const { kind } = await context.params;
    if (kind !== "image" && kind !== "video") return Response.json({ code: 400, msg: "无效类型" }, { status: 400 });
    const body = (await request.json().catch(() => null)) as { logs?: unknown } | null;
    await writeUserLogs(user.id, kind as Kind, body?.logs || []);
    return Response.json({ code: 0, msg: "保存成功" });
}
