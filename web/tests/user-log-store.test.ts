import { afterEach, expect, test } from "bun:test";
import { createUserLogStore } from "../src/services/user-log-store";
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("concurrent logs update independently and re-entry waits for pending writes", async () => {
    const stored = new Map<string, { id: string; status: string }>();
    const calls: string[] = [];
    globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
        calls.push(init.method!);
        await new Promise(resolve => setTimeout(resolve, 2));
        if (init.method === "PATCH") { const { log } = JSON.parse(init.body as string); stored.set(log.id, log); }
        return Response.json({ code: 0, data: { logs: [...stored.values()] } });
    }) as typeof fetch;
    const store = createUserLogStore<{ id: string; status: string }>("image");
    const otherPage = createUserLogStore<{ id: string; status: string }>("image");
    const a = store.setItem("a", { id: "a", status: "success" });
    const b = otherPage.setItem("b", { id: "b", status: "failed" });
    const read: string[] = [];
    await otherPage.iterate(item => { read.push(item.status); });
    await Promise.all([a, b]);
    expect(calls).toEqual(["PATCH", "PATCH", "GET"]);
    expect(read).toEqual(["success", "failed"]);
});
test("failed saves are reported and do not poison following writes", async () => {
    globalThis.fetch = (async () => Response.json({ code: 401, msg: "请先登录" }, { status: 401 })) as typeof fetch;
    const store = createUserLogStore<{ id: string }>("image");
    await expect(store.setItem("a", { id: "a" })).rejects.toThrow("请先登录");
    globalThis.fetch = (async () => Response.json({ code: 0, data: { logs: [] } })) as typeof fetch;
    await store.setItem("b", { id: "b" });
});
test("failed reads never overwrite history with an empty list", async () => {
    globalThis.fetch = (async () => Response.json({ code: 500, msg: "数据库读取失败" }, { status: 500 })) as typeof fetch;
    const store = createUserLogStore<{ id: string }>("image");
    await expect(store.iterate(() => undefined)).rejects.toThrow("数据库读取失败");
});
