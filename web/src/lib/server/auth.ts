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
};

export type DbUser = SessionUser & {
    passwordHash: string;
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
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
}

export async function createAdminUserIfMissing() {
    await ensureUserTables();
    const db = getPgPool();
    await db.query(
        `
        INSERT INTO app_users (id, username, display_name, avatar_url, password_hash, role)
        VALUES ($1, $2, $3, '', $4, 'admin')
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

type UserRow = { id: string; username: string; display_name: string; avatar_url: string; role: "admin" | "user"; password_hash: string };

function mapUser(row?: UserRow | null): DbUser | null {
    if (!row) return null;
    return {
        id: row.id,
        username: row.username,
        displayName: row.display_name,
        avatarUrl: row.avatar_url,
        role: row.role,
        passwordHash: row.password_hash,
    };
}

const USER_COLUMNS = `id, username, display_name, avatar_url, role, password_hash`;

export async function findUserByUsername(username: string) {
    await createAdminUserIfMissing();
    const db = getPgPool();
    const result = await db.query<UserRow>(`SELECT ${USER_COLUMNS} FROM app_users WHERE username = $1 LIMIT 1`, [username.trim()]);
    return mapUser(result.rows[0] || null);
}

export async function findUserById(id: string) {
    await createAdminUserIfMissing();
    const db = getPgPool();
    const result = await db.query<UserRow>(`SELECT ${USER_COLUMNS} FROM app_users WHERE id = $1 LIMIT 1`, [id]);
    return mapUser(result.rows[0] || null);
}

export async function listUsers(): Promise<DbUser[]> {
    await createAdminUserIfMissing();
    const db = getPgPool();
    const result = await db.query<UserRow>(`SELECT ${USER_COLUMNS} FROM app_users ORDER BY created_at ASC`);
    return result.rows.map((row: UserRow) => mapUser(row)!).filter(Boolean);
}

export async function createUser(input: { username: string; password: string; displayName?: string; role?: "admin" | "user" }) {
    await createAdminUserIfMissing();
    const db = getPgPool();
    const username = input.username.trim();
    const displayName = (input.displayName || username).trim() || username;
    const passwordHash = hashPassword(input.password);
    const id = randomUUID();
    const result = await db.query<UserRow>(
        `
        INSERT INTO app_users (id, username, display_name, avatar_url, password_hash, role)
        VALUES ($1, $2, $3, '', $4, $5)
        RETURNING ${USER_COLUMNS}
        `,
        [id, username, displayName, passwordHash, input.role || "user"],
    );
    return mapUser(result.rows[0])!;
}

export async function updateUser(input: { id: string; username?: string; displayName?: string; password?: string; role?: "admin" | "user" }) {
    await createAdminUserIfMissing();
    const current = await findUserById(input.id);
    if (!current) return null;
    const db = getPgPool();
    const username = input.username?.trim() || current.username;
    const displayName = input.displayName?.trim() || current.displayName;
    const passwordHash = input.password ? hashPassword(input.password) : current.passwordHash;
    const role = input.role || current.role;
    const result = await db.query<UserRow>(
        `
        UPDATE app_users
        SET username = $2,
            display_name = $3,
            password_hash = $4,
            role = $5,
            updated_at = NOW()
        WHERE id = $1
        RETURNING ${USER_COLUMNS}
        `,
        [input.id, username, displayName, passwordHash, role],
    );
    return mapUser(result.rows[0] || null);
}

export async function deleteUser(id: string) {
    await createAdminUserIfMissing();
    const db = getPgPool();
    await db.query(`DELETE FROM app_users WHERE id = $1`, [id]);
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
    };
}
