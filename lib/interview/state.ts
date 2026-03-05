export type InterviewRole = "user" | "assistant";

export interface InterviewTurn {
  role: InterviewRole;
  content: string;
  createdAt: number;
}

export interface InterviewSession {
  id: string;
  createdAt: number;
  updatedAt: number;
  turns: InterviewTurn[];
  questionPlan: string[];
  currentQuestionIndex: number;
  activeResumeQuestion: string;
  remainingResumeFollowUps: number;
  lastQuestionWasResume: boolean;
  resumeContext: string;
  isUnlocked: boolean;
}

export interface GeminiHistoryTurn {
  role: "user" | "model";
  content: string;
}

const ACTIVE_SESSIONS_TTL_MS = 1000 * 60 * 60;
const SESSION_CLEANUP_INTERVAL_MS = 1000 * 60 * 10;
const MAX_TURNS = 24;

const sessions = new Map<string, InterviewSession>();
let lastSessionCleanup = 0;

function randomSessionId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `jarvis-${crypto.randomUUID()}`;
  }
  return `jarvis-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function cleanupExpiredSessions(now: number): void {
  if (now - lastSessionCleanup < SESSION_CLEANUP_INTERVAL_MS) {
    return;
  }

  const cutoff = now - ACTIVE_SESSIONS_TTL_MS;
  for (const [sessionId, session] of sessions.entries()) {
    if (session.updatedAt < cutoff) {
      sessions.delete(sessionId);
    }
  }
  lastSessionCleanup = now;
}

export function getOrCreateSession(sessionId?: string): InterviewSession {
  const now = Date.now();
  cleanupExpiredSessions(now);

  if (sessionId) {
    const existing = sessions.get(sessionId);
    if (existing) {
      existing.updatedAt = now;
      return existing;
    }
  }

  const id = sessionId?.trim() || randomSessionId();
  const created: InterviewSession = {
    id,
    createdAt: now,
    updatedAt: now,
    turns: [],
    questionPlan: [],
    currentQuestionIndex: 0,
    activeResumeQuestion: "",
    remainingResumeFollowUps: 0,
    lastQuestionWasResume: false,
    resumeContext: "",
    isUnlocked: false
  };
  sessions.set(id, created);
  return created;
}

export function unlockSession(session: InterviewSession): void {
  session.isUnlocked = true;
  session.updatedAt = Date.now();
}

export function appendQuestionPlan(
  session: InterviewSession,
  questions: string[]
): void {
  if (!questions.length) return;

  const existing = new Set(session.questionPlan.map((question) => question.trim()));
  const normalized = questions
    .map((question) => question.trim())
    .filter(Boolean)
    .filter((question, index, all) =>
      all.findIndex((entry) => entry.trim() === question) === index
    )
    .filter((question) => !existing.has(question));

  if (!normalized.length) return;

  session.questionPlan = [...session.questionPlan, ...normalized];
  session.updatedAt = Date.now();
}

export function setActiveResumeQuestion(
  session: InterviewSession,
  question: string,
  followUps = 0
): void {
  session.activeResumeQuestion = question;
  session.remainingResumeFollowUps = Math.max(0, Math.min(2, followUps));
  session.lastQuestionWasResume = followUps > 0;
  session.updatedAt = Date.now();
}

export function clearActiveResumeState(session: InterviewSession): void {
  session.activeResumeQuestion = "";
  session.remainingResumeFollowUps = 0;
  session.lastQuestionWasResume = false;
  session.updatedAt = Date.now();
}

export function markStandardQuestion(session: InterviewSession): void {
  session.lastQuestionWasResume = false;
  session.updatedAt = Date.now();
}

export function consumeResumeFollowUp(session: InterviewSession): boolean {
  if (session.remainingResumeFollowUps <= 0) {
    return false;
  }

  session.remainingResumeFollowUps -= 1;
  session.updatedAt = Date.now();
  return true;
}

export function setResumeContext(session: InterviewSession, resumeText: string): void {
  session.resumeContext = resumeText.trim();
  session.updatedAt = Date.now();
}

export function setQuestionPlan(
  session: InterviewSession,
  questions: string[]
): void {
  const normalized = questions
    .map((question) => question.trim())
    .filter(Boolean)
    .filter((question, index, arr) => arr.indexOf(question) === index);

  session.questionPlan = normalized;
  session.currentQuestionIndex = 0;
  session.updatedAt = Date.now();
}

export function nextPlannedQuestion(session: InterviewSession): string | null {
  if (session.currentQuestionIndex >= session.questionPlan.length) return null;

  const question = session.questionPlan[session.currentQuestionIndex];
  if (!question) return null;

  session.currentQuestionIndex += 1;
  session.updatedAt = Date.now();
  return question;
}

export function getQuestionProgress(session: InterviewSession): {
  index: number;
  total: number;
} {
  return {
    index: session.currentQuestionIndex,
    total: session.questionPlan.length
  };
}

export function isInterviewComplete(session: InterviewSession): boolean {
  return session.questionPlan.length > 0 && session.currentQuestionIndex >= session.questionPlan.length;
}

export function addTurn(session: InterviewSession, role: InterviewRole, content: string): void {
  const normalized = normalizeText(content);
  if (!normalized) return;

  session.turns.push({
    role,
    content: normalized,
    createdAt: Date.now()
  });

  if (session.turns.length > MAX_TURNS) {
    session.turns = session.turns.slice(-MAX_TURNS);
  }
  session.updatedAt = Date.now();
}

export function getConversation(session: InterviewSession): GeminiHistoryTurn[] {
  return session.turns.map((turn) => ({
    role: turn.role === "assistant" ? "model" : "user",
    content: turn.content
  }));
}
