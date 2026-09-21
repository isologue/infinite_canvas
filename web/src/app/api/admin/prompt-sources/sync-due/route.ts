import { readSessionUser } from "@/lib/server/auth";
import { syncDuePromptSources } from "@/lib/server/prompt-source-sync";
export async function POST() {
    if ((await readSessionUser())?.role !== "admin") return Response.json({ code: 403, msg: "只有超级管理员可以访问" }, { status: 403 });
    return Response.json({ code: 0, data: await syncDuePromptSources(), msg: "检查完成" });
}
