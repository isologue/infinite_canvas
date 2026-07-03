"use client";

type LogKind = "image" | "video";

export function createUserLogStore<T extends { id: string }>(kind: LogKind) {
    const readAll = async () => {
        const payload = (await fetch(`/api/user/logs/${kind}`, { cache: "no-store" }).then((res) => (res.ok ? res.json() : null)).catch(() => null)) as { data?: { logs?: T[] } } | null;
        return Array.isArray(payload?.data?.logs) ? payload?.data?.logs || [] : [];
    };

    const writeAll = async (logs: T[]) => {
        await fetch(`/api/user/logs/${kind}`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ logs }),
        }).catch(() => null);
    };

    return {
        async iterate<R>(callback: (value: T) => R | Promise<R>) {
            const logs = await readAll();
            for (const log of logs) await callback(log);
        },
        async setItem(id: string, value: T) {
            const logs = await readAll();
            const next = logs.some((item) => item.id === id) ? logs.map((item) => (item.id === id ? value : item)) : [value, ...logs];
            await writeAll(next);
        },
        async removeItem(id: string) {
            const logs = await readAll();
            await writeAll(logs.filter((item) => item.id !== id));
        },
        async replaceAll(logs: T[]) {
            await writeAll(logs);
        },
    };
}
