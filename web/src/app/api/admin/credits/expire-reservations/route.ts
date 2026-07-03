import { NextRequest } from "next/server";

import { expireStaleReservations, readSessionUser } from "@/lib/server/auth";

// 该端点由外部定时任务（系统 crontab / 平台 cron）定期 curl 触发，
// 用 CRON_SECRET 保护；也允许已登录的管理员手动触发以便调试。
export const dynamic = "force-dynamic";

async function authorize(request: NextRequest) {
    const configured = process.env.CRON_SECRET?.trim();
    if (configured) {
        const header = request.headers.get("authorization")?.trim() || "";
        const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : header;
        if (token && token === configured) return true;
    }
    const user = await readSessionUser();
    return user?.role === "admin";
}

async function run(request: NextRequest) {
    if (!(await authorize(request))) {
        return Response.json({ code: 403, msg: "未授权" }, { status: 403 });
    }
    try {
        const expiredCount = await expireStaleReservations();
        return Response.json({ code: 0, msg: "清理完成", data: { expiredCount } });
    } catch (error) {
        return Response.json({ code: 500, msg: error instanceof Error ? error.message : "清理失败" }, { status: 500 });
    }
}

export async function POST(request: NextRequest) {
    return run(request);
}

// 同时支持 GET，方便平台 cron 用简单 GET 请求触发。
export async function GET(request: NextRequest) {
    return run(request);
}
