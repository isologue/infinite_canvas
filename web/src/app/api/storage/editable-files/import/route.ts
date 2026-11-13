import { readSessionUser } from "@/lib/server/auth";
import { storeFileGenerationResources } from "@/lib/server/file-generation-storage";

export async function POST(request: Request) {
    const user = await readSessionUser();
    if (!user) return Response.json({ code: 401, msg: "请先登录" }, { status: 401 });
    const body = await request.json().catch(() => null);
    if (typeof body?.logId !== "string" || !body.logId) return Response.json({ code: 400, msg: "无效文件任务记录" }, { status: 400 });
    try {
        const log = await storeFileGenerationResources(user.id, body.logId);
        if (!log) return Response.json({ code: 404, msg: "文件任务记录不存在" }, { status: 404 });
        return Response.json({ code: 0, data: { log } });
    } catch (error) {
        return Response.json({ code: 502, msg: error instanceof Error ? error.message : "文件资源转存失败" }, { status: 502 });
    }
}