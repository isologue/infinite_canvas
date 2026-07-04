"use client";

import { useEffect, useMemo, useState } from "react";
import { App, Button, Form, Input, Modal, Popconfirm, Select, Space, Table, Tag } from "antd";
import type { ColumnsType } from "antd/es/table";
import { Pencil, Plus, Trash2 } from "lucide-react";

import { AdminRequired } from "@/components/layout/admin-required";

type AdminUser = {
    id: string;
    username: string;
    displayName: string;
    avatarUrl: string;
    role: "admin" | "user";
};

type UserForm = {
    id?: string;
    username: string;
    displayName: string;
    password?: string;
    role: "admin" | "user";
};

export default function AdminUsersPage() {
    const { message } = App.useApp();
    const [form] = Form.useForm<UserForm>();
    const [users, setUsers] = useState<AdminUser[]>([]);
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [open, setOpen] = useState(false);
    const [editing, setEditing] = useState<AdminUser | null>(null);
    const [keyword, setKeyword] = useState("");

    const loadUsers = async () => {
        setLoading(true);
        try {
            const payload = (await fetch("/api/admin/users", { cache: "no-store" }).then((res) => res.json())) as { code: number; msg?: string; data?: { users?: AdminUser[] } };
            if (payload.code !== 0) throw new Error(payload.msg || "加载失败");
            setUsers(payload.data?.users || []);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "加载失败");
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        void loadUsers();
    }, []);

    const visibleUsers = useMemo(() => {
        const query = keyword.trim().toLowerCase();
        if (!query) return users;
        return users.filter((user) => [user.username, user.displayName, user.role].join(" ").toLowerCase().includes(query));
    }, [keyword, users]);

    const openCreate = () => {
        setEditing(null);
        setOpen(true);
    };

    const openEdit = (user: AdminUser) => {
        setEditing(user);
        setOpen(true);
    };

    useEffect(() => {
        if (!open) return;
        if (editing) {
            form.setFieldsValue({
                id: editing.id,
                username: editing.username,
                displayName: editing.displayName,
                password: "",
                role: editing.role,
            });
        } else {
            form.setFieldsValue({ username: "", displayName: "", password: "", role: "user" });
        }
    }, [open, editing, form]);

    const submit = async () => {
        const values = await form.validateFields();
        setSaving(true);
        try {
            const response = await fetch("/api/admin/users", {
                method: editing ? "PUT" : "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    id: editing?.id,
                    username: values.username,
                    displayName: values.displayName,
                    password: values.password || undefined,
                    role: values.role,
                }),
            });
            const payload = (await response.json()) as { code: number; msg?: string };
            if (!response.ok || payload.code !== 0) throw new Error(payload.msg || "保存失败");
            message.success(editing ? "更新成功" : "创建成功");
            setOpen(false);
            await loadUsers();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "保存失败");
        } finally {
            setSaving(false);
        }
    };

    const remove = async (id: string) => {
        try {
            const response = await fetch("/api/admin/users", {
                method: "DELETE",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ id }),
            });
            const payload = (await response.json()) as { code: number; msg?: string };
            if (!response.ok || payload.code !== 0) throw new Error(payload.msg || "删除失败");
            message.success("删除成功");
            await loadUsers();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "删除失败");
        }
    };

    const columns: ColumnsType<AdminUser> = [
        { title: "用户名", dataIndex: "username", key: "username" },
        { title: "昵称", dataIndex: "displayName", key: "displayName" },
        {
            title: "角色",
            dataIndex: "role",
            key: "role",
            render: (role: AdminUser["role"]) => <Tag color={role === "admin" ? "gold" : "blue"}>{role === "admin" ? "超级管理员" : "普通用户"}</Tag>,
        },
        {
            title: "操作",
            key: "actions",
            width: 180,
            render: (_, record) => (
                <Space wrap>
                    <Button size="small" icon={<Pencil className="size-3.5" />} onClick={() => openEdit(record)}>
                        编辑
                    </Button>
                    <Popconfirm title="确定删除这个用户吗？" okText="删除" cancelText="取消" onConfirm={() => void remove(record.id)}>
                        <Button size="small" danger icon={<Trash2 className="size-3.5" />}>
                            删除
                        </Button>
                    </Popconfirm>
                </Space>
            ),
        },
    ];

    return (
        <AdminRequired>
            <main className="h-full overflow-auto bg-background text-stone-950 dark:text-stone-100">
                <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-10">
                    <div className="flex flex-wrap items-end justify-between gap-4 border-b border-stone-200 pb-6 dark:border-stone-800">
                        <div>
                            <div className="text-xs text-stone-500">超级管理员</div>
                            <h1 className="mt-3 text-3xl font-semibold">用户管理</h1>
                            <p className="mt-2 text-sm text-stone-500">管理用户账号和角色。</p>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                            <Input placeholder="搜索用户名/昵称/角色" value={keyword} onChange={(event) => setKeyword(event.target.value)} className="w-64" />
                            <Button icon={<Plus className="size-4" />} type="primary" onClick={openCreate}>
                                新建用户
                            </Button>
                        </div>
                    </div>

                    <Table rowKey="id" loading={loading} columns={columns} dataSource={visibleUsers} pagination={{ pageSize: 10 }} />
                </div>

                <Modal title={editing ? "编辑用户" : "新建用户"} open={open} onCancel={() => setOpen(false)} onOk={() => void submit()} confirmLoading={saving} destroyOnHidden>
                    <Form form={form} layout="vertical" requiredMark={false}>
                        <Form.Item name="username" label="用户名" rules={[{ required: true, message: "请输入用户名" }]}>
                            <Input />
                        </Form.Item>
                        <Form.Item name="displayName" label="昵称" rules={[{ required: true, message: "请输入昵称" }]}>
                            <Input />
                        </Form.Item>
                        <Form.Item name="password" label={editing ? "密码（留空则不修改）" : "密码"} rules={editing ? [] : [{ required: true, message: "请输入密码" }, { min: 6, message: "密码至少 6 位" }]}>
                            <Input.Password />
                        </Form.Item>
                        <Form.Item name="role" label="角色" rules={[{ required: true, message: "请选择角色" }]}>
                            <Select options={[{ label: "普通用户", value: "user" }, { label: "超级管理员", value: "admin" }]} />
                        </Form.Item>
                    </Form>
                </Modal>
            </main>
        </AdminRequired>
    );
}
