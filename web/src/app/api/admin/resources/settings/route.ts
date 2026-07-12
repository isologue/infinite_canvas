import { NextRequest } from "next/server";

import { readSessionUser } from "@/lib/server/auth";
import { readRetentionSettings, writeRetentionSettings } from "@/lib/server/resource-db";

export async function GET() {
    const user = await readSessionUser();
    if (user?.role !== "admin") return forbidden();
    return Response.json({ code: 0, data: { settings: await readRetentionSettings() }, msg: "读取成功" });
}

export async function PUT(request: NextRequest) {
    const user = await readSessionUser();
    if (user?.role !== "admin") return forbidden();
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    return Response.json({ code: 0, data: { settings: await writeRetentionSettings(body) }, msg: "保存成功" });
}

function forbidden() {
    return Response.json({ code: 403, msg: "只有超级管理员可以访问" }, { status: 403 });
}
