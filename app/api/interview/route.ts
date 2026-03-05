import {
  addTurn,
  getConversation,
  getOrCreateSession,
  getQuestionProgress,
  isInterviewComplete,
  nextPlannedQuestion,
  setActiveResumeQuestion,
  clearActiveResumeState,
  consumeResumeFollowUp,
  markStandardQuestion,
  setResumeContext,
  setQuestionPlan,
  type InterviewSession,
  type GeminiHistoryTurn
} from "@/lib/interview/state";
import { pickQuestionSet } from "@/lib/interview/question-bank";
import { streamGeminiInterviewReply } from "@/lib/interview/gemini";
import { createRequire } from "module";

type InterviewAction = "start" | "next";

type InterviewRequestBody = {
  sessionId?: string;
  action?: InterviewAction;
  answer?: string;
  resume?: string;
  questionMode?: "behavioral" | "resume" | "both";
  includeFeedback?: unknown;
};

type QuestionMode = "behavioral" | "resume" | "both";
type ResolvedQuestionMode = QuestionMode;

function normalizeQuestionMode(mode: unknown): ResolvedQuestionMode {
  return mode === "behavioral" || mode === "resume" || mode === "both" ? mode : "both";
}

type StreamEvent =
  | {
      type: "interview-meta";
      sessionId: string;
      action: "start" | "next";
      questionIndex: number;
      totalQuestions: number;
    }
  | { type: "interview-token"; token: string }
  | {
      type: "interview-complete";
      text: string;
      sessionId: string;
      questionIndex: number;
      totalQuestions: number;
      finished: boolean;
    }
  | { type: "interview-feedback"; feedback: string }
  | { type: "interview-error"; error: string };

const QUESTIONS_PER_SESSION = 5;
const RESUME_FOLLOWUP_QUESTIONS_PER_ROUND = 2;
const MAX_RESUME_QUESTIONS = 2;
const RESUME_QUESTION_PREFIX = "RESUME::";
const MAX_RESUME_FILE_BYTES = 4 * 1024 * 1024;
const MAX_RESUME_TEXT_CHARS = 12000;

function toBooleanFlag(value: unknown): boolean {
  return (
    value === true ||
    value === 1 ||
    value === "1" ||
    (typeof value === "string" && value.toLowerCase() === "true")
  );
}

function isResumeQuestion(rawText: string): boolean {
  return rawText.startsWith(RESUME_QUESTION_PREFIX);
}

function stripResumeMarker(rawText: string): string {
  if (!isResumeQuestion(rawText)) return rawText;
  return rawText.slice(RESUME_QUESTION_PREFIX.length).trim();
}

function markResumeQuestion(rawText: string): string {
  return `${RESUME_QUESTION_PREFIX}${rawText.trim()}`;
}

function toSseList(value: string): string[] {
  const candidate = value.trim();
  if (!candidate) return [];

  try {
    const parsed = JSON.parse(candidate);
    if (Array.isArray(parsed)) {
      return parsed
        .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
        .filter(Boolean)
        .slice(0, MAX_RESUME_QUESTIONS);
    }

    if (
      parsed &&
      typeof parsed === "object" &&
      Array.isArray((parsed as { questions?: unknown }).questions)
    ) {
      return (parsed as { questions: unknown[] }).questions
        .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
        .filter(Boolean)
        .slice(0, MAX_RESUME_QUESTIONS);
    }
  } catch {
    // fall through to line-based parsing
  }

  const parts = candidate
    .split("\n")
    .map((line) => line.trim())
    .map((line) => line.replace(/^\d+\.\s*/, "").replace(/^[-*•]\s*/, ""))
    .filter((line) => line.endsWith("?") || line.length > 10);

  return parts.filter(Boolean).slice(0, MAX_RESUME_QUESTIONS);
}

function normalizeResumeText(raw: string): string {
  return (raw || "").trim().replace(/\s+/g, " ").slice(0, MAX_RESUME_TEXT_CHARS);
}

async function extractTextFromResumeFile(file: File): Promise<string> {
  if (!file || file.size <= 0 || file.size > MAX_RESUME_FILE_BYTES) return "";

  const bytes = await file.arrayBuffer();
  const buffer = Buffer.from(bytes);
  const fileName = (file.name || "").toLowerCase();
  const extension = fileName.includes(".") ? fileName.split(".").pop() : "";
  const mimeType = (file.type || "").toLowerCase();

  if (mimeType === "application/pdf" || extension === "pdf") {
    try {
      const requireFn = createRequire(import.meta.url);
      const parserModule = requireFn("pdf-parse") as
        | ((input: Buffer) => Promise<{ text?: string }>)
        | { default?: (input: Buffer) => Promise<{ text?: string }> }
        | undefined;

      const parseFunction =
        typeof parserModule === "function"
          ? parserModule
          : parserModule && typeof parserModule.default === "function"
            ? parserModule.default
            : undefined;
      if (!parseFunction) return "";

      const parsed = await parseFunction(buffer);
      return normalizeResumeText(parsed?.text || "");
    } catch {
      return "";
    }
  }

  if (mimeType.startsWith("text/") || extension === "txt") {
    try {
      return normalizeResumeText(await file.text());
    } catch {
      return "";
    }
  }

  return "";
}

function buildResumeQuestionSetPrompt(resumeText: string): string {
  return `Analyze this resume and produce exactly ${MAX_RESUME_QUESTIONS} interview questions that can be asked in a technical/behavioral interview.
Use specifics from the resume only. Return strict JSON only in this format:
{"questions":["...","..."]}
Resume:
${resumeText}`;
}

function fallbackResumeQuestions(): string[] {
  return [
    "Tell me about one of your strongest projects from your resume and the decision you made there.",
    "Choose a challenge from your resume and explain your exact contribution and outcome."
  ];
}

function buildResumeFollowUpPrompt(
  resumeText: string,
  resumeQuestion: string,
  lastAnswer: string,
  round: number
): string {
  return `You are an interviewer. The candidate was asked: "${resumeQuestion}".
Candidate answered: "${lastAnswer}".
Ask one short follow-up question that deepens the same thread using the resume context below.
No preamble, no feedback, only a single question.
Resume context:
${resumeText}
Follow-up round: ${round} of ${RESUME_FOLLOWUP_QUESTIONS_PER_ROUND}`;
}

function sanitizeQuestion(question: string): string {
  const text = question.trim();
  if (!text) return "";

  const firstLine = text.split("\n")[0].trim();
  const stripped = firstLine
    .replace(/^(assistant:|jarvis:|question:)\s*/i, "")
    .replace(/^\(?\s*interviewer\s*:?\s*/i, "")
    .trim();
  const match = stripped.match(/[^.!?]*\?/);
  if (match) return match[0].trim();

  return stripped.endsWith("?") ? stripped : `${stripped}?`;
}

async function collectGeminiText(opts: {
  apiKey: string;
  messages: GeminiHistoryTurn[];
  models: string[];
}): Promise<string> {
  let text = "";
  for await (const token of streamGeminiInterviewReply({
    apiKey: opts.apiKey,
    messages: opts.messages,
    models: opts.models,
    maxRetries: 1
  })) {
    text += token;
  }

  return text.trim();
}

async function generateResumeQuestions(
  apiKey: string,
  resumeText: string
): Promise<string[]> {
  if (!apiKey || !resumeText.trim()) return [];

  try {
    const content = await collectGeminiText({
      apiKey,
      messages: [{ role: "user", content: buildResumeQuestionSetPrompt(resumeText) }],
      models: [process.env.GEMINI_MODEL || "gemini-2.5-flash", "gemini-1.5-flash"]
    });

    const parsed = toSseList(content);
    return [...new Set(parsed.map((item) => sanitizeQuestion(item).replace(/\?$/, "?")))]
      .filter(Boolean)
      .slice(0, MAX_RESUME_QUESTIONS);
  } catch {
    return [];
  }
}

async function generateResumeFollowUp(
  apiKey: string,
  session: InterviewSession,
  resumeQuestion: string,
  answer: string,
  round: number
): Promise<string> {
  if (!apiKey || !session.resumeContext.trim() || !resumeQuestion.trim()) return "";

  try {
    const prompt = buildResumeFollowUpPrompt(session.resumeContext, resumeQuestion, answer, round);
    const content = await collectGeminiText({
      apiKey,
      messages: [{ role: "user", content: prompt }],
      models: [process.env.GEMINI_MODEL || "gemini-2.5-flash", "gemini-1.5-flash"]
    });
    return sanitizeQuestion(content);
  } catch {
    return `Can you add one more concrete example around your answer to "${resumeQuestion}"?`;
  }
}

function buildQuestionPlan(baseQuestions: string[], resumeQuestions: string[]): string[] {
  if (!resumeQuestions.length) return baseQuestions;

  const plan = [...baseQuestions];
  const targets = [Math.min(1, plan.length), Math.min(3, plan.length)];

  resumeQuestions.forEach((question, index) => {
    const insertionPoint = targets[Math.min(index, targets.length - 1)];
    const item = markResumeQuestion(sanitizeQuestion(question));
    plan.splice(Math.min(insertionPoint, plan.length), 0, item);
  });

  return plan;
}

function buildQuestionSetByMode(
  sessionId: string,
  baseQuestions: string[],
  resumeQuestions: string[],
  mode: QuestionMode
): string[] {
  const includeBehavioral = mode !== "resume";
  const includeResume = mode !== "behavioral";

  if (includeBehavioral && includeResume) {
    return buildQuestionPlan(baseQuestions, resumeQuestions);
  }

  if (includeResume) {
    const resumeSet = (resumeQuestions.length ? resumeQuestions : fallbackResumeQuestions())
      .map((question) => markResumeQuestion(sanitizeQuestion(question)))
      .filter(Boolean);

    if (resumeSet.length >= QUESTIONS_PER_SESSION) {
      return resumeSet.slice(0, QUESTIONS_PER_SESSION);
    }

    const fillCount = QUESTIONS_PER_SESSION - resumeSet.length;
    const fillers = pickQuestionSet(`${sessionId}:resume-padding`, fillCount);
    const fillerMarked = fillers.map((question) => sanitizeQuestion(question));
    return [...resumeSet, ...fillerMarked].slice(0, QUESTIONS_PER_SESSION);
  }

  return baseQuestions;
}

function toSse(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function isEmpty(value: unknown): value is undefined | null {
  if (typeof value !== "string") return true;
  return !value.trim();
}

type ParsedStartRequest = {
  action: "start";
  sessionId: string;
  answer: "";
  resume: string;
  questionMode: QuestionMode;
  hasResumeAttachment: boolean;
  includeFeedback: false;
};

type ParsedNextRequest = {
  action: "next";
  sessionId: string;
  answer: string;
  resume: "";
  questionMode: "both";
  includeFeedback: boolean;
};

type ParsedRequestBody = ParsedStartRequest | ParsedNextRequest;

async function parseInterviewRequest(req: Request): Promise<ParsedRequestBody> {
  const contentType = req.headers.get("content-type") || "";

  if (contentType.includes("multipart/form-data")) {
    const formData = await req.formData();
    const action = String(formData.get("action") || "start").trim() as InterviewAction;
    if (action !== "start" && action !== "next") {
      throw new Error("Invalid action.");
    }

    const sessionId = String(formData.get("sessionId") || "").trim();
    const answer = String(formData.get("answer") || "").trim();
    const resumeText = normalizeResumeText(String(formData.get("resume") || ""));
    const questionMode = normalizeQuestionMode(formData.get("questionMode"));
    const includeFeedback = toBooleanFlag(formData.get("includeFeedback"));
    const resumeFile = formData.get("resumeFile");
    const hasResumeAttachment = resumeFile instanceof File && resumeFile.size > 0;
    const resumeFromFile = resumeFile instanceof File
      ? await extractTextFromResumeFile(resumeFile)
      : "";

    const resolvedResume = resumeText || resumeFromFile;

    if (action === "start") {
      return {
        action: "start",
        sessionId,
        answer: "",
        resume: resolvedResume,
        questionMode,
        hasResumeAttachment,
        includeFeedback: false
      };
    }

    return {
      action: "next",
      sessionId,
      answer,
      resume: "",
      questionMode: "both",
      includeFeedback
    };
  }

  if (!contentType.includes("application/json")) {
    throw new Error("Invalid request content type.");
  }

  const body = (await req.json()) as InterviewRequestBody;
  const action = (body.action || "start") as InterviewAction;
  if (action !== "start" && action !== "next") {
    throw new Error("Invalid action.");
  }
  const sessionId = body.sessionId?.trim() || "";
  const answer = typeof body.answer === "string" ? body.answer.trim() : "";
  const resumeText = normalizeResumeText(typeof body.resume === "string" ? body.resume : "");
  const questionMode = normalizeQuestionMode(body.questionMode);
  const includeFeedback = toBooleanFlag(body.includeFeedback);

  if (action === "start") {
      return {
        action: "start",
        sessionId,
        answer: "",
        resume: resumeText,
        questionMode,
        hasResumeAttachment: false,
        includeFeedback: false
      };
  }

  return {
    action: "next",
    sessionId,
    answer,
    resume: "",
    questionMode: "both",
    includeFeedback
  };
}

function emitMetadata(
  controller: ReadableStreamDefaultController<Uint8Array>,
  sessionId: string,
  action: InterviewAction,
  questionIndex: number,
  totalQuestions: number
): void {
  const encoder = new TextEncoder();
  controller.enqueue(
    encoder.encode(
      toSse({
        type: "interview-meta",
        sessionId,
        action,
        questionIndex,
        totalQuestions
      })
    )
  );
}

function emitTextStream(
  controller: ReadableStreamDefaultController<Uint8Array>,
  sessionId: string,
  questionIndex: number,
  totalQuestions: number,
  text: string,
  finished: boolean
): void {
  const encoder = new TextEncoder();
  const chunkSize = 48;

  for (let i = 0; i < text.length; i += chunkSize) {
    controller.enqueue(
      encoder.encode(
        toSse({
          type: "interview-token",
          token: text.slice(i, i + chunkSize)
        })
      )
    );
  }

  controller.enqueue(
    encoder.encode(
      toSse({
        type: "interview-complete",
        sessionId,
        questionIndex,
        totalQuestions,
        text,
        finished
      })
    )
  );
}

function emitFeedback(
  controller: ReadableStreamDefaultController<Uint8Array>,
  feedback: string
): void {
  const encoder = new TextEncoder();
  const text = feedback.trim().slice(0, 260);
  if (!text) return;

  controller.enqueue(
    encoder.encode(
      toSse({
        type: "interview-feedback",
        feedback: text
      })
    )
  );
}

function emitError(
  controller: ReadableStreamDefaultController<Uint8Array>,
  message: string
): void {
  const encoder = new TextEncoder();
  controller.enqueue(
    encoder.encode(
      toSse({
        type: "interview-error",
        error: message
      })
    )
  );
}

function streamErrorResponse(message: string, status = 400): Response {
  const stream = new ReadableStream({
    start(controller) {
      emitError(controller, message);
      controller.close();
    }
  });

  return new Response(stream, {
    status,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    }
  });
}

function buildFeedbackPrompt(history: GeminiHistoryTurn[]): string {
  const lastAnswer = [...history].reverse().find((message) => message.role === "user");
  if (!lastAnswer) {
    return "Give 1-2 short lines of coaching feedback for the last candidate response.";
  }

  return `Candidate response: ${lastAnswer.content}\n\nReply with 1-2 clear coaching lines and one actionable suggestion. No questions.`;
}

async function generateFeedback(
  apiKey: string,
  history: GeminiHistoryTurn[]
): Promise<string | null> {
  if (!apiKey || !history.length) return null;

  try {
    let feedback = "";
    const withFeedbackPrompt: GeminiHistoryTurn[] = [
      ...history,
      {
        role: "user",
        content: buildFeedbackPrompt(history)
      }
    ];

    for await (const token of streamGeminiInterviewReply({
      apiKey,
      messages: withFeedbackPrompt,
      models: [process.env.GEMINI_MODEL || "gemini-2.5-flash", "gemini-1.5-flash"],
      maxRetries: 1
    })) {
      feedback += token;
    }

    const normalized = feedback.trim().replace(/\s+/g, " ");
    return normalized || null;
  } catch {
    return null;
  }
}

export async function POST(req: Request) {
  let body: ParsedRequestBody;
  try {
    body = await parseInterviewRequest(req);
  } catch {
    return streamErrorResponse("Invalid request body.", 400);
  }

  const shouldStart = body.action === "start";
  const answer = body.answer;
  const cleanedSessionId = body.sessionId;
  const resumeText = body.resume;
  const questionMode = body.questionMode;
  const includeFeedback = shouldStart ? false : body.includeFeedback;
  const hasResumeAttachment = shouldStart ? body.hasResumeAttachment : false;
  const apiKey = process.env.GEMINI_API_KEY;

  if (!shouldStart && !cleanedSessionId) {
    return streamErrorResponse("Session id is required for next. Start an interview first.", 400);
  }

  if (!shouldStart && isEmpty(answer)) {
    return streamErrorResponse("Answer is required before requesting the next question.", 400);
  }

  if (shouldStart && questionMode !== "behavioral" && !resumeText && !hasResumeAttachment) {
    return streamErrorResponse("Upload resume PDF before using resume-based question modes.", 400);
  }

  const session = shouldStart
    ? getOrCreateSession()
    : getOrCreateSession(cleanedSessionId);

  if (shouldStart) {
    const questions = pickQuestionSet(session.id, QUESTIONS_PER_SESSION);
    setResumeContext(session, resumeText);

    let resumeQuestions: string[] = [];
    const shouldGenerateResumeQuestions = questionMode !== "behavioral" && resumeText;

    if (shouldGenerateResumeQuestions && apiKey) {
      resumeQuestions = await generateResumeQuestions(apiKey, resumeText);
    }

    if (!resumeQuestions.length && questionMode !== "behavioral") {
      resumeQuestions = fallbackResumeQuestions();
    }

    const questionSet = buildQuestionSetByMode(
      session.id,
      questions,
      resumeQuestions,
      questionMode
    );
    setQuestionPlan(session, questionSet);
  }

  if (shouldStart && !session.questionPlan.length) {
    return streamErrorResponse("No interview questions are available.", 500);
  }

  if (!shouldStart) {
    addTurn(session, "user", answer);
  }

  const stream = new ReadableStream({
    async start(controller) {
      const action: InterviewAction = shouldStart ? "start" : "next";
      const sessionId = session.id;
      let progress = getQuestionProgress(session);

      emitMetadata(
        controller,
        sessionId,
        action,
        progress.index,
        progress.total
      );

      try {
        if (!shouldStart && includeFeedback && apiKey) {
          const history = getConversation(session);
          const feedback = await generateFeedback(apiKey, history);
          if (feedback) {
            emitFeedback(controller, feedback);
          }
        }

        if (!shouldStart && session.lastQuestionWasResume && session.remainingResumeFollowUps > 0) {
          const resumeRound =
            RESUME_FOLLOWUP_QUESTIONS_PER_ROUND - session.remainingResumeFollowUps + 1;
          const followUpFromAi = await generateResumeFollowUp(
            apiKey || "",
            session,
            session.activeResumeQuestion,
            answer,
            resumeRound
          );

          const followUpQuestion =
            sanitizeQuestion(followUpFromAi) ||
            `Can you walk me through one more detail for "${session.activeResumeQuestion}"?`;

          consumeResumeFollowUp(session);
          if (session.remainingResumeFollowUps <= 0) {
            clearActiveResumeState(session);
          }

          addTurn(session, "assistant", followUpQuestion);
          progress = getQuestionProgress(session);
          emitTextStream(
            controller,
            sessionId,
            progress.index,
            progress.total,
            followUpQuestion,
            false
          );
          controller.close();
          return;
        }

        const nextQuestion = nextPlannedQuestion(session);

        if (!nextQuestion) {
          const completeText = isInterviewComplete(session)
            ? `Interview complete. You answered ${progress.total} questions. Great work today.`
            : "No questions are currently queued for this session.";

          addTurn(session, "assistant", completeText);
          progress = getQuestionProgress(session);
          emitTextStream(
            controller,
            sessionId,
            progress.index,
            progress.total,
            completeText,
            true
          );
          controller.close();
          return;
        }

        if (isResumeQuestion(nextQuestion)) {
          const cleanText = stripResumeMarker(nextQuestion);
          setActiveResumeQuestion(
            session,
            cleanText,
            RESUME_FOLLOWUP_QUESTIONS_PER_ROUND
          );
          addTurn(session, "assistant", cleanText);
          progress = getQuestionProgress(session);
          emitTextStream(
            controller,
            sessionId,
            progress.index,
            progress.total,
            cleanText,
            false
          );
          controller.close();
          return;
        } else {
          clearActiveResumeState(session);
          markStandardQuestion(session);
          addTurn(session, "assistant", nextQuestion);
          progress = getQuestionProgress(session);
          emitTextStream(
            controller,
            sessionId,
            progress.index,
            progress.total,
            nextQuestion,
            false
          );
          controller.close();
          return;
        }
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : "Could not generate interview content.";
        emitError(controller, message);
        controller.close();
      }
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    }
  });
}
