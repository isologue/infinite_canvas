import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { EditableFileLog } from "../src/types/file-generation";

// 显式指定本地测试数据库才运行；只创建并清理本用例的临时用户。
test.skipIf(!process.env.FILE_LOG_TEST_DATABASE_URL)("file calls persist terminal details once, isolate users, and leave other call logging unchanged", async () => {
    process.env.DATABASE_URL = process.env.FILE_LOG_TEST_DATABASE_URL;
    const { getPgPool } = await import("../src/lib/server/postgres");
    const { syncFileGenerationCallLog, syncFileGenerationCallLogs } = await import("../src/lib/server/file-generation-call-log");
    const { recordAiCall, ensureAiCallLogsTable } = await import("../src/lib/server/ai-call-logs-db");
    const db = getPgPool();
    const users = [randomUUID(), randomUUID()];
    const log: EditableFileLog = {
        id: "same-business-id", kind: "ppt", title: "test", prompt: "test prompt", model: "channel::file-model", referenceImageCount: 2,
        createdAt: Date.now(), status: "success",
        task: { id: "upstream-task", taskId: "upstream-task", kind: "ppt", status: "success", created_at: new Date().toISOString(), updated_at: new Date().toISOString(), elapsed_seconds: 123,
            result: { primary_url: "https://example.test/deck.pptx", zip_url: "https://example.test/assets.zip" } },
    };
    try {
        for (const user of users) await db.query("INSERT INTO app_users (id, username, display_name, password_hash, role) VALUES ($1, $1, 'file log test', 'unused', 'user')", [user]);
        await ensureAiCallLogsTable();
        await Promise.all([syncFileGenerationCallLog(users[0], log), syncFileGenerationCallLog(users[0], log)]);
        await syncFileGenerationCallLog(users[1], log);
        await syncFileGenerationCallLog(users[0], { ...log, id: "pending", status: "running" });
        const failed: EditableFileLog = { ...log, id: "failed", status: "error", task: { ...log.task!, status: "error", error: { code: "file_timeout", message: "upstream failure" }, result: undefined } };
        await syncFileGenerationCallLog(users[0], failed);
        await syncFileGenerationCallLogs(users[0], [log, failed, { ...log, status: "running" }]);
        const { rows } = await db.query("SELECT * FROM ai_call_logs WHERE user_id = ANY($1::text[]) ORDER BY status DESC", [users]);
        expect(rows).toHaveLength(3);
        const success = rows.find((row) => row.user_id === users[0] && row.status === "success");
        expect(success).toMatchObject({ model: "file-model", kind: "other", reason: "文件生成 / PPTX", duration_seconds: 123, upstream_duration_seconds: 123 });
        expect(success.request_params).toMatchObject({ prompt: "test prompt", referenceImageCount: 2, channelModel: "channel::file-model" });
        expect(success.response_result.result.primary_url).toBe("https://example.test/deck.pptx");
        expect(new Date(success.created_at).getTime()).toBe(log.createdAt);
        expect(rows.find((row) => row.status === "failed")).toMatchObject({ error_message: "upstream failure" });
        const input = { userId: users[0], kind: "text" as const, model: "text-model", status: "success" as const, reason: "test" };
        expect(await recordAiCall(input)).not.toBe(await recordAiCall(input));
    } finally {
        await db.query("DELETE FROM app_users WHERE id = ANY($1::text[])", [users]);
        await db.end();
        globalThis.__infiniteCanvasPgPool = undefined;
    }
});
