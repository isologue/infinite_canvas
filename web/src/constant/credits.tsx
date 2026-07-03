import type { ComponentProps } from "react";
import { Zap } from "lucide-react";

export function CreditSymbol({ className, ...props }: ComponentProps<"span">) {
    return (
        <span {...props} className={`inline-flex items-center justify-center ${className || ""}`}>
            <Zap className="size-[1em] fill-current" strokeWidth={2.4} />
        </span>
    );
}

export type ModelCreditCost = {
    model: string;
    credits: number;
};

export function defaultGenerationCreditAmount(kind: "image" | "video" | "audio", count?: string | number) {
    if (kind === "image") return Math.max(1, Math.floor(Math.abs(Number(count)) || 1));
    return 1;
}

export function modelCreditCost(modelCosts: ModelCreditCost[] | undefined, model: string) {
    const matched = modelCosts?.find((item) => item.model === model);
    return matched ? Math.max(0, Math.floor(Number(matched.credits) || 0)) : 0;
}

export function requestCreditCost(options: { channelMode: string; modelCosts?: ModelCreditCost[]; model: string; count?: string | number }) {
    const count = Math.max(1, Math.floor(Math.abs(Number(options.count)) || 1));
    return modelCreditCost(options.modelCosts, options.model) * count;
}
