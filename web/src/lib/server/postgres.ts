import { Pool } from "pg";

declare global {
    // eslint-disable-next-line no-var
    var __infiniteCanvasPgPool: Pool | undefined;
}

function databaseUrl() {
    return process.env.DATABASE_URL || process.env.DATABASE_DSN || "";
}

export function getPgPool() {
    const connectionString = databaseUrl().trim();
    if (!connectionString) throw new Error("未配置 DATABASE_URL");
    if (!global.__infiniteCanvasPgPool) {
        global.__infiniteCanvasPgPool = new Pool({
            connectionString,
            ssl: connectionString.includes("sslmode=require") ? { rejectUnauthorized: false } : undefined,
        });
    }
    return global.__infiniteCanvasPgPool;
}
