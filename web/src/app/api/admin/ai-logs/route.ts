import { NextRequest } from "next/server";

import { readSessionUser } from "@/lib/server/auth";
import { listAiCallLogs, type AiCallKind, type AiCallStatus } from "@/lib/server/ai-call-logs-db";

function unauthorized() {
    return Response.json({ code: 403, msg: "只有超级管理员可以访问" }, { status: 403 });
}

const KINDS: AiCallKind[] = ["image", "video", "audio", "text", "other"];
const STATUSES: AiCallStatus[] = ["pending", "success", "failed"];

export async function GET(request: NextRequest) {
    const user = await readSessionUser();
    if (user?.role !== "admin") return unauthorized();

    const params = request.nextUrl.searchParams;
    const page = Math.max(1, Math.floor(Number(params.get("page")) || 1));
    const pageSize = Math.min(100, Math.max(1, Math.floor(Number(params.get("pageSize")) || 20)));
    const kindParam = params.get("kind");
    const statusParam = params.get("status");
    const keyword = params.get("keyword")?.trim() || undefined;

    const { logs, total } = await listAiCallLogs({
        limit: pageSize,
        offset: (page - 1) * pageSize,
        kind: kindParam && KINDS.includes(kindParam as AiCallKind) ? (kindParam as AiCallKind) : undefined,
        status: statusParam && STATUSES.includes(statusParam as AiCallStatus) ? (statusParam as AiCallStatus) : undefined,
        keyword,
    });

    return Response.json({ code: 0, data: { logs, total, page, pageSize } });
}
