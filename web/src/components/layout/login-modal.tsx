"use client";

import { useState } from "react";
import { App, Form, Input, Modal, Segmented } from "antd";

import { migrateLocalDataToServer } from "@/services/local-data-migration";
import { reloadUserScopedData } from "@/services/session-reload";
import { useConfigStore } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";

type AuthResponse = {
    code: number;
    msg?: string;
    data?: {
        user?: {
            id: string;
            username: string;
            displayName: string;
            avatarUrl: string;
            role: "admin" | "user";
            creditBalance: number;
        };
    };
};

export function LoginModal({ open, onClose }: { open: boolean; onClose: () => void }) {
    const { message } = App.useApp();
    const [mode, setMode] = useState<"login" | "register">("login");
    const [form] = Form.useForm<{ username: string; password: string; displayName?: string }>();
    const [loading, setLoading] = useState(false);
    const setUser = useUserStore((state) => state.setUser);
    const replaceSharedConfig = useConfigStore((state) => state.replaceSharedConfig);

    const submit = async () => {
        const values = await form.validateFields();
        setLoading(true);
        try {
            const response = await fetch(mode === "login" ? "/api/auth/login" : "/api/auth/register", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(values),
            });
            const payload = (await response.json()) as AuthResponse;
            if (!response.ok || payload.code !== 0 || !payload.data?.user) throw new Error(payload.msg || (mode === "login" ? "登录失败" : "注册失败"));

            const migration = await migrateLocalDataToServer(payload.data.user);
            setUser(payload.data.user);
            // 换账号后重新拉取该用户的画布/素材/余额，否则会残留上一个账号的数据。
            await reloadUserScopedData();

            const shared = await fetch("/api/shared-config", { cache: "no-store" }).then((res) => res.json() as Promise<{ data?: { config?: unknown; webdav?: unknown; canManage?: boolean } }>);
            if (shared.data?.config && shared.data?.webdav) {
                replaceSharedConfig({
                    config: shared.data.config as never,
                    webdav: shared.data.webdav as never,
                    canManage: Boolean(shared.data.canManage),
                });
            }

            message.success(mode === "login" ? "登录成功" : "注册成功");
            if (migration.migrated) message.success(`已迁移本地数据：${migration.projects} 个画布，${migration.assets} 个素材，${migration.imageLogs + migration.videoLogs} 条记录`);
            form.resetFields();
            onClose();
        } catch (error) {
            message.error(error instanceof Error ? error.message : mode === "login" ? "登录失败" : "注册失败");
        } finally {
            setLoading(false);
        }
    };

    return (
        <Modal title={mode === "login" ? "登录" : "注册"} open={open} onCancel={onClose} onOk={() => void submit()} okText={mode === "login" ? "登录" : "注册"} cancelText="取消" confirmLoading={loading} destroyOnHidden>
            <div className="mb-4">
                <Segmented
                    block
                    value={mode}
                    onChange={(value) => setMode(value as "login" | "register")}
                    options={[
                        { label: "登录", value: "login" },
                        { label: "注册", value: "register" },
                    ]}
                />
            </div>
            <Form form={form} layout="vertical" requiredMark={false}>
                <Form.Item name="username" label="用户名" rules={[{ required: true, message: "请输入用户名" }]}>
                    <Input autoComplete="username" placeholder="请输入用户名" />
                </Form.Item>
                {mode === "register" ? (
                    <Form.Item name="displayName" label="昵称">
                        <Input placeholder="可选，不填默认同用户名" />
                    </Form.Item>
                ) : null}
                <Form.Item name="password" label="密码" rules={[{ required: true, message: "请输入密码" }, { min: 6, message: "密码至少 6 位" }]}>
                    <Input.Password autoComplete={mode === "login" ? "current-password" : "new-password"} placeholder="请输入密码" />
                </Form.Item>
            </Form>
            <div className="text-xs text-stone-500">只有超级管理员可以编辑配置窗口，普通用户注册登录后可使用个人画布、素材和生成记录。</div>
        </Modal>
    );
}
