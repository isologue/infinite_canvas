"use client";

import localforage from "localforage";
import type { StorageValue } from "zustand/middleware";

import { collectMediaStorageKeys } from "@/services/file-storage";
import { collectImageStorageKeys } from "@/services/image-storage";
import type { CanvasProject } from "@/app/(user)/canvas/stores/use-canvas-store";
import type { Asset } from "@/stores/use-asset-store";
import type { LocalUser } from "@/stores/use-user-store";

type StoredLog = Record<string, unknown> & { id?: string };

type MigrationResult = {
    migrated: boolean;
    projects: number;
    assets: number;
    imageLogs: number;
    videoLogs: number;
    files: number;
};

const MIGRATION_VERSION = 2;
const APP_DB_NAME = "infinite-canvas";
const APP_STATE_STORE = "app_state";
const IMAGE_FILE_STORE = "image_files";
const MEDIA_FILE_STORE = "media_files";
const IMAGE_LOG_STORE = "image_generation_logs";
const VIDEO_LOG_STORE = "video_generation_logs";

export async function migrateLocalDataToServer(user: LocalUser): Promise<MigrationResult> {
    if (typeof window === "undefined") return emptyResult();
    const marker = migrationMarker(user.id);
    if (window.localStorage.getItem(marker) === "1") return emptyResult();

    const [serverProjects, serverAssets, serverImageLogs, serverVideoLogs, localProjects, localAssets, localImageLogs, localVideoLogs] = await Promise.all([
        readRemoteArray<unknown>("/api/user/projects", "projects"),
        readRemoteArray<Asset>("/api/user/assets", "assets"),
        readRemoteArray<StoredLog>("/api/user/logs/image", "logs"),
        readRemoteArray<StoredLog>("/api/user/logs/video", "logs"),
        readLegacyProjects(),
        readLegacyAssets(),
        readLegacyLogs("image"),
        readLegacyLogs("video"),
    ]);

    const nextProjects = !serverProjects.length && localProjects.length ? sanitizeProjects(localProjects) : [];
    const nextAssets = !serverAssets.length && localAssets.length ? sanitizeAssets(localAssets) : [];
    const nextImageLogs = !serverImageLogs.length && localImageLogs.length ? sanitizeImageLogs(localImageLogs) : [];
    const nextVideoLogs = !serverVideoLogs.length && localVideoLogs.length ? sanitizeVideoLogs(localVideoLogs) : [];

    if (!nextProjects.length && !nextAssets.length && !nextImageLogs.length && !nextVideoLogs.length) {
        window.localStorage.setItem(marker, "1");
        return emptyResult();
    }

    const imageKeys = Array.from(
        collectImageStorageKeys({
            projects: nextProjects,
            assets: nextAssets,
            imageLogs: nextImageLogs,
            videoLogs: nextVideoLogs,
        }),
    );
    const mediaKeys = Array.from(
        collectMediaStorageKeys({
            projects: nextProjects,
            assets: nextAssets,
            imageLogs: nextImageLogs,
            videoLogs: nextVideoLogs,
        }),
    );

    const uploadedFiles = await uploadLegacyFiles(imageKeys, mediaKeys);
    const writeResults = await Promise.all([
        nextProjects.length ? writeRemoteProjects(nextProjects) : Promise.resolve(true),
        nextAssets.length ? writeRemoteArray("/api/user/assets", "assets", nextAssets) : Promise.resolve(true),
        nextImageLogs.length ? writeRemoteArray("/api/user/logs/image", "logs", nextImageLogs) : Promise.resolve(true),
        nextVideoLogs.length ? writeRemoteArray("/api/user/logs/video", "logs", nextVideoLogs) : Promise.resolve(true),
    ]);

    if (uploadedFiles.success && writeResults.every(Boolean)) window.localStorage.setItem(marker, "1");

    return {
        migrated: uploadedFiles.success && writeResults.every(Boolean) && Boolean(nextProjects.length || nextAssets.length || nextImageLogs.length || nextVideoLogs.length || uploadedFiles.files),
        projects: nextProjects.length,
        assets: nextAssets.length,
        imageLogs: nextImageLogs.length,
        videoLogs: nextVideoLogs.length,
        files: uploadedFiles.files,
    };
}

function emptyResult(): MigrationResult {
    return { migrated: false, projects: 0, assets: 0, imageLogs: 0, videoLogs: 0, files: 0 };
}

function migrationMarker(userId: string) {
    return `infinite-canvas:postgres-migrated:${userId}:v${MIGRATION_VERSION}`;
}

async function readRemoteArray<T>(url: string, field: string): Promise<T[]> {
    const payload = (await fetch(url, { cache: "no-store" }).then((res) => (res.ok ? res.json() : null)).catch(() => null)) as { data?: Record<string, unknown> } | null;
    const value = payload?.data?.[field];
    return Array.isArray(value) ? (value as T[]) : [];
}

async function writeRemoteArray(url: string, field: string, value: unknown[]) {
    return fetch(url, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ [field]: value }),
    })
        .then((res) => res.ok)
        .catch(() => false);
}

async function writeRemoteProjects(projects: CanvasProject[]) {
    const results = await Promise.all(projects.map((project) => fetch("/api/user/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ project }),
    }).then((res) => res.ok).catch(() => false)));
    return results.every(Boolean);
}

async function readLegacyProjects() {
    const state = await readLegacyPersistState<{ projects?: CanvasProject[] }>("infinite-canvas:canvas_store");
    return Array.isArray(state?.projects) ? state.projects : [];
}

async function readLegacyAssets() {
    const state = await readLegacyPersistState<{ assets?: Asset[] }>("infinite-canvas:asset_store");
    return Array.isArray(state?.assets) ? state.assets : [];
}

async function readLegacyLogs(kind: "image" | "video") {
    const store = localforage.createInstance({ name: APP_DB_NAME, storeName: kind === "image" ? IMAGE_LOG_STORE : VIDEO_LOG_STORE });
    const items: StoredLog[] = [];
    await store.iterate<StoredLog, void>((value) => {
        items.push(value);
    });
    return items;
}

async function readLegacyPersistState<T>(key: string) {
    const store = localforage.createInstance({ name: APP_DB_NAME, storeName: APP_STATE_STORE });
    const raw = await store.getItem<string>(key);
    if (!raw) return null;
    try {
        return (JSON.parse(raw) as StorageValue<T>).state;
    } catch {
        return null;
    }
}

function sanitizeProjects(projects: CanvasProject[]) {
    return projects.map((project) => sanitizeStorageUrls(project) as CanvasProject);
}

function sanitizeAssets(assets: Asset[]) {
    return assets.map((asset) => {
        if ((asset.kind === "video" || asset.kind === "audio") && asset.data.storageKey) return { ...asset, coverUrl: "", data: { ...asset.data, url: "" } };
        if (asset.kind === "image" && asset.data.storageKey) return { ...asset, coverUrl: "", data: { ...asset.data, dataUrl: "" } };
        return asset;
    });
}

function sanitizeImageLogs(logs: StoredLog[]) {
    return logs.map((log) => {
        const next = sanitizeStorageUrls(log) as StoredLog;
        next.thumbnails = [];
        return next;
    });
}

function sanitizeVideoLogs(logs: StoredLog[]) {
    return logs.map((log) => sanitizeStorageUrls(log) as StoredLog);
}

function sanitizeStorageUrls<T>(value: T): T {
    if (!value || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map((item) => sanitizeStorageUrls(item)) as T;
    const next: Record<string, unknown> = { ...(value as Record<string, unknown>) };
    const storageKey = typeof next.storageKey === "string" ? next.storageKey : "";
    if (storageKey) {
        if ("content" in next) next.content = "";
        if ("dataUrl" in next) next.dataUrl = "";
        if ("url" in next) next.url = "";
        if ("coverUrl" in next) next.coverUrl = "";
    }
    Object.keys(next).forEach((key) => {
        const item = next[key];
        if (item && typeof item === "object") next[key] = sanitizeStorageUrls(item);
    });
    return next as T;
}

async function uploadLegacyFiles(imageKeys: string[], mediaKeys: string[]) {
    const imageStore = localforage.createInstance({ name: APP_DB_NAME, storeName: IMAGE_FILE_STORE });
    const mediaStore = localforage.createInstance({ name: APP_DB_NAME, storeName: MEDIA_FILE_STORE });
    let files = 0;
    let success = true;

    for (const key of imageKeys) {
        const blob = await imageStore.getItem<Blob>(key);
        if (!blob) continue;
        success = (await uploadLegacyBlob(key, blob)) && success;
        files += 1;
    }
    for (const key of mediaKeys) {
        const blob = await mediaStore.getItem<Blob>(key);
        if (!blob) continue;
        success = (await uploadLegacyBlob(key, blob)) && success;
        files += 1;
    }

    return { files, success };
}

async function uploadLegacyBlob(storageKey: string, blob: Blob) {
    return fetch("/api/storage/files", {
        method: "POST",
        headers: {
            "content-type": "application/octet-stream",
            "x-storage-key": storageKey,
            "x-storage-mime-type": blob.type || "application/octet-stream",
            "x-resource-source": "local-migration",
        },
        body: await blob.arrayBuffer(),
    })
        .then((res) => res.ok)
        .catch(() => false);
}
