import type { RawPrompt } from "./prompt-source-runtime";
import type { PromptSource } from "./prompt-source-presets";
import type { PromptSourceSchedule, PromptSourceStatus } from "@/lib/server/prompt-source-db";

export type Prompt = RawPrompt & {
    sourceId: string;
    category: string;
    githubUrl: string;
    status?: "active" | "upstream_missing";
};

export const ALL_PROMPTS_OPTION = "all";
export const PROMPT_SOURCE_INTERVALS = [0, 30, 60, 360, 1440];

export type PromptListResponse = { items: Prompt[]; tags: string[]; categories: string[]; total: number };
export type PromptSourceRefreshResult = PromptSourceStatus & { sourceName: string; success: boolean };
export type PromptSourceRefreshSummary = { results: PromptSourceRefreshResult[]; total: number; successCount: number; failureCount: number };
export type PromptSourceSettings = { sources: PromptSource[]; schedule: PromptSourceSchedule; statuses: Record<string, PromptSourceStatus> };

type ApiResponse<T> = { code: number; data?: T; msg?: string };

export function promptCoverSrc(url: string) {
    return (url || "").trim();
}

export async function fetchPrompts({ keyword = "", tag = [], category = ALL_PROMPTS_OPTION, page = 1, pageSize = 20 }: { keyword?: string; tag?: string[]; category?: string; page?: number; pageSize?: number } = {}): Promise<PromptListResponse> {
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (keyword.trim()) params.set("keyword", keyword.trim());
    if (category && category !== ALL_PROMPTS_OPTION && category !== "all") params.set("category", category);
    tag.filter((value) => value && value !== ALL_PROMPTS_OPTION && value !== "all").forEach((value) => params.append("tag", value));
    return api<PromptListResponse>(`/api/prompts?${params}`);
}

export async function fetchSourcePrompts(sourceId: string): Promise<Prompt[]> {
    const params = new URLSearchParams({ sourceId, page: "1", pageSize: "1000" });
    return (await api<PromptListResponse>(`/api/prompts?${params}`)).items;
}

export function fetchPublicPromptSources() {
    return api<{ sources: Array<{ id: string; name: string }> }>("/api/prompts/sources");
}
export function fetchPromptSourceSettings() {
    return api<PromptSourceSettings>("/api/admin/prompt-sources");
}

export async function savePromptSource(source: PromptSource) {
    return api<{ source: PromptSource }>("/api/admin/prompt-sources", { method: "PUT", body: JSON.stringify({ source }) });
}

export function replacePromptSourceSettings(settings: Pick<PromptSourceSettings, "sources" | "schedule">) {
    return api<PromptSourceSettings>("/api/admin/prompt-sources", { method: "POST", body: JSON.stringify({ settings }) });
}
export function togglePromptSource(id: string, enabled: boolean) {
    return api<PromptSourceSettings>("/api/admin/prompt-sources", { method: "PATCH", body: JSON.stringify({ id, enabled }) });
}

export function updatePromptSourceSchedule(intervalMinutes: number) {
    return api<PromptSourceSettings>("/api/admin/prompt-sources", { method: "PATCH", body: JSON.stringify({ intervalMinutes }) });
}

export function deletePromptSource(id: string) {
    return api<void>(`/api/admin/prompt-sources/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function refreshSource(sourceId: string) {
    return api<PromptSourceRefreshResult>(`/api/admin/prompt-sources/${encodeURIComponent(sourceId)}/sync`, { method: "POST" });
}

export function refreshAllSources() {
    return api<PromptSourceRefreshSummary>("/api/admin/prompt-sources/sync-all", { method: "POST" });
}

export function refreshDueSources() {
    return api<PromptSourceRefreshSummary>("/api/admin/prompt-sources/sync-due", { method: "POST" });
}

export function formatPromptDate(value: string, locale?: string) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat(locale, { year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
    const response = await fetch(url, { cache: "no-store", ...init, headers: { "content-type": "application/json", ...init?.headers } });
    const payload = (await response.json().catch(() => null)) as ApiResponse<T> | null;
    if (!response.ok || payload?.code !== 0) throw new Error(payload?.msg || "请求失败");
    return payload?.data as T;
}
