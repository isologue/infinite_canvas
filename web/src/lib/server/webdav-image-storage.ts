type WebdavImageConfig = {
    enabled?: unknown;
    uploadGeneratedResources?: unknown;
    storageMode?: unknown;
    url?: unknown;
    username?: unknown;
    password?: unknown;
    directory?: unknown;
    publicUrlPrefix?: unknown;
};

type WebdavImageFile = { storageKey: string; mimeType: string; content: Buffer };

export async function uploadUserFileToWebdav(config: WebdavImageConfig, userId: string, file: WebdavImageFile) {
    if (config.enabled !== true || config.storageMode === "local") return "";
    const client = createWebdavClient(config);
    const relativePath = `${safeSegment(userId)}/${safeSegment(file.storageKey)}.${extensionForMimeType(file.mimeType)}`;
    await client.ensureDirectory(relativePath.split("/").slice(0, -1));
    const response = await client.fetch(relativePath, { method: "PUT", headers: { "content-type": file.mimeType }, body: new Uint8Array(file.content) });
    if (!response.ok) throw new Error(`WebDAV 媒体上传失败（HTTP ${response.status}）`);
    return client.publicUrl(relativePath);
}

export const uploadUserImageToWebdav = uploadUserFileToWebdav;

export function shouldUploadSavedResourceToWebdav(config: WebdavImageConfig, source: string) {
    return config.enabled === true && config.storageMode !== "local"
        && (config.uploadGeneratedResources === true || !/^generated(?:-|$)/.test(source));
}

export async function uploadSavedUserFileToWebdav(config: WebdavImageConfig, userId: string, file: WebdavImageFile & { source: string }) {
    return shouldUploadSavedResourceToWebdav(config, file.source) ? uploadUserFileToWebdav(config, userId, file) : "";
}

export async function testWebdavImageStorage(config: WebdavImageConfig) {
    const client = createWebdavClient(config);
    await client.ensureDirectory([]);
    const response = await client.fetch("", { method: "PROPFIND", headers: { Depth: "0" } });
    if (!response.ok && response.status !== 207) throw new Error(`WebDAV 连接测试失败（HTTP ${response.status}）`);
}

function createWebdavClient(config: WebdavImageConfig) {
    const url = requiredUrl(config.url, "WebDAV URL");
    const username = requiredText(config.username, "WebDAV 用户名");
    const password = requiredText(config.password, "WebDAV 密码");
    const directory = pathSegments(typeof config.directory === "string" ? config.directory : "");
    const publicPrefix = requiredUrl(config.publicUrlPrefix, "公开访问前缀");
    const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
    const baseUrl = `${url.replace(/\/+$/, "")}/${directory.map(encodeURIComponent).join("/")}`.replace(/\/$/, "");
    const publicBaseUrl = `${publicPrefix.replace(/\/+$/, "")}`;
    return {
        fetch: (path: string, init: RequestInit) => fetch(path ? `${baseUrl}/${path.split("/").map(encodeURIComponent).join("/")}` : baseUrl, { ...init, headers: { authorization, ...(init.headers || {}) }, cache: "no-store" }),
        ensureDirectory: async (extraSegments: string[]) => {
            const allSegments = [...directory, ...extraSegments];
            for (let index = 0; index < allSegments.length; index += 1) {
                const path = allSegments.slice(0, index + 1).map(encodeURIComponent).join("/");
                const response = await fetch(`${url.replace(/\/+$/, "")}/${path}`, { method: "MKCOL", headers: { authorization }, cache: "no-store" });
                if (![200, 201, 204, 301, 302, 405].includes(response.status)) throw new Error(`创建 WebDAV 目录失败（HTTP ${response.status}）`);
            }
        },
        publicUrl: (path: string) => `${publicBaseUrl}/${path.split("/").map(encodeURIComponent).join("/")}`,
    };
}

function requiredText(value: unknown, label: string) {
    const text = typeof value === "string" ? value.trim() : "";
    if (!text) throw new Error(`请填写${label}`);
    return text;
}

function requiredUrl(value: unknown, label: string) {
    const url = requiredText(value, label);
    try {
        const parsed = new URL(url);
        if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.toString();
    } catch {
        // Fall through to the common validation error below.
    }
    throw new Error(`${label}格式错误`);
}

function pathSegments(path: string) {
    return path.split("/").map((segment) => segment.trim()).filter((segment) => segment && segment !== "." && segment !== "..");
}

function safeSegment(value: string) {
    return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "file";
}

function extensionForMimeType(mimeType: string) {
    if (mimeType === "image/jpeg") return "jpg";
    if (mimeType === "image/webp") return "webp";
    if (mimeType === "image/gif") return "gif";
    if (mimeType === "image/avif") return "avif";
    if (mimeType === "video/mp4" || mimeType === "video/x-m4v") return "mp4";
    if (mimeType === "video/webm") return "webm";
    if (mimeType === "video/quicktime") return "mov";
    if (mimeType === "video/x-msvideo") return "avi";
    if (mimeType === "video/mpeg") return "mpeg";
    if (mimeType === "audio/mpeg") return "mp3";
    if (mimeType === "audio/wav" || mimeType === "audio/x-wav") return "wav";
    if (mimeType === "audio/ogg") return "ogg";
    if (mimeType === "audio/mp4" || mimeType === "audio/x-m4a") return "m4a";
    if (mimeType === "audio/aac") return "aac";
    if (mimeType === "audio/flac") return "flac";
    return "png";
}
