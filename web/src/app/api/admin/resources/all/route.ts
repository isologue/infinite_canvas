import { NextRequest } from "next/server";

import { readSessionUser } from "@/lib/server/auth";
import { clearAdminResources } from "@/lib/server/resource-db";

export async function DELETE(request: NextRequest) {
    const user = await readSessionUser();
    if (user?.role !== "admin") return Response.json({ code: 403, msg: "只有超级管理员可以访问" }, { status: 403 });
    const body = (await request.json().catch(() => null)) as { confirm?: string } | null;
    if (body?.confirm !== "清空全部资源") return Response.json({ code: 400, msg: "请输入“清空全部资源”确认" }, { status: 400 });
    return Response.json({ code: 0, data: await clearAdminResources(), msg: "已清空全部资源" });
}
