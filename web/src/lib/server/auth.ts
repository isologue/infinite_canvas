import { createHmac, randomUUID, timingSafeEqual } from "crypto";
import { cookies, headers } from "next/headers";

import { getPgPool } from "@/lib/server/postgres";

const COOKIE_NAME = "infinite_canvas_session";

export type SessionUser = {
    id: string;
    username: string;
    displayName: string;
    avatarUrl: string;
    role: "admin" | "user";
    creditBalance: number;
};

export type DbUser = SessionUser & {
    passwordHash: string;
};

export type CreditTransaction = {
    id: string;
    userId: string;
    amount: number;
    type: "consume" | "refund" | "admin_adjust";
    reason: string;
    balanceAfter: number;
    operatorUserId: string | null;
    createdAt: string;
};

export type CreditReservation = {
    id: string;
    userId: string;
    amount: number;
    status: "pending" | "settled" | "refunded" | "expired";
    reason: string;
    createdAt: string;
    expiresAt: string;
};

function secret() {
    return process.env.JWT_SECRET?.trim() || "infinite-canvas";
}

function adminUsername() {
    return process.env.ADMIN_USERNAME?.trim() || "admin";
}

function adminPassword() {
    return process.env.ADMIN_PASSWORD?.trim() || "admin";
}

function expireHours() {
    const value = Number(process.env.JWT_EXPIRE_HOURS || 168);
    return Number.isFinite(value) && value > 0 ? value : 168;
}

function sign(payload: string) {
    return createHmac("sha256", secret()).update(payload).digest("hex");
}

function hashPassword(password: string) {
    return createHmac("sha256", secret()).update(password).digest("hex");
}

function encodeSession(user: SessionUser) {
    const payload = JSON.stringify({
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
        role: user.role,
        creditBalance: user.creditBalance,
        exp: Date.now() + expireHours() * 60 * 60 * 1000,
    });
    const base = Buffer.from(payload).toString("base64url");
    return `${base}.${sign(base)}`;
}

function decodeSession(value: string | undefined | null): SessionUser | null {
    if (!value) return null;
    const [base, signature] = value.split(".");
    if (!base || !signature) return null;
    const expected = sign(base);
    const actualBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) return null;
    try {
        const payload = JSON.parse(Buffer.from(base, "base64url").toString("utf8")) as Partial<SessionUser> & { exp?: number };
        if (!payload.id || !payload.username || !payload.role || !payload.exp || payload.exp < Date.now()) return null;
        return {
            id: payload.id,
            username: payload.username,
            displayName: payload.displayName || payload.username,
            avatarUrl: payload.avatarUrl || "",
            role: payload.role,
            creditBalance: Number(payload.creditBalance || 0),
        };
    } catch {
        return null;
    }
}

export async function ensureUserTables() {
    const db = getPgPool();
    await db.query(`
        CREATE TABLE IF NOT EXISTS app_users (
            id TEXT PRIMARY KEY,
            username TEXT NOT NULL UNIQUE,
            display_name TEXT NOT NULL,
            avatar_url TEXT NOT NULL DEFAULT '',
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
            credit_balance BIGINT NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await db.query(`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS credit_balance BIGINT NOT NULL DEFAULT 0`);
    await db.query(`
        CREATE TABLE IF NOT EXISTS credit_transactions (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
            amount BIGINT NOT NULL,
            type TEXT NOT NULL CHECK (type IN ('consume', 'refund', 'admin_adjust')),
            reason TEXT NOT NULL DEFAULT '',
            balance_after BIGINT NOT NULL DEFAULT 0,
            operator_user_id TEXT REFERENCES app_users(id) ON DELETE SET NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await db.query(`
        CREATE TABLE IF NOT EXISTS credit_reservations (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
            amount BIGINT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('pending', 'settled', 'refunded', 'expired')),
            reason TEXT NOT NULL DEFAULT '',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            expires_at TIMESTAMPTZ NOT NULL
        )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS credit_reservations_user_status_idx ON credit_reservations(user_id, status)`);
    await db.query(`CREATE INDEX IF NOT EXISTS credit_reservations_status_expires_idx ON credit_reservations(status, expires_at)`);
}

export async function createAdminUserIfMissing() {
    await ensureUserTables();
    const db = getPgPool();
    await db.query(
        `
        INSERT INTO app_users (id, username, display_name, avatar_url, password_hash, role, credit_balance)
        VALUES ($1, $2, $3, '', $4, 'admin', 0)
        ON CONFLICT (username) DO UPDATE SET
            display_name = EXCLUDED.display_name,
            avatar_url = EXCLUDED.avatar_url,
            password_hash = EXCLUDED.password_hash,
            role = 'admin',
            updated_at = NOW()
        `,
        [randomUUID(), adminUsername(), adminUsername(), hashPassword(adminPassword())],
    );
}

function mapUser(row?: { id: string; username: string; display_name: string; avatar_url: string; role: "admin" | "user"; password_hash: string; credit_balance: string | number } | null): DbUser | null {
    if (!row) return null;
    return {
        id: row.id,
        username: row.username,
        displayName: row.display_name,
        avatarUrl: row.avatar_url,
        role: row.role,
        passwordHash: row.password_hash,
        creditBalance: Number(row.credit_balance || 0),
    };
}

export async function findUserByUsername(username: string) {
    await createAdminUserIfMissing();
    const db = getPgPool();
    const result = await db.query<{ id: string; username: string; display_name: string; avatar_url: string; role: "admin" | "user"; password_hash: string; credit_balance: string | number }>(
        `SELECT id, username, display_name, avatar_url, role, password_hash, credit_balance FROM app_users WHERE username = $1 LIMIT 1`,
        [username.trim()],
    );
    return mapUser(result.rows[0] || null);
}

export async function findUserById(id: string) {
    await createAdminUserIfMissing();
    const db = getPgPool();
    const result = await db.query<{ id: string; username: string; display_name: string; avatar_url: string; role: "admin" | "user"; password_hash: string; credit_balance: string | number }>(
        `SELECT id, username, display_name, avatar_url, role, password_hash, credit_balance FROM app_users WHERE id = $1 LIMIT 1`,
        [id],
    );
    return mapUser(result.rows[0] || null);
}

export async function listUsers(): Promise<DbUser[]> {
    await createAdminUserIfMissing();
    const db = getPgPool();
    const result = await db.query<{ id: string; username: string; display_name: string; avatar_url: string; role: "admin" | "user"; password_hash: string; credit_balance: string | number }>(
        `SELECT id, username, display_name, avatar_url, role, password_hash, credit_balance FROM app_users ORDER BY created_at ASC`,
    );
    return result.rows.map((row: { id: string; username: string; display_name: string; avatar_url: string; role: "admin" | "user"; password_hash: string; credit_balance: string | number }) => mapUser(row)!).filter(Boolean);
}

export async function createUser(input: { username: string; password: string; displayName?: string; role?: "admin" | "user"; creditBalance?: number }) {
    await createAdminUserIfMissing();
    const db = getPgPool();
    const username = input.username.trim();
    const displayName = (input.displayName || username).trim() || username;
    const passwordHash = hashPassword(input.password);
    const id = randomUUID();
    const result = await db.query<{ id: string; username: string; display_name: string; avatar_url: string; role: "admin" | "user"; password_hash: string; credit_balance: string | number }>(
        `
        INSERT INTO app_users (id, username, display_name, avatar_url, password_hash, role, credit_balance)
        VALUES ($1, $2, $3, '', $4, $5, $6)
        RETURNING id, username, display_name, avatar_url, role, password_hash, credit_balance
        `,
        [id, username, displayName, passwordHash, input.role || "user", Number(input.creditBalance || 0)],
    );
    return mapUser(result.rows[0])!;
}

export async function updateUser(input: { id: string; username?: string; displayName?: string; password?: string; role?: "admin" | "user"; creditBalance?: number }) {
    await createAdminUserIfMissing();
    const current = await findUserById(input.id);
    if (!current) return null;
    const db = getPgPool();
    const username = input.username?.trim() || current.username;
    const displayName = input.displayName?.trim() || current.displayName;
    const passwordHash = input.password ? hashPassword(input.password) : current.passwordHash;
    const role = input.role || current.role;
    const creditBalance = Number(input.creditBalance ?? current.creditBalance);
    const result = await db.query<{ id: string; username: string; display_name: string; avatar_url: string; role: "admin" | "user"; password_hash: string; credit_balance: string | number }>(
        `
        UPDATE app_users
        SET username = $2,
            display_name = $3,
            password_hash = $4,
            role = $5,
            credit_balance = $6,
            updated_at = NOW()
        WHERE id = $1
        RETURNING id, username, display_name, avatar_url, role, password_hash, credit_balance
        `,
        [input.id, username, displayName, passwordHash, role, creditBalance],
    );
    return mapUser(result.rows[0] || null);
}

export async function deleteUser(id: string) {
    await createAdminUserIfMissing();
    const db = getPgPool();
    await db.query(`DELETE FROM app_users WHERE id = $1`, [id]);
}

interface Queryable {
    query<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: R[]; rowCount: number | null }>;
}

async function withTransaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    const client = await getPgPool().connect();
    try {
        await client.query("BEGIN");
        const result = await fn(client);
        await client.query("COMMIT");
        return result;
    } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
    } finally {
        client.release();
    }
}

const USER_COLUMNS = `id, username, display_name, avatar_url, role, password_hash, credit_balance`;

async function fetchUserWithin(exec: Queryable, id: string) {
    const result = await exec.query<{ id: string; username: string; display_name: string; avatar_url: string; role: "admin" | "user"; password_hash: string; credit_balance: string | number }>(
        `SELECT ${USER_COLUMNS} FROM app_users WHERE id = $1 LIMIT 1`,
        [id],
    );
    return mapUser(result.rows[0] || null)!;
}

async function insertCreditTransaction(exec: Queryable, input: {
    userId: string;
    amount: number;
    type: "consume" | "refund" | "admin_adjust";
    reason: string;
    balanceAfter: number;
    operatorUserId?: string | null;
}) {
    await exec.query(
        `
        INSERT INTO credit_transactions (id, user_id, amount, type, reason, balance_after, operator_user_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        `,
        [randomUUID(), input.userId, input.amount, input.type, input.reason, input.balanceAfter, input.operatorUserId || null],
    );
}

export async function listCreditTransactions(userId: string) {
    await ensureUserTables();
    const db = getPgPool();
    const result = await db.query<{
        id: string;
        user_id: string;
        amount: string | number;
        type: "consume" | "refund" | "admin_adjust";
        reason: string;
        balance_after: string | number;
        operator_user_id: string | null;
        created_at: Date;
    }>(
        `
        SELECT id, user_id, amount, type, reason, balance_after, operator_user_id, created_at
        FROM credit_transactions
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT 200
        `,
        [userId],
    );
    return result.rows.map((row: {
        id: string;
        user_id: string;
        amount: string | number;
        type: "consume" | "refund" | "admin_adjust";
        reason: string;
        balance_after: string | number;
        operator_user_id: string | null;
        created_at: Date;
    }) => ({
        id: row.id,
        userId: row.user_id,
        amount: Number(row.amount || 0),
        type: row.type,
        reason: row.reason,
        balanceAfter: Number(row.balance_after || 0),
        operatorUserId: row.operator_user_id,
        createdAt: new Date(row.created_at).toISOString(),
    }));
}

// 某用户当前冻结中（pending 且未过期）的点数总额。
export async function getReservedCredits(userId: string) {
    await ensureUserTables();
    const db = getPgPool();
    const result = await db.query<{ total: string | number }>(
        `SELECT COALESCE(SUM(amount), 0) AS total FROM credit_reservations WHERE user_id = $1 AND status = 'pending' AND expires_at > NOW()`,
        [userId],
    );
    return Number(result.rows[0]?.total || 0);
}

// 一次性拿到多个用户的冻结总额，避免管理员列表逐个查询。返回 Map。
export async function getReservedCreditsForUsers(userIds: string[]) {
    const map = new Map<string, number>();
    if (!userIds.length) return map;
    await ensureUserTables();
    const db = getPgPool();
    const result = await db.query<{ user_id: string; total: string | number }>(
        `SELECT user_id, COALESCE(SUM(amount), 0) AS total FROM credit_reservations WHERE user_id = ANY($1) AND status = 'pending' AND expires_at > NOW() GROUP BY user_id`,
        [userIds],
    );
    for (const row of result.rows) map.set(row.user_id, Number(row.total || 0));
    return map;
}

export async function listCreditReservations(userId: string): Promise<CreditReservation[]> {
    await ensureUserTables();
    const db = getPgPool();
    const result = await db.query<{ id: string; user_id: string; amount: string | number; status: CreditReservation["status"]; reason: string; created_at: Date; expires_at: Date }>(
        `
        SELECT id, user_id, amount, status, reason, created_at, expires_at
        FROM credit_reservations
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT 200
        `,
        [userId],
    );
    return result.rows.map((row: { id: string; user_id: string; amount: string | number; status: CreditReservation["status"]; reason: string; created_at: Date; expires_at: Date }) => ({
        id: row.id,
        userId: row.user_id,
        amount: Number(row.amount || 0),
        status: row.status,
        reason: row.reason,
        createdAt: new Date(row.created_at).toISOString(),
        expiresAt: new Date(row.expires_at).toISOString(),
    }));
}

export async function adjustUserCredits(input: { userId: string; amount: number; reason: string; type: "consume" | "refund" | "admin_adjust"; operatorUserId?: string | null }) {
    await ensureUserTables();
    const amount = Math.floor(Number(input.amount) || 0);
    if (amount <= 0) throw new Error("点数必须大于 0");

    return withTransaction(async (tx) => {
        const delta = input.type === "consume" ? -amount : amount;
        // 原子扣款：consume 时用 WHERE credit_balance >= amount 保证不会扣成负数，
        // 并发请求里最多只有一个能通过（rowCount 判断）。
        const guard = input.type === "consume" ? " AND credit_balance >= $3" : "";
        const result = await tx.query<{ id: string; username: string; display_name: string; avatar_url: string; role: "admin" | "user"; password_hash: string; credit_balance: string | number }>(
            `
            UPDATE app_users
            SET credit_balance = credit_balance + $2,
                updated_at = NOW()
            WHERE id = $1${guard}
            RETURNING id, username, display_name, avatar_url, role, password_hash, credit_balance
            `,
            input.type === "consume" ? [input.userId, delta, amount] : [input.userId, delta],
        );
        if (!result.rows[0]) {
            const exists = await tx.query(`SELECT 1 FROM app_users WHERE id = $1 LIMIT 1`, [input.userId]);
            throw new Error(exists.rows[0] ? "点数不足" : "用户不存在");
        }
        const updated = mapUser(result.rows[0])!;
        await insertCreditTransaction(tx, {
            userId: input.userId,
            amount: delta,
            type: input.type,
            reason: input.reason,
            balanceAfter: updated.creditBalance,
            operatorUserId: input.operatorUserId || null,
        });
        return updated;
    });
}

const RESERVATION_TTL_MINUTES = 10;
const RESERVATION_TTL_MAX_MINUTES = 120;

export async function expireStaleReservations() {
    await ensureUserTables();
    const db = getPgPool();
    const stale = await db.query<{ id: string }>(
        `SELECT id FROM credit_reservations WHERE status = 'pending' AND expires_at < NOW() LIMIT 200`,
    );
    let expiredCount = 0;
    for (const { id } of stale.rows) {
        // 每条记录独立事务：先原子地把 pending 抢成 expired（rowCount 保证只有一个执行者退款），
        // 再退款并记流水，三步同生共死。
        const done = await withTransaction(async (tx) => {
            const claimed = await tx.query<{ user_id: string; amount: string | number; reason: string }>(
                `UPDATE credit_reservations SET status = 'expired' WHERE id = $1 AND status = 'pending' RETURNING user_id, amount, reason`,
                [id],
            );
            const row = claimed.rows[0];
            if (!row) return false;
            const amount = Math.floor(Number(row.amount) || 0);
            if (amount <= 0) return true;
            const result = await tx.query<{ credit_balance: string | number }>(
                `UPDATE app_users SET credit_balance = credit_balance + $2, updated_at = NOW() WHERE id = $1 RETURNING credit_balance`,
                [row.user_id, amount],
            );
            const balanceAfter = Number(result.rows[0]?.credit_balance || 0);
            await insertCreditTransaction(tx, {
                userId: row.user_id,
                amount,
                type: "refund",
                reason: `冻结超时自动退款: ${row.reason}`,
                balanceAfter,
                operatorUserId: null,
            });
            return true;
        });
        if (done) expiredCount += 1;
    }
    return expiredCount;
}

export async function reserveUserCredits(input: { userId: string; amount: number; reason: string; ttlMinutes?: number }) {
    await ensureUserTables();
    await expireStaleReservations();
    const amount = Math.floor(Number(input.amount) || 0);
    if (amount <= 0) throw new Error("点数必须大于 0");

    const requestedTtl = Number.isFinite(input.ttlMinutes) ? Math.floor(Number(input.ttlMinutes)) : RESERVATION_TTL_MINUTES;
    const ttlMinutes = Math.min(RESERVATION_TTL_MAX_MINUTES, Math.max(1, requestedTtl));
    const reservationId = randomUUID();
    const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString();

    return withTransaction(async (tx) => {
        // 原子扣款：余额足够时才扣，rowCount 为 0 说明并发下已被扣光或用户不存在。
        const deducted = await tx.query<{ id: string; username: string; display_name: string; avatar_url: string; role: "admin" | "user"; password_hash: string; credit_balance: string | number }>(
            `
            UPDATE app_users
            SET credit_balance = credit_balance - $2, updated_at = NOW()
            WHERE id = $1 AND credit_balance >= $2
            RETURNING id, username, display_name, avatar_url, role, password_hash, credit_balance
            `,
            [input.userId, amount],
        );
        if (!deducted.rows[0]) {
            const exists = await tx.query(`SELECT 1 FROM app_users WHERE id = $1 LIMIT 1`, [input.userId]);
            throw new Error(exists.rows[0] ? "点数不足" : "用户不存在");
        }
        await tx.query(
            `INSERT INTO credit_reservations (id, user_id, amount, status, reason, expires_at) VALUES ($1, $2, $3, 'pending', $4, $5)`,
            [reservationId, input.userId, amount, input.reason, expiresAt],
        );
        return { reservationId, user: mapUser(deducted.rows[0])!, expiresAt };
    });
}

export async function settleCreditReservation(input: { userId: string; reservationId: string; status: "success" | "failed" }) {
    await ensureUserTables();

    return withTransaction(async (tx) => {
        // 行锁住这条 reservation，避免和 expireStaleReservations 的自动退款竞态。
        const found = await tx.query<{ id: string; user_id: string; amount: string | number; status: string; reason: string }>(
            `SELECT id, user_id, amount, status, reason FROM credit_reservations WHERE id = $1 LIMIT 1 FOR UPDATE`,
            [input.reservationId],
        );
        const row = found.rows[0];
        if (!row) throw new Error("冻结记录不存在");
        if (row.user_id !== input.userId) throw new Error("冻结记录不属于该用户");

        const amount = Math.floor(Number(row.amount) || 0);

        // 跨会话场景：任务还在跑，用户关了浏览器过很久回来，reservation 可能已被自动退款(expired)。
        if (row.status === "expired") {
            if (input.status === "failed") {
                // 已经退过款了，什么都不用做，温柔返回。
                return fetchUserWithin(tx, row.user_id);
            }
            // 任务其实成功了，但钱已退回用户 → 需要重新把这笔钱扣掉（补扣）。
            const deducted = await tx.query<{ credit_balance: string | number }>(
                `UPDATE app_users SET credit_balance = credit_balance - $2, updated_at = NOW() WHERE id = $1 AND credit_balance >= $2 RETURNING credit_balance`,
                [row.user_id, amount],
            );
            if (!deducted.rows[0]) {
                // 用户已经把退回的点数花掉了，无法补扣。标记 settled 记录事实，避免流水错账。
                await tx.query(`UPDATE credit_reservations SET status = 'settled' WHERE id = $1`, [row.id]);
                return fetchUserWithin(tx, row.user_id);
            }
            await tx.query(`UPDATE credit_reservations SET status = 'settled' WHERE id = $1`, [row.id]);
            await insertCreditTransaction(tx, {
                userId: row.user_id,
                amount: -amount,
                type: "consume",
                reason: `任务完成补扣(冻结已超时退款): ${row.reason}`,
                balanceAfter: Number(deducted.rows[0].credit_balance || 0),
                operatorUserId: null,
            });
            return fetchUserWithin(tx, row.user_id);
        }

        if (row.status !== "pending") throw new Error(`冻结记录已被处理: ${row.status}`);

        const nextStatus = input.status === "success" ? "settled" : "refunded";
        await tx.query(`UPDATE credit_reservations SET status = $2 WHERE id = $1`, [row.id, nextStatus]);

        if (input.status === "failed") {
            const result = await tx.query<{ credit_balance: string | number }>(
                `UPDATE app_users SET credit_balance = credit_balance + $2, updated_at = NOW() WHERE id = $1 RETURNING credit_balance`,
                [row.user_id, amount],
            );
            await insertCreditTransaction(tx, {
                userId: row.user_id,
                amount,
                type: "refund",
                reason: `任务失败退款: ${row.reason}`,
                balanceAfter: Number(result.rows[0]?.credit_balance || 0),
                operatorUserId: null,
            });
        } else {
            const balanceRow = await tx.query<{ credit_balance: string | number }>(
                `SELECT credit_balance FROM app_users WHERE id = $1 LIMIT 1`,
                [row.user_id],
            );
            await insertCreditTransaction(tx, {
                userId: row.user_id,
                amount: -amount,
                type: "consume",
                reason: row.reason,
                balanceAfter: Number(balanceRow.rows[0]?.credit_balance || 0),
                operatorUserId: null,
            });
        }
        return fetchUserWithin(tx, row.user_id);
    });
}

export async function authenticateUser(username: string, password: string) {
    const user = await findUserByUsername(username);
    if (!user) return null;
    const actualBuffer = Buffer.from(user.passwordHash);
    const expectedBuffer = Buffer.from(hashPassword(password));
    if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) return null;
    return user;
}

export async function readSessionUser() {
    return decodeSession((await cookies()).get(COOKIE_NAME)?.value);
}

export async function writeSessionCookie(user: SessionUser) {
    const forwardedProto = (await headers()).get("x-forwarded-proto") || "";
    const isHttps = process.env.NODE_ENV === "production" ? forwardedProto === "https" : false;
    (await cookies()).set(COOKIE_NAME, encodeSession(user), {
        httpOnly: true,
        sameSite: "lax",
        secure: isHttps,
        path: "/",
        maxAge: expireHours() * 60 * 60,
    });
}

export async function clearSessionCookie() {
    const forwardedProto = (await headers()).get("x-forwarded-proto") || "";
    const isHttps = process.env.NODE_ENV === "production" ? forwardedProto === "https" : false;
    (await cookies()).set(COOKIE_NAME, "", {
        httpOnly: true,
        sameSite: "lax",
        secure: isHttps,
        path: "/",
        maxAge: 0,
    });
}

export function publicUser(user: SessionUser | DbUser) {
    return {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
        role: user.role,
        creditBalance: Number(user.creditBalance || 0),
    };
}
