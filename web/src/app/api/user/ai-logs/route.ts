import { NextRequest } from "next/server";

import { readSessionUser } from "@/lib/server/auth";
import { recordAiCall, type AiCallKind, type AiCallStatus } from "@/lib/server/ai-call-logs-db";

const KINDS: AiCallKind[] = ["image", "video", "audio", "text", "other"];
const STATUSES: AiCallStatus[] = ["pending", "success", "failed"];

// 普通请求和响应按原值保存；仅对异常超大的单个字段做最终保护，二进制 base64 已在前端上报前省略。
const MAX_PARAM_BYTES = 2 * 1024 * 1024;

function clampJson(value: unknown): unknown {
    if (value === undefined || value === null) return null;
    try {
        const text = JSON.stringify(value);
        if (text.length > MAX_PARAM_BYTES) return { truncated: true, note: "日志内容超过 2 MB，已在服务端截断", bytes: text.length, preview: text.slice(0, MAX_PARAM_BYTES) };
        return value;
    } catch {
        return null;
    }
}

export async function POST(request: NextRequest) {
    const user = await readSessionUser();
    if (!user) return Response.json({ code: 401, msg: "请先登录" }, { status: 401 });

    const body = (await request.json().catch(() => null)) as {
        kind?: string;
        model?: string;
        status?: string;
        reason?: string;
        requestParams?: unknown;
        responseResult?: unknown;
        errorMessage?: string;
    } | null;
    if (!body) return Response.json({ code: 400, msg: "请求体为空" }, { status: 400 });

    const kind = KINDS.includes(body.kind as AiCallKind) ? (body.kind as AiCallKind) : "other";
    const status = STATUSES.includes(body.status as AiCallStatus) ? (body.status as AiCallStatus) : "success";

    try {
        await recordAiCall({
            userId: user.id,
            kind,
            model: (body.model || "").toString().slice(0, 200),
            status,
            reason: (body.reason || "").toString().slice(0, 500),
            requestParams: clampJson(body.requestParams),
            responseResult: clampJson(body.responseResult),
            errorMessage: body.errorMessage ? body.errorMessage.toString().slice(0, 1000) : null,
        });
        return Response.json({ code: 0, msg: "已记录" });
    } catch (error) {
        return Response.json({ code: 500, msg: error instanceof Error ? error.message : "记录失败" }, { status: 500 });
    }
}
