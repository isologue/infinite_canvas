"use client";

import { create } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";

import { nanoid } from "nanoid";
import { cleanupUnusedImages, resolveImageUrl, uploadImage } from "@/services/image-storage";
import { cleanupUnusedMedia, resolveMediaUrl } from "@/services/file-storage";

export type AssetKind = "text" | "image" | "video" | "audio";
export type TextAsset = AssetBase<"text"> & { data: { content: string } };
export type ImageAsset = AssetBase<"image"> & { data: { dataUrl: string; storageKey?: string; width: number; height: number; bytes: number; mimeType: string } };
export type VideoAsset = AssetBase<"video"> & { data: { url: string; storageKey?: string; width: number; height: number; bytes: number; mimeType: string } };
export type AudioAsset = AssetBase<"audio"> & { data: { url: string; storageKey?: string; bytes: number; mimeType: string; durationMs?: number } };
export type Asset = TextAsset | ImageAsset | VideoAsset | AudioAsset;

type AssetBase<T extends AssetKind> = {
    id: string;
    kind: T;
    title: string;
    coverUrl: string;
    tags: string[];
    source?: string;
    note?: string;
    createdAt: string;
    updatedAt: string;
    metadata?: Record<string, unknown>;
};

type AssetStore = {
    hydrated: boolean;
    assets: Asset[];
    addAsset: (asset: Omit<Asset, "id" | "createdAt" | "updatedAt">) => string;
    updateAsset: (id: string, patch: Partial<Omit<Asset, "id" | "createdAt">>) => void;
    removeAsset: (id: string) => void;
    replaceAssets: (assets: Asset[]) => void;
    cleanupImages: (extra?: unknown) => void;
};

const ASSET_STORE_KEY = "infinite-canvas:asset_store";
let assetPersistSuspended = false;

// 切换账号/退出时暂停写入，避免清空内存的空状态被写回服务端覆盖真实素材。
export function suspendAssetPersist() {
    assetPersistSuspended = true;
}

export function resumeAssetPersist() {
    assetPersistSuspended = false;
}

const assetStorage: PersistStorage<AssetStore> = {
    getItem: async () => {
        if (typeof window === "undefined") return null;
        try {
            const payload = (await fetch("/api/user/assets", { cache: "no-store" }).then((res) => (res.ok ? res.json() : null))) as { data?: { assets?: Asset[] } } | null;
            const assets = await Promise.all(((payload?.data?.assets || []) as Asset[]).map(hydrateAsset));
            return { state: { assets }, version: 0 } as StorageValue<AssetStore>;
        } catch {
            return { state: { assets: [] as Asset[] }, version: 0 } as StorageValue<AssetStore>;
        }
    },
    setItem: async (_name, value) => {
        if (assetPersistSuspended) return;
        const assets = ((value.state as StorageValue<AssetStore>["state"]).assets || []) as Asset[];
        await fetch("/api/user/assets", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ assets: assets.map(serializeAsset) }),
        }).catch(() => null);
    },
    removeItem: async () => {
        await fetch("/api/user/assets", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ assets: [] }),
        }).catch(() => null);
    },
};

export const useAssetStore = create<AssetStore>()(
    persist(
        (set, get) => ({
            hydrated: false,
            assets: [],
            addAsset: (asset) => {
                const now = new Date().toISOString();
                const id = nanoid();
                set((state) => ({ assets: [{ ...asset, id, createdAt: now, updatedAt: now } as Asset, ...state.assets] }));
                return id;
            },
            updateAsset: (id, patch) =>
                set((state) => ({
                    assets: state.assets.map((asset) => (asset.id === id ? ({ ...asset, ...patch, updatedAt: new Date().toISOString() } as Asset) : asset)),
                })),
            removeAsset: (id) =>
                set((state) => {
                    const assets = state.assets.filter((asset) => asset.id !== id);
                    get().cleanupImages({ assets });
                    return { assets };
                }),
            replaceAssets: (assets) => set({ assets }),
            cleanupImages: (extra) => {
                window.setTimeout(async () => {
                    const { useCanvasStore } = await import("@/app/(user)/canvas/stores/use-canvas-store");
                    await cleanupUnusedImages({ assets: get().assets, projects: useCanvasStore.getState().projects, extra });
                    await cleanupUnusedMedia({ assets: get().assets, projects: useCanvasStore.getState().projects, extra });
                }, 0);
            },
        }),
        {
            name: ASSET_STORE_KEY,
            storage: assetStorage,
            partialize: (state) => ({ assets: state.assets }) as StorageValue<AssetStore>["state"],
            onRehydrateStorage: () => () => {
                useAssetStore.setState({ hydrated: true });
            },
        },
    ),
);

async function hydrateAsset(asset: Asset): Promise<Asset> {
    if ((asset.kind === "video" || asset.kind === "audio") && asset.data.storageKey) return { ...asset, data: { ...asset.data, url: await resolveMediaUrl(asset.data.storageKey, asset.data.url) } };
    if (asset.kind !== "image") return asset;
    if (asset.data.storageKey)
        return {
            ...asset,
            coverUrl: asset.coverUrl.startsWith("blob:") ? await resolveImageUrl(asset.data.storageKey, asset.coverUrl) : asset.coverUrl,
            data: { ...asset.data, dataUrl: await resolveImageUrl(asset.data.storageKey, asset.data.dataUrl) },
        };
    if (!asset.data.dataUrl.startsWith("data:image/")) return asset;
    const image = await uploadImage(asset.data.dataUrl);
    return { ...asset, coverUrl: asset.coverUrl.startsWith("data:image/") ? image.url : asset.coverUrl, data: { ...asset.data, dataUrl: image.url, storageKey: image.storageKey, bytes: image.bytes, mimeType: image.mimeType } };
}

function serializeAsset(asset: Asset): Asset {
    if (asset.kind === "video" || asset.kind === "audio") return asset.data.storageKey ? { ...asset, coverUrl: "", data: { ...asset.data, url: "" } } : asset;
    if (asset.kind === "image") return asset.data.storageKey ? { ...asset, coverUrl: "", data: { ...asset.data, dataUrl: "" } } : asset;
    return asset;
}
