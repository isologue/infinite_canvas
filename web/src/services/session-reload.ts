"use client";

import { useCanvasStore } from "@/app/(user)/canvas/stores/use-canvas-store";
import { flushCanvasProjectSaves } from "@/services/api/canvas-projects";
import { resumeAssetPersist, suspendAssetPersist, useAssetStore } from "@/stores/use-asset-store";
import { useUserStore } from "@/stores/use-user-store";

// 登录 / 退出 / 切换账号后调用：这些 store 用 zustand persist，只在首次加载时 hydrate 一次，
// 之后一直用内存里那份。换账号时必须主动清掉旧数据并重新从服务端拉取，
// 否则会看到上一个账号的画布和素材。

// 把还在 400ms 防抖队列里的画布编辑立即刷到服务端。
// 退出登录前必须先调它（此时旧账号 cookie 仍在），否则清 cookie 后这笔写入会以无用户身份失败而丢失。
export async function flushPendingUserData() {
    await flushCanvasProjectSaves();
}

// 清空内存里的旧账号数据并按当前 cookie 重新拉取。登录成功后、或退出登录（且已 flush）后调用。
export async function reloadUserScopedData() {
    // 关键：先暂停持久化，再清空内存。否则 setState([]) 会触发 setItem 把空状态写回服务端，
    // 覆盖掉用户真实的画布/素材（这正是之前 admin 画布被清空的原因）。
    suspendAssetPersist();
    useCanvasStore.setState({ projects: [], hydrated: false });
    useAssetStore.setState({ assets: [] });
    try {
        // rehydrate() 会重新调各自 storage 的 getItem，按当前 cookie 拉对应用户的数据。
        // rehydrate 内部也会触发 setItem，但此时仍处于暂停状态，不会写回。
        await Promise.all([
            useCanvasStore.getState().loadProjects(),
            useAssetStore.persist.rehydrate(),
            useUserStore.getState().refreshSession(),
        ]);
    } finally {
        // 恢复持久化。此后用户的正常编辑才会重新写服务端。
        resumeAssetPersist();
    }
}
