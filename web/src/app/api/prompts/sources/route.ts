import { readSessionUser } from "@/lib/server/auth";
import { readPromptSourceSettings } from "@/lib/server/prompt-source-db";
export async function GET() {
    if (!(await readSessionUser())) return Response.json({ code: 401, msg: "请先登录" }, { status: 401 });
    const settings = await readPromptSourceSettings();
    return Response.json({ code: 0, data: { sources: settings.sources.filter((source) => source.enabled).map(({ id, name }) => ({ id, name })) }, msg: "读取成功" });
}
