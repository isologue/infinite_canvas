import { createHmac, timingSafeEqual } from "node:crypto";

type StorageSharePayload = {
    userId: string;
    storageKey: string;
    exp: number;
};

const STORAGE_SHARE_TTL_SECONDS = 10 * 60;

function secret() {
    return process.env.JWT_SECRET?.trim() || "infinite-canvas";
}

function sign(value: string) {
    return createHmac("sha256", secret()).update(value).digest("hex");
}

export function createStorageShareToken(userId: string, storageKey: string) {
    const expiresAt = Math.floor(Date.now() / 1000) + STORAGE_SHARE_TTL_SECONDS;
    const payload = Buffer.from(JSON.stringify({ userId, storageKey, exp: expiresAt })).toString("base64url");
    return { token: `${payload}.${sign(payload)}`, expiresAt };
}

export function readStorageShareToken(value: string | null) {
    if (!value) return null;
    const [payload, signature] = value.split(".");
    if (!payload || !signature) return null;
    const expected = sign(payload);
    const actualBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) return null;
    try {
        const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<StorageSharePayload>;
        if (typeof parsed.userId !== "string" || !parsed.userId || typeof parsed.storageKey !== "string" || !parsed.storageKey || typeof parsed.exp !== "number" || parsed.exp <= Math.floor(Date.now() / 1000)) return null;
        return parsed as StorageSharePayload;
    } catch {
        return null;
    }
}
