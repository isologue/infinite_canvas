import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { zipSync, strToU8 } from "fflate";
import type { EditableFileKind, EditableFileLog } from "../src/types/file-generation";

// 在独立 schema 内验证真实数据库与转存逻辑，不改用户的资源、任务或 DAV 配置。
test.skipIf(!process.env.FILE_LOG_TEST_DATABASE_URL)("file resources follow DAV settings, preserve bytes, isolate users and retry without duplicate uploads", async () => {
    const databaseUrl = process.env.FILE_LOG_TEST_DATABASE_URL!;
    const previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = databaseUrl;
    const schema = `file_storage_test_${randomUUID().replaceAll("-", "")}`;
    const control = new Pool({ connectionString: databaseUrl });
    const isolated = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` });
    const previousPool = globalThis.__infiniteCanvasPgPool;
    const previousFetch = globalThis.fetch;
    const upstreamCalls: string[] = [];
    const davFiles = new Map<string, Uint8Array>();
    const davCalls: string[] = [];
    let failPrimary = false;
    const archive = Buffer.from(zipSync({ "[Content_Types].xml": strToU8("<Types/>"), "ppt/presentation.xml": strToU8("<p:presentation/>"), "asset.txt": strToU8("fixture asset") }));
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="20"/></svg>');
    const psd = Buffer.concat([Buffer.from("8BPS"), Buffer.alloc(22)]);
    const upstream = "https://93.184.216.34";
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith(upstream)) {
            upstreamCalls.push(url);
            expect(new Headers(init?.headers).get("authorization")).toBeNull();
            expect(new Headers(init?.headers).get("accept")).toBe("*/*");
            const content = url.includes("bad-zip") ? Buffer.from("PK truncated") : url.includes("bad-page") ? Buffer.from("<html>upstream error</html>") : url.endsWith(".svg") ? svg : url.endsWith(".psd") ? psd : archive;
            return new Response(content, { headers: { "content-type": "application/octet-stream", "content-length": String(content.length) } });
        }
        if (url.startsWith("https://dav.example.test/")) {
            expect(new Headers(init?.headers).get("authorization")).toBe("Basic " + Buffer.from("fixture-user:fixture-password").toString("base64"));
            if (init?.method === "MKCOL") return new Response(null, { status: 201 });
            expect(init?.method).toBe("PUT");
            davCalls.push(url);
            if (failPrimary && url.endsWith("-primary.pptx")) return new Response(null, { status: 503 });
            davFiles.set(url, new Uint8Array(init!.body as Uint8Array));
            return new Response(null, { status: 201 });
        }
        throw new Error("Unexpected fetch: " + url);
    }) as typeof fetch;
    try {
        await control.query(`CREATE SCHEMA ${schema}`);
        for (const table of ["app_users", "shared_configs", "user_file_generation_logs", "user_files"]) {
            await control.query(`CREATE TABLE ${schema}.${table} (LIKE public.${table} INCLUDING ALL)`);
        }
        globalThis.__infiniteCanvasPgPool = isolated;
        const { storeFileGenerationResources } = await import("../src/lib/server/file-generation-storage");
        const { upsertUserFileGenerationLog, readUserFile, readUserFileGenerationLogs } = await import("../src/lib/server/user-data-db");
        const users = [randomUUID(), randomUUID()];
        for (const user of users) await isolated.query("INSERT INTO app_users (id, username, display_name, password_hash, role) VALUES ($1, $1, 'storage test', 'unused', 'user')", [user]);
        const settings = async (webdav: object) => {
            await isolated.query("INSERT INTO shared_configs (config_key, config_json, webdav_json) VALUES ('global', '{}'::jsonb, $1::jsonb) ON CONFLICT (config_key) DO UPDATE SET webdav_json = EXCLUDED.webdav_json", [JSON.stringify({ enabled: true, uploadGeneratedResources: true, storageMode: "local+webdav", url: "https://dav.example.test/dav", username: "fixture-user", password: "fixture-password", directory: "files", publicUrlPrefix: "https://assets.example.test/files", ...webdav })]);
        };
        const save = async (id: string, kind: EditableFileKind = "ppt", primary?: string, zip = true) => {
            const log: EditableFileLog = { id, kind, model: "channel::file", title: "fixture", prompt: "fixture", status: "success", createdAt: Date.now(), task: { id, taskId: id, kind, status: "success", created_at: "", updated_at: "", elapsed_seconds: 10, result: { primary_url: primary || `${upstream}/${id}.${kind === "ppt" ? "pptx" : kind}`, ...(zip ? { zip_url: `${upstream}/${id}.zip` } : {}) } } };
            await upsertUserFileGenerationLog(users[0], log);
            return log;
        };
        for (const flags of [{ enabled: false }, { storageMode: "local" }, { uploadGeneratedResources: false }]) {
            await settings(flags);
            const log = await save("local-" + randomUUID());
            const stored = (await storeFileGenerationResources(users[0], log.id))!;
            expect(stored.status).toBe("success");
            expect(stored.storageError).toBeUndefined();
            expect(stored.files?.primary?.url).toBeUndefined();
            expect((await readUserFile(users[0], stored.files!.primary!.storageKey))?.content).toEqual(archive);
            const before = upstreamCalls.length;
            await storeFileGenerationResources(users[0], log.id);
            expect(upstreamCalls.length).toBe(before);
        }
        expect(davCalls).toHaveLength(0);
        await settings({});
        for (const kind of ["ppt", "psd", "svg"] as const) {
            const log = await save("dav-" + kind, kind);
            const [stored, duplicate] = await Promise.all([storeFileGenerationResources(users[0], log.id), storeFileGenerationResources(users[0], log.id)]);
            expect(stored).toEqual(duplicate);
            expect(stored!.storageError).toBeUndefined();
            const extension = kind === "ppt" ? "pptx" : kind;
            expect(stored!.files!.primary!.url).toEndWith("-primary." + extension);
            expect(stored!.files!.zip!.url).toEndWith("-zip.zip");
            const davPath = stored!.files!.primary!.url!.replace("https://assets.example.test/files", "https://dav.example.test/dav/files");
            expect(Buffer.from(davFiles.get(davPath)!)).toEqual(kind === "ppt" ? archive : kind === "psd" ? psd : svg);
            expect((await readUserFile(users[0], stored!.files!.primary!.storageKey))!.content).toEqual(Buffer.from(davFiles.get(davPath)!));
            expect(await readUserFile(users[1], stored!.files!.primary!.storageKey)).toBeNull();
            await upsertUserFileGenerationLog(users[0], log);
            const reloaded = (await readUserFileGenerationLogs(users[0]) as EditableFileLog[]).find((item) => item.id === log.id)!;
            expect(reloaded.files).toEqual(stored!.files);
        }
        expect(davCalls).toHaveLength(6);
        expect(await storeFileGenerationResources(users[1], "dav-ppt")).toBeNull();
        failPrimary = true;
        const retryLog = await save("retry");
        const partial = (await storeFileGenerationResources(users[0], retryLog.id))!;
        expect(partial.status).toBe("success");
        expect(partial.storageError).toContain("503");
        expect(partial.files!.primary!.storageKey).toBeTruthy();
        expect(partial.files!.primary!.url).toBeUndefined();
        expect(partial.files!.zip!.url).toBeTruthy();
        const beforeRetry = upstreamCalls.length;
        const putsBeforeRetry = davCalls.length;
        failPrimary = false;
        const retried = (await storeFileGenerationResources(users[0], retryLog.id))!;
        expect(retried.storageError).toBeUndefined();
        expect(retried.files!.primary!.url).toBeTruthy();
        expect(upstreamCalls.length).toBe(beforeRetry);
        expect(davCalls.length).toBe(putsBeforeRetry + 1);
        for (const bad of ["bad-zip", "bad-page"]) {
            const log = await save(bad, "ppt", `${upstream}/${bad}`, false);
            const result = (await storeFileGenerationResources(users[0], log.id))!;
            expect(result.status).toBe("success");
            expect(result.storageError).toBeTruthy();
            expect(result.files?.primary).toBeUndefined();
        }
        const unfinished = { ...await save("unfinished"), status: "running" as const };
        await upsertUserFileGenerationLog(users[0], unfinished);
        const before = upstreamCalls.length;
        expect((await storeFileGenerationResources(users[0], unfinished.id))!.status).toBe("running");
        expect(upstreamCalls.length).toBe(before);
    } finally {
        globalThis.fetch = previousFetch;
        globalThis.__infiniteCanvasPgPool = previousPool;
        if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
        else process.env.DATABASE_URL = previousDatabaseUrl;
        await isolated.end();
        await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await control.end();
    }
}, 30_000);