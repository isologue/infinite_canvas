import { NextRequest } from "next/server";
import { readSessionUser } from "@/lib/server/auth";
import { readPromptSourceSettings, replacePromptSourceSettings, savePromptSource, updatePromptSourceEnabled, updatePromptSourceSchedule } from "@/lib/server/prompt-source-db";
import { createPromptSource, type PromptSource } from "@/services/api/prompt-source-presets";

export async function GET() {
    if ((await readSessionUser())?.role !== "admin") return forbidden();
    return Response.json({ code: 0, data: await readPromptSourceSettings(), msg: "读取成功" });
}
export async function PUT(request: NextRequest) {
    if ((await readSessionUser())?.role !== "admin") return forbidden();
    const body = (await request.json().catch(() => null)) as { source?: Partial<PromptSource> } | null;
    const source = createPromptSource(body?.source);
    if (!source.name) return badRequest("来源名称不能为空");
    if (!validSourceUrl(source.url)) return badRequest("JSON URL 无效");
    if (source.homepage && !isHttpUrl(source.homepage)) return badRequest("来源主页 URL 无效");
    return Response.json({ code: 0, data: { source: await savePromptSource(source) }, msg: "保存成功" });
}
export async function POST(request: NextRequest) {
    if ((await readSessionUser())?.role !== "admin") return forbidden();
    const body = (await request.json().catch(() => null)) as { settings?: { sources?: PromptSource[]; schedule?: { intervalMinutes?: number; lastFetchedAt?: string } } } | null;
    if (!Array.isArray(body?.settings?.sources)) return badRequest("提示词来源配置不完整");
    const schedule = { intervalMinutes: Number(body.settings.schedule?.intervalMinutes) || 0, lastFetchedAt: body.settings.schedule?.lastFetchedAt || "" };
    return Response.json({ code: 0, data: await replacePromptSourceSettings({ sources: body.settings.sources, schedule }), msg: "导入成功" });
}
export async function PATCH(request: NextRequest) {
    if ((await readSessionUser())?.role !== "admin") return forbidden();
    const body = (await request.json().catch(() => null)) as { id?: string; enabled?: boolean; intervalMinutes?: number } | null;
    if (typeof body?.intervalMinutes === "number") return Response.json({ code: 0, data: await updatePromptSourceSchedule(body.intervalMinutes), msg: "保存成功" });
    if (!body?.id || typeof body.enabled !== "boolean") return badRequest("参数不完整");
    return Response.json({ code: 0, data: await updatePromptSourceEnabled(body.id, body.enabled), msg: "保存成功" });
}
function validSourceUrl(value: string) { return value.startsWith("/prompts/") || isHttpUrl(value); }
function isHttpUrl(value: string) { try { return ["http:", "https:"].includes(new URL(value).protocol); } catch { return false; } }
function forbidden() { return Response.json({ code: 403, msg: "只有超级管理员可以访问" }, { status: 403 }); }
function badRequest(msg: string) { return Response.json({ code: 400, msg }, { status: 400 }); }

