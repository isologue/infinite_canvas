import { NextRequest } from "next/server";
import { readSessionUser } from "@/lib/server/auth";
import { deletePromptBundles, listAdminPromptResources } from "@/lib/server/prompt-resource-db";
import { readPromptSourceSettings } from "@/lib/server/prompt-source-db";
export async function GET(request: NextRequest) {
    if ((await readSessionUser())?.role !== "admin") return forbidden();
    const q = request.nextUrl.searchParams;
    const page = Math.max(1, Number(q.get("page")) || 1);
    const pageSize = [20, 50, 100].includes(Number(q.get("pageSize"))) ? Number(q.get("pageSize")) : 20;
    const [data, settings] = await Promise.all([
        listAdminPromptResources({ page, pageSize, keyword: q.get("keyword") || "", sourceId: q.get("sourceId") || "", status: q.get("status") || "" }),
        readPromptSourceSettings(),
    ]);
    return Response.json({ code: 0, data: { ...data, sources: settings.sources.map(({ id, name }) => ({ id, name })) }, msg: "读取成功" });
}
export async function DELETE(request: NextRequest) {
    if ((await readSessionUser())?.role !== "admin") return forbidden();
    const body = (await request.json().catch(() => null)) as { ids?: string[] } | null;
    const ids = Array.from(new Set((body?.ids || []).filter(Boolean)));
    if (!ids.length) return Response.json({ code: 400, msg: "请选择提示词" }, { status: 400 });
    return Response.json({ code: 0, data: { count: await deletePromptBundles(ids) }, msg: "删除成功" });
}
function forbidden() { return Response.json({ code: 403, msg: "只有超级管理员可以访问" }, { status: 403 }); }
