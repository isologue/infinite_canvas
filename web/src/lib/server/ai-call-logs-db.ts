import { randomUUID } from "crypto";

import { getPgPool } from "@/lib/server/postgres";

export type AiCallKind = "image" | "video" | "audio" | "text" | "other";
export type AiCallStatus = "pending" | "success" | "failed";

export type AiCallLog = {
    id: string;
    userId: string;
    username: string;
    kind: AiCallKind;
    model: string;
    status: AiCallStatus;
    reason: string;
    requestParams: unknown | null;
    responseResult: unknown | null;
    errorMessage: string | null;
    createdAt: string;
    updatedAt: string;
};

let initialized = false;

export async function ensureAiCallLogsTable() {
    if (initialized) return;
    const db = getPgPool();
    await db.query(`
        CREATE TABLE IF NOT EXISTS ai_call_logs (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
            kind TEXT NOT NULL CHECK (kind IN ('image', 'video', 'audio', 'text', 'other')),
            model TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL CHECK (status IN ('pending', 'success', 'failed')),
            reason TEXT NOT NULL DEFAULT '',
            request_params JSONB,
            response_result JSONB,
            error_message TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS ai_call_logs_created_idx ON ai_call_logs(created_at DESC)`);
    await db.query(`CREATE INDEX IF NOT EXISTS ai_call_logs_user_idx ON ai_call_logs(user_id)`);
    initialized = true;
}

// 前端在一次生成结束后统一上报完整日志（参数 + 结果引用 + 成败）。
// 不依赖点数流程，免费模型也会记录。用户身份由服务端从 session 取，前端无法伪造。
export async function recordAiCall(input: {
    userId: string;
    kind: AiCallKind;
    model: string;
    status: AiCallStatus;
    reason: string;
    requestParams?: unknown;
    responseResult?: unknown;
    errorMessage?: string | null;
}) {
    await ensureAiCallLogsTable();
    const db = getPgPool();
    const id = randomUUID();
    await db.query(
        `
        INSERT INTO ai_call_logs (id, user_id, kind, model, status, reason, request_params, response_result, error_message)
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9)
        `,
        [
            id,
            input.userId,
            input.kind,
            input.model,
            input.status,
            input.reason,
            input.requestParams === undefined ? null : JSON.stringify(input.requestParams),
            input.responseResult === undefined ? null : JSON.stringify(input.responseResult),
            input.errorMessage || null,
        ],
    );
    return id;
}

type AiCallLogRow = {
    id: string;
    user_id: string;
    username: string;
    kind: AiCallKind;
    model: string;
    status: AiCallStatus;
    reason: string;
    request_params: unknown | null;
    response_result: unknown | null;
    error_message: string | null;
    created_at: Date;
    updated_at: Date;
};

function mapRow(row: AiCallLogRow): AiCallLog {
    return {
        id: row.id,
        userId: row.user_id,
        username: row.username,
        kind: row.kind,
        model: row.model,
        status: row.status,
        reason: row.reason,
        requestParams: row.request_params,
        responseResult: row.response_result,
        errorMessage: row.error_message,
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString(),
    };
}

export type ListAiCallLogsFilter = {
    limit: number;
    offset: number;
    userId?: string;
    kind?: AiCallKind;
    status?: AiCallStatus;
    keyword?: string;
};

export async function listAiCallLogs(filter: ListAiCallLogsFilter): Promise<{ logs: AiCallLog[]; total: number }> {
    await ensureAiCallLogsTable();
    const db = getPgPool();

    const conditions: string[] = [];
    const params: unknown[] = [];
    if (filter.userId) {
        params.push(filter.userId);
        conditions.push(`l.user_id = $${params.length}`);
    }
    if (filter.kind) {
        params.push(filter.kind);
        conditions.push(`l.kind = $${params.length}`);
    }
    if (filter.status) {
        params.push(filter.status);
        conditions.push(`l.status = $${params.length}`);
    }
    if (filter.keyword) {
        params.push(`%${filter.keyword}%`);
        conditions.push(`(l.model ILIKE $${params.length} OR u.username ILIKE $${params.length} OR l.reason ILIKE $${params.length})`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const countResult = await db.query<{ total: string }>(`SELECT COUNT(*) AS total FROM ai_call_logs l JOIN app_users u ON u.id = l.user_id ${where}`, params);
    const total = Number(countResult.rows[0]?.total || 0);

    const limitParam = params.length + 1;
    const offsetParam = params.length + 2;
    const result = await db.query<AiCallLogRow>(
        `
        SELECT l.id, l.user_id, u.username, l.kind, l.model, l.status, l.reason,
               l.request_params, l.response_result, l.error_message, l.created_at, l.updated_at
        FROM ai_call_logs l
        JOIN app_users u ON u.id = l.user_id
        ${where}
        ORDER BY l.created_at DESC
        LIMIT $${limitParam} OFFSET $${offsetParam}
        `,
        [...params, filter.limit, filter.offset],
    );
    return { logs: result.rows.map(mapRow), total };
}
