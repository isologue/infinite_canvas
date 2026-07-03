import axios from "axios";

import { audioMimeType, normalizeAudioFormatValue, normalizeAudioSpeedValue, normalizeAudioVoiceValue } from "@/lib/audio-generation";
import { requestCreditCost } from "@/constant/credits";
import { uploadMediaFile, type UploadedFile } from "@/services/file-storage";
import { reserveUserCredits, settleUserCreditReservation } from "@/services/user-credits";
import { reportAiCall } from "@/services/ai-call-log";
import { buildApiUrl, modelOptionName, resolveModelRequestConfig, type AiConfig } from "@/stores/use-config-store";

type RequestOptions = { signal?: AbortSignal };

function aiApiUrl(config: AiConfig, path: string) {
    return buildApiUrl(config.baseUrl, path);
}

function aiHeaders(config: AiConfig) {
    return {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
    };
}

export async function requestAudioGeneration(config: AiConfig, prompt: string, options?: RequestOptions): Promise<Blob> {
    const requestConfig = resolveModelRequestConfig(config, config.model || config.audioModel);
    const model = requestConfig.model.trim();
    assertAudioConfig(requestConfig, model);
    const format = normalizeAudioFormatValue(config.audioFormat);
    const instructions = config.audioInstructions.trim();
    const selectedModel = config.model || config.audioModel;
    const amount = requestCreditCost({ channelMode: config.channelMode, modelCosts: config.modelCosts, model: selectedModel, count: 1 });

    const reservation = amount > 0 ? await reserveUserCredits(amount, `audio generation: ${modelOptionName(selectedModel)}`) : null;
    try {
        const response = await axios.post<Blob>(
            aiApiUrl(requestConfig, "/audio/speech"),
            {
                model,
                input: prompt,
                voice: normalizeAudioVoiceValue(config.audioVoice),
                response_format: format,
                speed: Number(normalizeAudioSpeedValue(config.audioSpeed)),
                ...(instructions ? { instructions } : {}),
            },
            { headers: aiHeaders(requestConfig), responseType: "blob", signal: options?.signal },
        );
        await assertAudioBlob(response.data);
        if (reservation) await settleUserCreditReservation(reservation.reservationId, "success").catch(() => null);
        void reportAiCall({
            kind: "audio",
            model: modelOptionName(selectedModel),
            status: "success",
            credits: amount,
            reason: `audio generation: ${modelOptionName(selectedModel)}`,
            requestParams: { model, voice: normalizeAudioVoiceValue(config.audioVoice), format, speed: Number(normalizeAudioSpeedValue(config.audioSpeed)), promptLength: prompt.length },
            responseResult: { bytes: response.data.size, mimeType: response.data.type },
        });
        return response.data.type.startsWith("audio/") ? response.data : new Blob([response.data], { type: audioMimeType(format) });
    } catch (error) {
        if (reservation) await settleUserCreditReservation(reservation.reservationId, "failed").catch(() => null);
        const messageText = readAxiosError(error, "audio generation failed");
        void reportAiCall({
            kind: "audio",
            model: modelOptionName(selectedModel),
            status: "failed",
            credits: amount,
            reason: `audio generation: ${modelOptionName(selectedModel)}`,
            requestParams: { model, voice: normalizeAudioVoiceValue(config.audioVoice), format, promptLength: prompt.length },
            errorMessage: messageText,
        });
        throw new Error(messageText);
    }
}

export async function storeGeneratedAudio(blob: Blob, format = "mp3"): Promise<UploadedFile> {
    const audio = blob.type.startsWith("audio/") ? blob : new Blob([blob], { type: audioMimeType(format) });
    return uploadMediaFile(audio, "audio");
}

function assertAudioConfig(config: AiConfig, model: string) {
    if (!model) throw new Error("请先配置音频模型");
    if (!config.baseUrl.trim()) throw new Error("请先配置 Base URL");
    if (!config.apiKey.trim()) throw new Error("请先配置 API Key");
    if (config.apiFormat === "gemini") throw new Error("Gemini 调用格式暂不支持音频生成，请使用 OpenAI 格式渠道");
}

async function assertAudioBlob(blob: Blob) {
    if (!blob.type.includes("json")) return;
    let payload: { code?: number; msg?: string; error?: { message?: string } };
    try {
        payload = JSON.parse(await blob.text()) as { code?: number; msg?: string; error?: { message?: string } };
    } catch {
        return;
    }
    if (typeof payload.code === "number" && payload.code !== 0) throw new Error(payload.msg || "音频生成失败");
    if (payload.error?.message) throw new Error(payload.error.message);
}

function readAxiosError(error: unknown, fallback: string) {
    if (axios.isCancel(error)) return "请求已取消";
    if (axios.isAxiosError<{ error?: { message?: string }; msg?: string; code?: number }>(error)) {
        const responseData = error.response?.data;
        return responseData?.msg || responseData?.error?.message || statusMessage(error.response?.status, fallback);
    }
    return error instanceof Error ? error.message : fallback;
}

function statusMessage(status: number | undefined, fallback: string) {
    if (status === 401 || status === 403) return "鉴权失败，请检查 API Key、套餐权限或模型权限";
    if (status === 429) return "请求被限流或额度不足，请稍后重试";
    return status ? `${fallback}（${status}）` : fallback;
}
