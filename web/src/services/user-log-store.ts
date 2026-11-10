"use client";

type LogKind = "image" | "video";
const writeQueues = new Map<LogKind, Promise<unknown>>();

export function createUserLogStore<T extends { id: string }>(kind: LogKind) {
    const request = async (method: string, body?: unknown) => {
        const response = await fetch(`/api/user/logs/${kind}`, {
            method, cache: "no-store",
            ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
        });
        const payload = await response.json();
        if (!response.ok || payload?.code !== 0) throw new Error(payload?.msg || `生成记录${method === "GET" ? "读取" : "保存"}失败（HTTP ${response.status}）`);
        return payload;
    };
    const mutate = (method: string, body: unknown) => {
        const next = (writeQueues.get(kind) || Promise.resolve()).catch(() => undefined).then(() => request(method, body));
        writeQueues.set(kind, next);
        // 最后一次保存结束后清理队列，失败不会阻塞后续写入。
        void next.then(() => { if (writeQueues.get(kind) === next) writeQueues.delete(kind); }, () => { if (writeQueues.get(kind) === next) writeQueues.delete(kind); });
        return next.then(() => undefined);
    };
    return {
        async iterate<R>(callback: (value: T) => R | Promise<R>) {
            await writeQueues.get(kind);
            const payload = await request("GET");
            if (!Array.isArray(payload?.data?.logs)) throw new Error("生成记录格式错误");
            for (const log of payload.data.logs as T[]) await callback(log);
        },
        setItem(id: string, value: T) { return mutate("PATCH", { log: { ...value, id } }); },
        removeItem(id: string) { return mutate("DELETE", { ids: [id] }); },
        removeItems(ids: string[]) { return ids.length ? mutate("DELETE", { ids }) : Promise.resolve(); },
        replaceAll(logs: T[]) { return mutate("PUT", { logs }); },
    };
}
