import { readSessionUser } from "@/lib/server/auth";
import { deletePromptSource } from "@/lib/server/prompt-source-db";
export async function DELETE(_: Request, context: { params: Promise<{ id: string }> }) {
    if ((await readSessionUser())?.role !== "admin") return Response.json({ code: 403, msg: "只有超级管理员可以访问" }, { status: 403 });
    const { id } = await context.params;
    try { await deletePromptSource(decodeURIComponent(id)); return Response.json({ code: 0, msg: "来源及其全部提示词资源已删除" }); }
    catch (error) { return Response.json({ code: 400, msg: error instanceof Error ? error.message : "删除失败" }, { status: 400 }); }
}
