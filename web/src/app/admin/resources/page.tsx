"use client";
import { useState } from "react";
import { Tabs } from "antd";
import { AdminRequired } from "@/components/layout/admin-required";
import { PromptResourcesTab } from "./components/prompt-resources-tab";
import { UserResourcesTab } from "./components/user-resources-tab";

export default function AdminResourcesPage() {
    const [tab, setTab] = useState("user");
    return <AdminRequired><div className="flex h-full flex-col bg-background"><div className="px-6 pt-4"><Tabs activeKey={tab} onChange={setTab} items={[{ key: "user", label: "用户资源" }, { key: "prompt", label: "提示词资源" }]} /></div><div className="min-h-0 flex-1">{tab === "user" ? <UserResourcesTab /> : <PromptResourcesTab />}</div></div></AdminRequired>;
}
