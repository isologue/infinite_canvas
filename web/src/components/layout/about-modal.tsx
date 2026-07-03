"use client";

import { useState, type CSSProperties } from "react";
import { Info } from "lucide-react";
import { Modal } from "antd";

import { APP_VERSION } from "@/constant/env";

type AboutModalProps = {
    className?: string;
    style?: CSSProperties;
};

export function AboutModal({ className, style }: AboutModalProps) {
    const [open, setOpen] = useState(false);

    return (
        <>
            <button
                type="button"
                className={className || "inline-flex size-7 shrink-0 items-center justify-center text-stone-600 transition hover:text-stone-950 dark:text-stone-300 dark:hover:text-white [&_svg]:size-4"}
                style={style}
                onClick={() => setOpen(true)}
                aria-label="关于"
                title="关于"
            >
                <Info className="size-4" />
            </button>
            <Modal title="关于" open={open} centered footer={null} onCancel={() => setOpen(false)}>
                <div className="space-y-3 text-sm leading-6 text-stone-700 dark:text-stone-300">
                    <div>
                        <div className="text-xs text-stone-500 dark:text-stone-400">版本号</div>
                        <div className="mt-1 text-base font-semibold text-stone-950 dark:text-stone-100">{APP_VERSION}</div>
                    </div>
                    <div>
                        项目为二开，感谢作者：
                        <a className="ml-1 text-blue-600 hover:underline dark:text-blue-400" target="_blank" rel="noreferrer">
                            basketikun
                        </a>
                    </div>
                    <div>
                        画布问题反馈+v：
                        <a className="ml-1 text-blue-600 hover:underline dark:text-blue-400" target="_blank" rel="noreferrer">
                            Milo_wr
                        </a>
                    </div>
                </div>
            </Modal>
        </>
    );
}
