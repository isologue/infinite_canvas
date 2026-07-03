"use client";

import { useEffect, useMemo, useState } from "react";
import { App, Button, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Table, Tag } from "antd";
import type { ColumnsType } from "antd/es/table";
import { History, Pencil, Plus, Trash2, Wallet } from "lucide-react";

import { AdminRequired } from "@/components/layout/admin-required";

type AdminUser = {
    id: string;
    username: string;
    displayName: string;
    avatarUrl: string;
    role: "admin" | "user";
    creditBalance: number;
    reservedCredits: number;
};

type CreditTransaction = {
    id: string;
    amount: number;
    type: "consume" | "refund" | "admin_adjust";
    reason: string;
    balanceAfter: number;
    createdAt: string;
};

type CreditReservation = {
    id: string;
    amount: number;
    status: "pending" | "settled" | "refunded" | "expired";
    reason: string;
    createdAt: string;
    expiresAt: string;
};

const RESERVATION_STATUS_META: Record<CreditReservation["status"], { label: string; color: string }> = {
    pending: { label: "处理中", color: "processing" },
    settled: { label: "已结算", color: "default" },
    refunded: { label: "已退款", color: "success" },
    expired: { label: "超时退款", color: "warning" },
};

type UserForm = {
    id?: string;
    username: string;
    displayName: string;
    password?: string;
    role: "admin" | "user";
    creditBalance: number;
};

type CreditForm = {
    amount: number;
    action: "refund" | "consume";
    reason: string;
};

export default function AdminUsersPage() {
    const { message } = App.useApp();
    const [form] = Form.useForm<UserForm>();
    const [creditForm] = Form.useForm<CreditForm>();
    const [users, setUsers] = useState<AdminUser[]>([]);
    const [transactions, setTransactions] = useState<CreditTransaction[]>([]);
    const [reservations, setReservations] = useState<CreditReservation[]>([]);
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [creditSaving, setCreditSaving] = useState(false);
    const [open, setOpen] = useState(false);
    const [editing, setEditing] = useState<AdminUser | null>(null);
    const [keyword, setKeyword] = useState("");
    const [creditOpen, setCreditOpen] = useState(false);
    const [historyOpen, setHistoryOpen] = useState(false);
    const [activeUser, setActiveUser] = useState<AdminUser | null>(null);

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

    const openCreditAdjust = (user: AdminUser) => {
        setActiveUser(user);
        setCreditOpen(true);
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
                creditBalance: editing.creditBalance,
            });
        } else {
            form.setFieldsValue({ username: "", displayName: "", password: "", role: "user", creditBalance: 0 });
        }
    }, [open, editing, form]);

    useEffect(() => {
        if (!creditOpen) return;
        creditForm.setFieldsValue({ amount: 1, action: "refund", reason: "管理员调整点数" });
    }, [creditOpen, creditForm]);

    const openCreditHistory = async (user: AdminUser) => {
        setActiveUser(user);
        setHistoryOpen(true);
        try {
            const payload = (await fetch(`/api/admin/users/${user.id}/credits`, { cache: "no-store" }).then((res) => res.json())) as { code: number; msg?: string; data?: { transactions?: CreditTransaction[]; reservations?: CreditReservation[] } };
            if (payload.code !== 0) throw new Error(payload.msg || "加载失败");
            setTransactions(payload.data?.transactions || []);
            setReservations(payload.data?.reservations || []);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "加载失败");
        }
    };

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
                    creditBalance: Number(values.creditBalance || 0),
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

    const adjustCredits = async () => {
        if (!activeUser) return;
        const values = await creditForm.validateFields();
        setCreditSaving(true);
        try {
            const response = await fetch(`/api/admin/users/${activeUser.id}/credits`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    amount: Number(values.amount || 0),
                    action: values.action,
                    reason: values.reason,
                }),
            });
            const payload = (await response.json()) as { code: number; msg?: string };
            if (!response.ok || payload.code !== 0) throw new Error(payload.msg || "调整失败");
            message.success("点数调整成功");
            setCreditOpen(false);
            await loadUsers();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "调整失败");
        } finally {
            setCreditSaving(false);
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
        { title: "点数余额", dataIndex: "creditBalance", key: "creditBalance", width: 120 },
        {
            title: "冻结中",
            dataIndex: "reservedCredits",
            key: "reservedCredits",
            width: 100,
            render: (value: number) => (value > 0 ? <Tag color="processing">{value}</Tag> : <span className="text-stone-400">—</span>),
        },
        {
            title: "操作",
            key: "actions",
            width: 260,
            render: (_, record) => (
                <Space wrap>
                    <Button size="small" icon={<Pencil className="size-3.5" />} onClick={() => openEdit(record)}>
                        编辑
                    </Button>
                    <Button size="small" icon={<Wallet className="size-3.5" />} onClick={() => openCreditAdjust(record)}>
                        调点数
                    </Button>
                    <Button size="small" icon={<History className="size-3.5" />} onClick={() => void openCreditHistory(record)}>
                        流水
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

    const historyColumns: ColumnsType<CreditTransaction> = [
        { title: "时间", dataIndex: "createdAt", key: "createdAt", render: (value: string) => new Date(value).toLocaleString("zh-CN") },
        { title: "类型", dataIndex: "type", key: "type", render: (value: CreditTransaction["type"]) => (value === "consume" ? "消费" : value === "refund" ? "返还" : "管理员调整") },
        { title: "变更", dataIndex: "amount", key: "amount", render: (value: number) => <span className={value >= 0 ? "text-emerald-600" : "text-red-500"}>{value}</span> },
        { title: "余额", dataIndex: "balanceAfter", key: "balanceAfter" },
        { title: "原因", dataIndex: "reason", key: "reason" },
    ];

    const reservationColumns: ColumnsType<CreditReservation> = [
        { title: "时间", dataIndex: "createdAt", key: "createdAt", render: (value: string) => new Date(value).toLocaleString("zh-CN") },
        {
            title: "状态",
            dataIndex: "status",
            key: "status",
            render: (value: CreditReservation["status"]) => <Tag color={RESERVATION_STATUS_META[value].color}>{RESERVATION_STATUS_META[value].label}</Tag>,
        },
        { title: "冻结点数", dataIndex: "amount", key: "amount" },
        { title: "到期时间", dataIndex: "expiresAt", key: "expiresAt", render: (value: string) => new Date(value).toLocaleString("zh-CN") },
        { title: "原因", dataIndex: "reason", key: "reason" },
    ];

    return (
        <AdminRequired>
            <main className="h-full overflow-auto bg-background text-stone-950 dark:text-stone-100">
                <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-10">
                    <div className="flex flex-wrap items-end justify-between gap-4 border-b border-stone-200 pb-6 dark:border-stone-800">
                        <div>
                            <div className="text-xs text-stone-500">超级管理员</div>
                            <h1 className="mt-3 text-3xl font-semibold">用户管理</h1>
                            <p className="mt-2 text-sm text-stone-500">管理用户账号、角色、点数余额、点数额度和点数流水。</p>
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
                        <Form.Item name="creditBalance" label="点数余额">
                            <InputNumber className="w-full" min={0} precision={0} />
                        </Form.Item>
                    </Form>
                </Modal>

                <Modal title={`调整点数${activeUser ? `：${activeUser.username}` : ""}`} open={creditOpen} onCancel={() => setCreditOpen(false)} onOk={() => void adjustCredits()} confirmLoading={creditSaving} destroyOnHidden>
                    <Form form={creditForm} layout="vertical" requiredMark={false}>
                        <Form.Item name="action" label="操作类型" rules={[{ required: true, message: "请选择操作类型" }]}>
                            <Select options={[{ label: "增加点数", value: "refund" }, { label: "扣减点数", value: "consume" }]} />
                        </Form.Item>
                        <Form.Item name="amount" label="点数" rules={[{ required: true, message: "请输入点数" }]}>
                            <InputNumber className="w-full" min={1} precision={0} />
                        </Form.Item>
                        <Form.Item name="reason" label="原因" rules={[{ required: true, message: "请输入原因" }]}>
                            <Input />
                        </Form.Item>
                    </Form>
                </Modal>

                <Modal title={`点数流水${activeUser ? `：${activeUser.username}` : ""}`} open={historyOpen} footer={null} onCancel={() => setHistoryOpen(false)} width={900} destroyOnHidden>
                    <div className="mb-2 text-sm font-medium text-stone-700 dark:text-stone-300">点数流水</div>
                    <Table rowKey="id" columns={historyColumns} dataSource={transactions} pagination={{ pageSize: 8 }} />
                    <div className="mb-2 mt-6 text-sm font-medium text-stone-700 dark:text-stone-300">冻结记录</div>
                    <Table rowKey="id" columns={reservationColumns} dataSource={reservations} pagination={{ pageSize: 5 }} locale={{ emptyText: "暂无冻结记录" }} />
                </Modal>
            </main>
        </AdminRequired>
    );
}
