import { afterEach, beforeEach, expect, test } from "bun:test";
import localforage from "localforage";
import { migrateLocalDataToServer } from "../src/services/local-data-migration";
import type { LocalUser } from "../src/stores/use-user-store";

const originalFetch = globalThis.fetch;
const originalCreateInstance = localforage.createInstance;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const markers = new Map<string, string>();
let localImages: { id: string }[] = [];
const user: LocalUser = { id: "migration-test", username: "test", displayName: "test", avatarUrl: "", role: "user" };

beforeEach(() => {
    markers.clear();
    localImages = [];
    Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: { getItem: (key: string) => markers.get(key), setItem: (key: string, value: string) => markers.set(key, value) } } });
    localforage.createInstance = ((options: LocalForageOptions) => ({
        getItem: async () => null,
        iterate: async (callback: (value: { id: string }) => void) => { if (options.storeName === "image_generation_logs") localImages.forEach(callback); },
    })) as typeof localforage.createInstance;
});
afterEach(() => {
    globalThis.fetch = originalFetch;
    localforage.createInstance = originalCreateInstance;
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
});

test("a clean browser does not download server history during login migration", async () => {
    globalThis.fetch = (async () => { throw new Error("migration must not request the server"); }) as typeof fetch;
    expect((await migrateLocalDataToServer(user)).migrated).toBe(false);
    expect(markers.size).toBe(1);
});

test("migration only checks data types with local records and preserves existing server history", async () => {
    localImages = [{ id: "local" }];
    const urls: string[] = [];
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
        expect(init?.method).toBeUndefined();
        urls.push(String(url));
        return Response.json({ code: 0, data: { logs: [{ id: "server" }] } });
    }) as typeof fetch;
    expect((await migrateLocalDataToServer(user)).migrated).toBe(false);
    expect(urls).toEqual(["/api/user/logs/image"]);
});

test("failed or malformed server reads never trigger migration writes or set the completion marker", async () => {
    localImages = [{ id: "local" }];
    for (const response of [() => Response.json({}, { status: 500 }), () => Response.json({ code: 1 }), () => new Response("partial JSON")]) {
        let reads = 0;
        globalThis.fetch = (async (_url: unknown, init?: RequestInit) => { expect(init?.method).toBeUndefined(); reads++; return response(); }) as typeof fetch;
        await expect(migrateLocalDataToServer(user)).rejects.toThrow();
        expect(reads).toBe(1);
        expect(markers.size).toBe(0);
    }
});

test("local records still migrate when the corresponding server list is empty", async () => {
    localImages = [{ id: "local" }];
    const methods: string[] = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
        methods.push(init?.method || "GET");
        if (init?.method === "PUT") expect(JSON.parse(init.body as string).logs[0].id).toBe("local");
        return Response.json({ code: 0, data: { logs: [] } });
    }) as typeof fetch;
    expect((await migrateLocalDataToServer(user)).imageLogs).toBe(1);
    expect(methods).toEqual(["GET", "PUT"]);
    expect(markers.size).toBe(1);
});
