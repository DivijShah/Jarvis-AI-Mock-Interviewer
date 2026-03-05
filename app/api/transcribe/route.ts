import { consumeRateLimit, getClientIdentifier } from "@/lib/rate-limit";
export const runtime = "nodejs";

type GeminiPart = {
  text?: string;
};

type GeminiResponse = {
  candidates?: Array<{
    content?: {
      parts?: GeminiPart[];
    };
  }>;
  error?: {
    message?: string;
  };
};

const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const FALLBACK_MODELS = ["gemini-2.5-flash", "gemini-1.5-flash"];
const TRANSCRIBE_RATE_LIMIT = 12;
const TRANSCRIBE_WINDOW_MS = 60_000;

function sanitizeTranscript(raw: string): string {
  return raw
    .trim()
    .replace(/^transcript\s*:\s*/i, "")
    .replace(/^answer\s*:\s*/i, "")
    .replace(/\s+/g, " ");
}

async function transcribeWithModel(opts: {
  apiKey: string;
  model: string;
  audioBase64: string;
  mimeType: string;
}): Promise<string> {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    opts.model
  )}:generateContent?key=${encodeURIComponent(opts.apiKey)}`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [
            {
              text:
                "Transcribe this interview answer accurately. Return plain text only, no labels, no markdown."
            },
            {
              inlineData: {
                mimeType: opts.mimeType,
                data: opts.audioBase64
              }
            }
          ]
        }
      ],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 700
      }
    })
  });

  const payload = (await response.json().catch(() => ({}))) as GeminiResponse;
  if (!response.ok) {
    const reason =
      payload?.error?.message || `Gemini transcription failed with ${response.status}.`;
    throw new Error(reason);
  }

  const text = (payload.candidates || [])
    .flatMap((candidate) => candidate?.content?.parts || [])
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .join(" ")
    .trim();

  return sanitizeTranscript(text);
}

export async function POST(req: Request): Promise<Response> {
  const rateResult = consumeRateLimit({
    namespace: "api/transcribe",
    identifier: getClientIdentifier(req),
    limit: TRANSCRIBE_RATE_LIMIT,
    windowMs: TRANSCRIBE_WINDOW_MS
  });
  if (!rateResult.allowed) {
    return Response.json(
      { error: `Too many transcription requests. Try again in ${rateResult.retryAfterSeconds}s.` },
      { status: 429 }
    );
  }

  const apiKey = (process.env.GEMINI_API_KEY || "").trim();
  if (!apiKey) {
    return Response.json({ error: "Gemini API key is not configured." }, { status: 500 });
  }

  const contentType = req.headers.get("content-type") || "";
  if (!contentType.includes("multipart/form-data")) {
    return Response.json({ error: "Invalid request format." }, { status: 400 });
  }

  const formData = await req.formData();
  const audioFile = formData.get("audio");
  if (!(audioFile instanceof File) || audioFile.size <= 0) {
    return Response.json({ error: "Audio file is required." }, { status: 400 });
  }

  if (audioFile.size > MAX_AUDIO_BYTES) {
    return Response.json({ error: "Audio file is too large." }, { status: 400 });
  }

  const bytes = await audioFile.arrayBuffer();
  const audioBase64 = Buffer.from(bytes).toString("base64");
  const mimeType = ((audioFile.type || "audio/webm").split(";")[0] || "audio/webm").trim();

  const requestedModel = (process.env.GEMINI_MODEL || "").trim();
  const models = requestedModel
    ? [requestedModel, ...FALLBACK_MODELS.filter((item) => item !== requestedModel)]
    : FALLBACK_MODELS;

  for (const model of models) {
    try {
      const text = await transcribeWithModel({
        apiKey,
        model,
        audioBase64,
        mimeType
      });

      if (text) {
        return Response.json({ text });
      }
    } catch {
      // Try the next model.
    }
  }

  return Response.json(
    { error: "Unable to transcribe audio right now. Please type your answer." },
    { status: 502 }
  );
}
