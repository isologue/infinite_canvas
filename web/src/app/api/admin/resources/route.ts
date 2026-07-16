import { NextRequest } from "next/server";

import { readSessionUser } from "@/lib/server/auth";
import { deleteAdminResources, listAdminResources } from "@/lib/server/resource-db";

export async function GET(request: NextRequest) {
    const user = await readSessionUser();
    if (user?.role !== "admin") return forbidden();
    const q = request.nextUrl.searchParams;
    const page = Math.max(1, Number(q.get("page")) || 1);
    const pageSize = [20, 50, 100].includes(Number(q.get("pageSize"))) ? Number(q.get("pageSize")) : 20;
    const data = await listAdminResources({ page, pageSize, kind: q.get("kind") || "", saved: q.get("saved") || "", keyword: q.get("keyword") || "", userId: q.get("userId") || "", source: q.get("source") || "", from: q.get("from") || "", to: q.get("to") || "" });
    return Response.json({ code: 0, data, msg: "读取成功" });
}

export async function DELETE(request: NextRequest) {
    const user = await readSessionUser();
    if (user?.role !== "admin") return forbidden();
    const body = (await request.json().catch(() => null)) as { resources?: Array<{ userId?: string; resourceId?: string }> } | null;
    const resources = (body?.resources || []).filter((item): item is { userId: string; resourceId: string } => Boolean(item.userId && item.resourceId));
    if (!resources.length) return Response.json({ code: 400, msg: "请选择资源" }, { status: 400 });
    return Response.json({ code: 0, data: await deleteAdminResources(resources), msg: "删除成功" });
}

function forbidden() {
    return Response.json({ code: 403, msg: "只有超级管理员可以访问" }, { status: 403 });
}
