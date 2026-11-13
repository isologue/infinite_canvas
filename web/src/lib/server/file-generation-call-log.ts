import { getPgPool } from "@/lib/server/postgres";
import { ensureAiCallLogsTable, recordAiCall } from "@/lib/server/ai-call-logs-db";
import type { EditableFileLog } from "@/types/file-generation";

function fileCallLogId(userId: string, log: EditableFileLog) {
    return JSON.stringify(["editable-file", userId, log.id]);
}

// 重入只为缺失的终态补记，避免每次加载历史都重复写入全部调用日志。
export async function syncFileGenerationCallLogs(userId: string, logs: EditableFileLog[]) {
    const terminal = logs.filter((log) => log.status === "success" || log.status === "error");
    if (!terminal.length) return;
    await ensureAiCallLogsTable();
    const { rows } = await getPgPool().query<{ id: string }>("SELECT id FROM ai_call_logs WHERE user_id = $1 AND id = ANY($2::text[])", [userId, terminal.map((log) => fileCallLogId(userId, log))]);
    const existing = new Set(rows.map((row) => row.id));
    await Promise.all(terminal.filter((log) => !existing.has(fileCallLogId(userId, log))).map((log) => syncFileGenerationCallLog(userId, log)));
}

// 文件历史是权威终态；固定 ID 保证保存重试、刷新和重新进入只记录一次。
export async function syncFileGenerationCallLog(userId: string, log: EditableFileLog) {
    if (log.status !== "success" && log.status !== "error") return;
    const model = log.model.split("::").at(-1) || log.model;
    const duration = log.task?.elapsed_seconds;
    await recordAiCall({
        id: fileCallLogId(userId, log),
        createdAt: new Date(log.createdAt),
        userId, kind: "other", model,
        status: log.status === "success" ? "success" : "failed",
        reason: "文件生成 / " + (log.kind === "ppt" ? "PPTX" : log.kind.toUpperCase()),
        requestParams: { fileKind: log.kind, model, channelModel: log.model, prompt: log.prompt, client_task_id: log.id, referenceImageCount: log.referenceImageCount },
        responseResult: log.task,
        errorMessage: log.status === "error" ? log.task?.error?.message || log.error || "文件生成失败" : undefined,
        durationSeconds: duration, upstreamDurationSeconds: duration,
    });
}
