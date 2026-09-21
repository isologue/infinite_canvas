import { NextRequest } from "next/server";
import { readSessionUser } from "@/lib/server/auth";
import { listPrompts } from "@/lib/server/prompt-resource-db";
import { readPromptSourceSettings } from "@/lib/server/prompt-source-db";
export async function GET(request: NextRequest) {
    const user = await readSessionUser();
    if (!user) return Response.json({ code: 401, msg: "请先登录" }, { status: 401 });
    const q = request.nextUrl.searchParams;
    const page = Math.max(1, Number(q.get("page")) || 1);
    const pageSize = Math.max(1, Math.min(1000, Number(q.get("pageSize")) || 20));
    const sourceId = q.get("sourceId") || "";
    const settings = await readPromptSourceSettings();
    const enabledSources = settings.sources.filter((source) => source.enabled);
    const enabledSourceIds = enabledSources.map((source) => source.id);
    const visibleSourceIds = user.role === "admin" && sourceId ? settings.sources.map((source) => source.id) : enabledSourceIds;
    const result = await listPrompts({
        keyword: q.get("keyword") || "",
        tags: q.getAll("tag").filter(Boolean),
        sourceId,
        sourceIds: visibleSourceIds,
        category: q.get("category") || "",
        page,
        pageSize,
    });
    const categories = enabledSources.map((source) => source.name);
    return Response.json({ code: 0, data: { ...result, categories }, msg: "读取成功" });
}

