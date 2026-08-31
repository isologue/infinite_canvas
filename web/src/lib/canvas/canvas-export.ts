import { saveAs } from "file-saver";

import { createZip } from "@/lib/zip";

import { resolveImageMimeType } from "@/lib/image-mime";
import { getMediaBlob } from "@/services/file-storage";
import { getImageBlob } from "@/services/image-storage";
import type { CanvasExportAsset, CanvasExportFile } from "@/types/canvas-export";
import { fetchCanvasProject, type CanvasProject, type CanvasProjectSummary } from "@/services/api/canvas-projects";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

type MediaSource = { storageKey?: string; url?: string };

export async function exportCanvasProjects(sources: Array<CanvasProject | CanvasProjectSummary>, fileName = "无限画布") {
    const projects = await Promise.all(sources.map((project) => ("nodes" in project ? project : fetchCanvasProject(project.id))));
    const zipFiles: { name: string; data: BlobPart }[] = [];
    const exportedProjects = await Promise.all(
        projects.map(async (project) => {
            const files: CanvasExportAsset[] = [];
            await Promise.all(
                collectStorageKeys(project).map(async (storageKey) => {
                    const blob = storageKey.startsWith("image:") ? await getImageBlob(storageKey) : await getMediaBlob(storageKey);
                    if (!blob) return;
                    const path = `projects/${project.id}/files/${safeFileName(storageKey)}.${fileExtension(blob.type, storageKey)}`;
                    files.push({ storageKey, path, mimeType: blob.type || "application/octet-stream", bytes: blob.size });
                    zipFiles.push({ name: path, data: blob });
                }),
            );
            return { project, files };
        }),
    );

    const data: CanvasExportFile = { app: "infinite-canvas", version: 3, exportedAt: new Date().toISOString(), projects: exportedProjects };
    const zip = await createZip([{ name: "projects.json", data: JSON.stringify(data, null, 2) }, ...zipFiles]);
    saveAs(zip, `${safeFileName(fileName)}.zip`);
}

export async function exportCanvasNodes(nodes: CanvasNodeData[], fileName = "画布元素") {
    const zipFiles: { name: string; data: BlobPart }[] = [];
    const usedNames = new Set<string>();
    const exportedSources = new Set<string>();
    const uniqueName = (base: string, ext: string) => {
        const safe = safeFileName(base) || "元素";
        let name = `${safe}.${ext}`;
        for (let i = 1; usedNames.has(name); i += 1) name = `${safe}-${i}.${ext}`;
        usedNames.add(name);
        return name;
    };

    for (const node of nodes) {
        if (![CanvasNodeType.Text, CanvasNodeType.Image, CanvasNodeType.Video, CanvasNodeType.Audio].includes(node.type as CanvasNodeType)) continue;
        const title = node.title || node.type;
        let exported = false;
        const allowContentUrl = [CanvasNodeType.Image, CanvasNodeType.Video, CanvasNodeType.Audio].includes(node.type as CanvasNodeType);
        for (const source of collectNodeMediaSources(node)) {
            const sourceId = source.storageKey || source.url;
            if (!sourceId || exportedSources.has(sourceId)) continue;
            const blob = (source.storageKey ? await readStorageBlob(source.storageKey) : null) || (allowContentUrl && source.url ? await readUrlBlob(source.url) : null);
            if (!blob) continue;
            const normalizedBlob = await normalizeExportBlob(blob);
            if (source.storageKey) exportedSources.add(source.storageKey);
            if (source.url) exportedSources.add(source.url);
            zipFiles.push({ name: uniqueName(title, fileExtension(normalizedBlob.type, source.storageKey || source.url || "")), data: normalizedBlob });
            exported = true;
        }

        if (!exported && node.type === CanvasNodeType.Text) {
            const content = node.metadata?.content || node.metadata?.prompt || "";
            if (content.trim()) zipFiles.push({ name: uniqueName(title, "txt"), data: content });
        }
    }

    const zip = await createZip(zipFiles);
    saveAs(zip, `${safeFileName(fileName)}.zip`);
}

async function readStorageBlob(storageKey: string) {
    return storageKey.startsWith("image:") ? getImageBlob(storageKey) : getMediaBlob(storageKey);
}

async function readUrlBlob(url: string) {
    try {
        const response = await fetch(url, { cache: "no-store" });
        return response.ok ? await response.blob() : null;
    } catch {
        return null;
    }
}

async function normalizeExportBlob(blob: Blob) {
    if (!blob.type.startsWith("image/")) return blob;
    const mimeType = resolveImageMimeType(new Uint8Array(await blob.slice(0, 16).arrayBuffer()), blob.type);
    return mimeType && mimeType !== blob.type ? new Blob([blob], { type: mimeType }) : blob;
}

function collectNodeMediaSources(value: unknown, sources: MediaSource[] = [], seen = new Set<string>()) {
    if (!value || typeof value !== "object") return sources;
    if (Array.isArray(value)) {
        value.forEach((item) => collectNodeMediaSources(item, sources, seen));
        return sources;
    }
    const item = value as Record<string, unknown>;
    const storageKey = typeof item.storageKey === "string" && item.storageKey.includes(":") ? item.storageKey : undefined;
    const url = typeof item.content === "string" && isMediaUrl(item.content) ? item.content : undefined;
    const id = storageKey || url;
    if (id && !seen.has(id)) {
        seen.add(id);
        sources.push({ storageKey, url });
    }
    Object.values(item).forEach((child) => collectNodeMediaSources(child, sources, seen));
    return sources;
}

function isMediaUrl(value: string) {
    return value.startsWith("data:") || value.startsWith("blob:") || value.startsWith("/") || /^https?:\/\//i.test(value);
}

function collectStorageKeys(value: unknown, keys = new Set<string>()) {
    if (!value || typeof value !== "object") return [...keys];
    if ("storageKey" in value && typeof value.storageKey === "string" && value.storageKey.includes(":")) keys.add(value.storageKey);
    Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectStorageKeys(child, keys)) : collectStorageKeys(item, keys)));
    return [...keys];
}

function safeFileName(value: string) {
    return value.replace(/[\\/:*?"<>|]/g, "_");
}

function fileExtension(mimeType: string, source: string) {
    if (mimeType.includes("png")) return "png";
    if (mimeType.includes("jpeg")) return "jpg";
    if (mimeType.includes("webp")) return "webp";
    if (mimeType.includes("gif")) return "gif";
    if (mimeType.includes("mp4")) return "mp4";
    if (mimeType.includes("webm")) return "webm";
    if (mimeType.includes("mpeg") || mimeType.includes("mp3")) return "mp3";
    if (mimeType.includes("wav")) return "wav";
    if (mimeType.includes("ogg")) return "ogg";
    const extension = source.split(/[?#]/)[0].match(/\.([a-z0-9]{2,5})$/i)?.[1];
    return extension || (source.startsWith("image:") ? "png" : "bin");
}
