type ReferenceAsset = { url?: string; dataUrl?: string; storageKey?: string };

type PublicUrlResponse = { code?: number; data?: { url?: string; expiresAt?: number } };

const publicUrlCache = new Map<string, { url: string; expiresAt: number }>();

export function isHttpMediaUrl(value?: string): value is string {
    return /^https?:\/\//i.test(value || "");
}

export async function getPublicStorageUrl(storageKey: string) {
    const cached = publicUrlCache.get(storageKey);
    if (cached && cached.expiresAt > Date.now() + 30_000) return cached.url;
    const response = await fetch("/api/storage/public-url", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ storageKey }),
    });
    const payload = await response.json().catch(() => ({})) as PublicUrlResponse;
    if (!response.ok || payload.code !== 0 || !payload.data?.url) return null;
    const expiresAt = Number(payload.data.expiresAt || 0) * 1000;
    publicUrlCache.set(storageKey, { url: payload.data.url, expiresAt });
    return payload.data.url;
}

export async function resolveReferenceAssetUrl(asset: ReferenceAsset) {
    const directUrl = [asset.url, asset.dataUrl].find(isHttpMediaUrl);
    if (directUrl) return directUrl;
    if (!asset.storageKey) return null;
    try {
        return await getPublicStorageUrl(asset.storageKey);
    } catch {
        return null;
    }
}
