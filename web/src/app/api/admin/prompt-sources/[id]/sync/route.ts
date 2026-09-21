import { readSessionUser } from "@/lib/server/auth";
import { syncPromptSourceById } from "@/lib/server/prompt-source-sync";
export async function POST(_: Request, context: { params: Promise<{ id: string }> }) {
    if ((await readSessionUser())?.role !== "admin") return Response.json({ code: 403, msg: "只有超级管理员可以访问" }, { status: 403 });
    const { id } = await context.params;
    const data = await syncPromptSourceById(decodeURIComponent(id));
    if (!data.success) return Response.json({ code: 502, data, msg: data.lastError || "同步失败" }, { status: 502 });
    return Response.json({ code: 0, data, msg: "同步成功" });
}
