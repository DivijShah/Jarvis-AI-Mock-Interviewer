import type { GeminiHistoryTurn } from "./state";

const SYSTEM_PROMPT =
  "You are Jarvis, a senior SDE interviewer and coaching assistant. " +
  "Always follow the user's requested format exactly. " +
  "For interview follow-ups, ask exactly one concise question that probes software engineering depth " +
  "(problem framing, architecture trade-offs, reliability, testing, performance, debugging, ownership, or impact). " +
  "If the answer is vague, ask for concrete details and measurable outcomes. " +
  "Use a calm, precise tone without fluff.";

const DEFAULT_MODELS = [
  "gemini-2.5-flash",
  "gemini-1.5-flash",
  "gemini-1.5-flash-8b"
];

interface GeminiStreamError extends Error {
  status?: number;
  retryable?: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createErrorWithContext(
  message: string,
  status?: number
): GeminiStreamError {
  const error = new Error(message) as GeminiStreamError;
  error.status = status;
  error.retryable = status != null && [429, 500, 502, 503, 504].includes(status);
  return error;
}

function normalizeModelId(rawModel: string): string {
  const trimmed = rawModel.trim();
  if (trimmed.startsWith("models/")) {
    return trimmed;
  }
  return `models/${trimmed}`;
}

function parseJson(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractTextChunk(payload: any): string | null {
  const candidates = Array.isArray(payload?.candidates) ? payload.candidates : [];
  if (!candidates.length) return null;
  const content = candidates[0]?.content;
  if (!content || !Array.isArray(content.parts)) return null;

  const text = content.parts
    .map((part: any) => {
      if (!part || typeof part.text !== "string") return "";
      return part.text;
    })
    .join("");

  return text || null;
}

function isSafetyBlocked(payload: any): boolean {
  if (payload?.error) return true;
  const candidates = Array.isArray(payload?.candidates) ? payload.candidates : [];
  if (!candidates.length) return false;
  return candidates.some(
    (candidate: any) =>
      candidate?.finishReason === "BLOCK_REASON_SAFETY" ||
      candidate?.finishReason === "RECITATION" ||
      candidate?.finishReason === "SAFETY"
  );
}

function isErrorPayload(payload: any): string | null {
  if (!payload?.error) return null;
  if (typeof payload.error.message === "string") return payload.error.message;
  if (typeof payload.error.error_code === "string")
    return `${payload.error.error_code}: ${payload.error.message || "AI error"}`;
  if (typeof payload.error === "string") return payload.error;
  if (Array.isArray(payload.error.details) && payload.error.details.length > 0) {
    const detail = payload.error.details
      .map((detail: any) => {
        if (!detail || typeof detail.message !== "string") return "";
        return detail.message;
      })
      .filter(Boolean)
      .join(" ");
    if (detail) return detail;
  }
  return "Model returned an error response";
}

function isRetryableError(error: unknown): boolean {
  if (typeof error === "string") return false;
  const maybeError = error as GeminiStreamError;
  return !!maybeError?.retryable || maybeError?.status === 429;
}

function processPayload(rawPayload: string): string | null {
  const payload = parseJson(rawPayload);
  if (!payload) return null;

  if (isSafetyBlocked(payload)) {
    const message = isErrorPayload(payload) || "Blocked by model safety policy.";
    throw new Error(message);
  }

  const chunkText = extractTextChunk(payload);
  return chunkText && chunkText.trim().length > 0 ? chunkText : null;
}

async function* streamFromModel(opts: {
  apiKey: string;
  messages: GeminiHistoryTurn[];
  model: string;
}): AsyncGenerator<string> {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/${normalizeModelId(
    opts.model
  )}:streamGenerateContent?alt=sse&key=${encodeURIComponent(
    opts.apiKey
  )}`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{ text: SYSTEM_PROMPT }]
      },
      contents: opts.messages.map((message) => ({
        role: message.role,
        parts: [{ text: message.content }]
      })),
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 600
      }
    })
  });

  if (!response.ok) {
    const rawBody = await response.text();
    const parsed = parseJson(rawBody);
    const detail =
      isErrorPayload(parsed) || `Gemini request failed with ${response.status}`;
    throw createErrorWithContext(detail, response.status);
  }

  if (!response.body) {
    throw new Error("No stream returned from Gemini.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let emitted = false;
  let rawResponse = "";

  const processLine = (line: string): string | null => {
    const trim = line.trim();
    if (!trim || !trim.startsWith("data:")) return null;
    const payloadText = trim.replace(/^data:\s*/, "");
    if (!payloadText || payloadText === "[DONE]") return null;
    return processPayload(payloadText);
  };

  while (true) {
    const result = await reader.read();
    if (result.done) {
      break;
    }

    const chunkText = decoder.decode(result.value, { stream: true });
    rawResponse += chunkText;
    const lines = (pending + chunkText).split("\n");
    pending = lines.pop() ?? "";

    for (const rawLine of lines) {
      const candidateText = processLine(rawLine);
      if (candidateText) {
        emitted = true;
        yield candidateText;
      }
    }
  }

  const finalLineText = processLine(pending);
  if (finalLineText) {
    emitted = true;
    yield finalLineText;
  }

  if (!emitted) {
    const fallback = processPayload(rawResponse);
    if (fallback) {
      yield fallback;
      return;
    }

    throw new Error("Malformed or empty model response.");
  }
}

export async function* streamGeminiInterviewReply(opts: {
  apiKey: string;
  messages: GeminiHistoryTurn[];
  models?: string[];
  maxRetries?: number;
}): AsyncGenerator<string> {
  const preferredModels = opts.models?.length ? opts.models : DEFAULT_MODELS;
  const retries = opts.maxRetries ?? 1;
  let lastError: unknown = null;

  for (let modelIndex = 0; modelIndex < preferredModels.length; modelIndex += 1) {
    const model = preferredModels[modelIndex];

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        let emitted = 0;
        for await (const token of streamFromModel({
          apiKey: opts.apiKey,
          messages: opts.messages,
          model
        })) {
          emitted += 1;
          yield token;
        }

        if (emitted === 0) {
          throw new Error("Model returned no stream data.");
        }

        return;
      } catch (error: unknown) {
        lastError = error;

        const isRetry = isRetryableError(error);
        if (isRetry && attempt < retries) {
          await sleep((attempt + 1) * 250);
          continue;
        }

        const isLastModel = modelIndex === preferredModels.length - 1;
        if (!isRetry || isLastModel) {
          throw error;
        }

        break;
      }
    }
  }

  if (lastError instanceof Error) {
    throw lastError;
  }

  throw new Error("Gemini failed to return a response.");
}
