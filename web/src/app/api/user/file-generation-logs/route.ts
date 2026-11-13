import { NextRequest } from "next/server";
import { syncFileGenerationCallLog, syncFileGenerationCallLogs } from "@/lib/server/file-generation-call-log";
import type { EditableFileLog } from "@/types/file-generation";

import { readSessionUser } from "@/lib/server/auth";
import { readUserFileGenerationLogs, removeUserFileGenerationLogs, upsertUserFileGenerationLog } from "@/lib/server/user-data-db";

export async function GET() {
    const user = await readSessionUser();
    if (!user) return Response.json({ code: 401, msg: "请先登录" }, { status: 401 });
    const logs = await readUserFileGenerationLogs(user.id) as EditableFileLog[];
    await syncFileGenerationCallLogs(user.id, logs).catch((error) => console.error("[file-call-log]", error));
    return Response.json({ code: 0, data: { logs } });
}

export async function PATCH(request: NextRequest) {
    const user = await readSessionUser();
    if (!user) return Response.json({ code: 401, msg: "请先登录" }, { status: 401 });
    const body = await request.json().catch(() => null);
    if (!body?.log || typeof body.log.id !== "string" || !body.log.id || !["ppt", "psd", "svg"].includes(body.log.kind) || !["queued", "running", "success", "error"].includes(body.log.status) || typeof body.log.model !== "string" || typeof body.log.prompt !== "string" || !Number.isFinite(body.log.createdAt)) return Response.json({ code: 400, msg: "无效文件任务记录" }, { status: 400 });
    try {
        await syncFileGenerationCallLog(user.id, body.log);
        await upsertUserFileGenerationLog(user.id, { ...body.log, files: undefined, storageError: undefined });
    } catch (error) {
        return Response.json({ code: 500, msg: error instanceof Error ? error.message : "文件任务记录保存失败" }, { status: 500 });
    }
    return Response.json({ code: 0, msg: "保存成功" });
}

export async function DELETE(request: NextRequest) {
    const user = await readSessionUser();
    if (!user) return Response.json({ code: 401, msg: "请先登录" }, { status: 401 });
    const body = await request.json().catch(() => null);
    if (!Array.isArray(body?.ids) || !body.ids.every((id: unknown) => typeof id === "string")) return Response.json({ code: 400, msg: "无效文件任务记录" }, { status: 400 });
    await removeUserFileGenerationLogs(user.id, body.ids);
    return Response.json({ code: 0, msg: "删除成功" });
}
