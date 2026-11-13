import { createHash } from "node:crypto";
import { unzipSync } from "fflate";

import { getPgPool } from "@/lib/server/postgres";
import { downloadRemoteMedia, parseRemoteMediaUrl } from "@/lib/server/remote-media-download";
import { readSharedConfig } from "@/lib/server/shared-config-db";
import { ensureUserDataTables, readUserFile, upsertUserFile } from "@/lib/server/user-data-db";
import { shouldUploadSavedResourceToWebdav, uploadSavedUserFileToWebdav } from "@/lib/server/webdav-image-storage";
import type { EditableFileKind, EditableFileLog } from "@/types/file-generation";

const MIME_TYPES: Record<EditableFileKind, string> = {
    ppt: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    psd: "image/vnd.adobe.photoshop",
    svg: "image/svg+xml",
};
const SOURCE = "generated-file";

// 同一用户的同一任务串行转存；已保存的文件和已完成的 DAV 上传直接复用。
export async function storeFileGenerationResources(userId: string, logId: string) {
    await ensureUserDataTables();
    const webdav = (await readSharedConfig()).webdav;
    const client = await getPgPool().connect();
    try {
        await client.query("BEGIN");
        const { rows } = await client.query<{ data_json: EditableFileLog }>("SELECT data_json FROM user_file_generation_logs WHERE user_id = $1 AND log_id = $2 FOR UPDATE", [userId, logId]);
        const log = rows[0]?.data_json;
        if (!log || log.status !== "success") {
            await client.query("COMMIT");
            return log || null;
        }
        const files = { ...log.files };
        const errors: string[] = [];
        for (const role of ["primary", "zip"] as const) {
            const originUrl = role === "primary" ? log.task?.result?.primary_url : log.task?.result?.zip_url;
            if (!originUrl && role === "zip") continue;
            try {
                const stored = files[role];
                if (stored && (!shouldUploadSavedResourceToWebdav(webdav, SOURCE) || stored.url)) continue;
                const storageKey = `file:${createHash("sha256").update(logId).digest("hex")}:${role}`;
                let file = await readUserFile(userId, storageKey, client);
                if (!file) {
                    const url = parseRemoteMediaUrl(originUrl);
                    if (!url) throw new Error("上游文件链接格式错误");
                    const { content, contentType } = await downloadRemoteMedia(url, "file");
                    const mimeType = role === "zip" ? "application/zip" : MIME_TYPES[log.kind];
                    validateFileContent(content, contentType, mimeType);
                    await upsertUserFile(userId, { storageKey, content, mimeType, bytes: content.length }, client);
                    file = { content, mime_type: mimeType, bytes: String(content.length), updated_at: new Date() };
                }
                files[role] = { storageKey, mimeType: file.mime_type, bytes: Number(file.bytes) };
                const url = await uploadSavedUserFileToWebdav(webdav, userId, { storageKey, mimeType: file.mime_type, content: file.content, source: SOURCE });
                if (url) files[role]!.url = url;
            } catch (error) {
                errors.push((role === "primary" ? "主文件：" : "素材 ZIP：") + (error instanceof Error ? error.message : "资源转存失败"));
            }
        }
        const next: EditableFileLog = { ...log, files, storageError: errors.length ? errors.join("；") : undefined };
        await client.query("UPDATE user_file_generation_logs SET data_json = $3::jsonb, updated_at = NOW() WHERE user_id = $1 AND log_id = $2", [userId, logId, JSON.stringify(next)]);
        await client.query("COMMIT");
        return next;
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
}

function validateFileContent(content: Buffer, contentType: string, mimeType: string) {
    const head = content.subarray(0, 512).toString("utf8").trimStart();
    if (!content.length || /application\/json|text\/html/i.test(contentType) || /^(?:<!doctype\s+html|<html[\s>]|[\[{])/i.test(head)) throw new Error("上游返回空文件或错误页面，未保存资源");
    if (mimeType === "application/zip" || mimeType === MIME_TYPES.ppt) {
        try { unzipSync(content, { filter: () => false }); } catch { throw new Error("上游返回的压缩文件无效或不完整，未保存资源"); }
    }
}