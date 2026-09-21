import { readSessionUser } from "@/lib/server/auth";
import { syncAllPromptSources } from "@/lib/server/prompt-source-sync";
export async function POST() {
    if ((await readSessionUser())?.role !== "admin") return Response.json({ code: 403, msg: "只有超级管理员可以访问" }, { status: 403 });
    const data = await syncAllPromptSources();
    return Response.json({ code: 0, data, msg: data.failureCount ? "部分来源同步失败" : "同步成功" });
}
