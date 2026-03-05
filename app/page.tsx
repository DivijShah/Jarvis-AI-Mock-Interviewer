"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type ConversationRole = "You" | "Jarvis";
type ConversationTurn = {
  role: ConversationRole;
  text: string;
};

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

type InterviewAction = "start" | "next";
type QuestionMode = "behavioral" | "resume" | "both";
type RequestOptions = {
  auto?: boolean;
  answerOverride?: string;
};

const THINKING_SECONDS = 120;

function parseEvent(line: string): StreamEvent | null {
  if (!line.startsWith("data:")) return null;

  const payload = line.slice(5).trim();
  if (!payload) return null;

  try {
    const parsed = JSON.parse(payload);
    if (!parsed || typeof parsed.type !== "string") return null;
    return parsed as StreamEvent;
  } catch {
    return null;
  }
}

function formatTimer(seconds: number): string {
  const label = `${seconds}`.padStart(2, "0");
  return `${label}s`;
}

function normalizeTranscript(raw: string): string {
  return (raw || "").trim().replace(/\s+/g, " ");
}

function mergeTranscriptWithOverlap(previous: string, incoming: string): string {
  const previousWords = normalizeTranscript(previous).split(" ").filter(Boolean);
  const incomingWords = normalizeTranscript(incoming).split(" ").filter(Boolean);

  if (!previousWords.length) return incomingWords.join(" ");
  if (!incomingWords.length) return previousWords.join(" ");

  const maxOverlap = Math.min(previousWords.length, incomingWords.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    const prevSlice = previousWords.slice(previousWords.length - overlap).join(" ");
    const nextSlice = incomingWords.slice(0, overlap).join(" ");
    if (prevSlice === nextSlice) {
      return `${previousWords.concat(incomingWords.slice(overlap)).join(" ")}`;
    }
  }

  return `${previousWords.join(" ")} ${incomingWords.join(" ")}`;
}

export default function Home() {
  const [sessionId, setSessionId] = useState("");
  const [answer, setAnswer] = useState("");
  const [response, setResponse] = useState("");
  const [conversation, setConversation] = useState<ConversationTurn[]>([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("Initialize the Jarvis terminal to begin.");
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [isListening, setIsListening] = useState(false);
  const [interviewFinished, setInterviewFinished] = useState(false);
  const [questionIndex, setQuestionIndex] = useState(0);
  const [totalQuestions, setTotalQuestions] = useState(5);
  const [thinkingLeft, setThinkingLeft] = useState(0);
  const [awaitingAnswer, setAwaitingAnswer] = useState(false);
  const [feedbackText, setFeedbackText] = useState("");
  const [feedbackEnabled, setFeedbackEnabled] = useState(false);
  const [resumeFile, setResumeFile] = useState<File | null>(null);
  const [questionMode, setQuestionMode] = useState<QuestionMode>("behavioral");
  const [isPaused, setIsPaused] = useState(false);
  const canUseResumeMode = Boolean(resumeFile);

  const recognitionRef = useRef<any>(null);
  const voiceCaptureBaselineRef = useRef("");
  const voiceCaptureAccumulatorRef = useRef("");
  const voiceStoppedByUserRef = useRef(false);
  const jarvisVoice = useRef<SpeechSynthesisVoice | null>(null);
  const timerRef = useRef<number | null>(null);
  const requestRunningRef = useRef(false);
  const isPausedRef = useRef(false);
  const isRecordingRef = useRef(false);

  useEffect(() => {
    const initializeJarvisVoice = () => {
      const voices = window.speechSynthesis?.getVoices?.() || [];

      const preferred = [
        "Google UK English Male",
        "Microsoft David",
        "Microsoft Mark",
        "Daniel",
        "Alex",
        "Karen",
        "Samantha"
      ];

      const found = voices.find((voice: SpeechSynthesisVoice) => {
        const name = (voice.name || "").toLowerCase();
        return preferred.some((label) => name.includes(label.toLowerCase()));
      });

      if (found) {
        jarvisVoice.current = found;
      } else if (voices.length) {
        jarvisVoice.current =
          voices.find((v: SpeechSynthesisVoice) => v.lang.startsWith("en")) ||
          voices[0];
      }
    };

    initializeJarvisVoice();
    window.speechSynthesis?.addEventListener("voiceschanged", initializeJarvisVoice);

    return () => {
      window.speechSynthesis?.removeEventListener("voiceschanged", initializeJarvisVoice);
    };
  }, []);

  const speak = useCallback(
    (text: string) => {
      if (!voiceEnabled || !window.speechSynthesis) return;

      const sanitized = text.trim();
      if (!sanitized) return;

      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(`Certainly. ${sanitized}`);
      utterance.rate = 0.95;
      utterance.pitch = 0.15;
      utterance.volume = 1;

      if (jarvisVoice.current) {
        utterance.voice = jarvisVoice.current;
      }

      window.speechSynthesis.speak(utterance);
    },
    [voiceEnabled]
  );

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => {
    isPausedRef.current = isPaused;
  }, [isPaused]);

  useEffect(() => {
    if (!canUseResumeMode && questionMode !== "behavioral") {
      setQuestionMode("behavioral");
    }
  }, [canUseResumeMode, questionMode]);

  const stopVoiceCapture = useCallback(() => {
    voiceStoppedByUserRef.current = true;
    isRecordingRef.current = false;
    const active = recognitionRef.current;
    if (active) {
      try {
        active.stop();
      } catch {
        // Ignore cleanup failures if recognition is already stopped.
      }
    }
    setIsListening(false);
  }, []);

  const startVoiceCapture = useCallback(() => {
    if (isPaused || !awaitingAnswer || interviewFinished || !sessionId) return;
    stopVoiceCapture();
    voiceStoppedByUserRef.current = false;
    const Rec =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    if (!Rec) {
      setStatus("Speech recognition is unavailable in this browser.");
      return;
    }

    const recognition = new Rec();
    voiceCaptureBaselineRef.current = answer.trim();
    voiceCaptureAccumulatorRef.current = "";
    recognition.lang = "en-US";
    recognition.interimResults = true;
    recognition.continuous = true;
    isRecordingRef.current = true;

    recognition.onstart = () => {
      setIsListening(true);
      if (awaitingAnswer) {
        setStatus("Recording your answer. Speak clearly; you can continue up to 2 minutes.");
      }
    };

    recognition.onresult = (event: any) => {
      const results = Array.from(event.results);
      const transcript = normalizeTranscript(
        results
          .map((entry: any) => entry?.[0]?.transcript || "")
          .filter(Boolean)
          .join(" ")
      );

      if (!transcript) return;

      const merged = mergeTranscriptWithOverlap(
        voiceCaptureAccumulatorRef.current,
        transcript
      );
      voiceCaptureAccumulatorRef.current = merged;
      const combined = `${voiceCaptureBaselineRef.current} ${merged}`.trim();

      if (combined) {
        setAnswer(combined);
      }
    };

    recognition.onerror = () => {
      setStatus("Voice engine is having trouble. You can still type.");
      voiceStoppedByUserRef.current = true;
      isRecordingRef.current = false;
      setIsListening(false);
    };

    recognition.onend = () => {
      setIsListening(false);
      if (voiceStoppedByUserRef.current) {
        isRecordingRef.current = false;
        return;
      }

      if (!isRecordingRef.current || !awaitingAnswer || interviewFinished || loading) return;

      setTimeout(() => {
        if (!isRecordingRef.current) return;

        try {
          recognition.start();
          setIsListening(true);
        } catch {
          isRecordingRef.current = false;
          setIsListening(false);
          setStatus("Press Record Answer again to resume speech capture.");
        }
      }, 80);
    };

    recognitionRef.current = recognition;
    recognition.start();
  }, [answer, awaitingAnswer, stopVoiceCapture, isPaused, interviewFinished, loading, sessionId]);

  const startThinkingTimer = useCallback((seconds = THINKING_SECONDS) => {
    clearTimer();
    const startingSeconds = Math.max(1, Math.min(seconds, THINKING_SECONDS));
    setThinkingLeft(startingSeconds);
    setAwaitingAnswer(true);
    setAnswer("");

    if (isPausedRef.current) {
      setStatus("Interview paused. Press Resume Interview to continue.");
      return;
    }

    timerRef.current = window.setInterval(() => {
      setThinkingLeft((secondsLeft) => {
        if (secondsLeft <= 1) {
          clearTimer();
          stopVoiceCapture();
          return 0;
        }
        return secondsLeft - 1;
      });
    }, 1000);
  }, [clearTimer, stopVoiceCapture]);

  const parseInterviewStream = async (res: Response): Promise<void> => {
    const reader = res.body?.getReader();
    if (!reader) {
      setStatus("No response stream from server.");
      return;
    }

    const decoder = new TextDecoder();
    let buffer = "";
    let liveText = "";

    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }

      buffer += decoder.decode(chunk.value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const rawLine of lines) {
        const event = parseEvent(rawLine);
        if (!event) continue;

        if (event.type === "interview-meta") {
          setSessionId(event.sessionId);
          setQuestionIndex(event.questionIndex);
          setTotalQuestions(event.totalQuestions);
        }

        if (event.type === "interview-token") {
          liveText += event.token;
          setResponse(liveText);
          setStatus("Jarvis is speaking...");
        }

        if (event.type === "interview-complete") {
          const text = event.text || liveText;
          setResponse(text);
          setConversation((prev) => [...prev, { role: "Jarvis", text }]);
          setStatus("Question received. Start answering now.");
          setQuestionIndex(event.questionIndex);
          setTotalQuestions(event.totalQuestions);
          speak(text);
          setLoading(false);
          setResponse("");
          setFeedbackText("");

          if (event.finished) {
            setInterviewFinished(true);
            setAwaitingAnswer(false);
            setStatus("Interview completed. Excellent session.");
            clearTimer();
            setIsPaused(false);
          } else {
            startThinkingTimer();
          }
          return;
        }

        if (event.type === "interview-feedback") {
          setFeedbackText(event.feedback);
          setStatus("Coach note received.");
        }

        if (event.type === "interview-error") {
          setResponse(event.error || "Interview failed.");
          setStatus("Interview failed. Try again.");
          setLoading(false);
          setAwaitingAnswer(false);
          return;
        }
      }
    }

    const trailing = parseEvent(buffer);
    if (trailing?.type === "interview-complete") {
      setResponse(trailing.text || liveText);
      setConversation((prev) => [...prev, { role: "Jarvis", text: trailing.text || liveText }]);
      setQuestionIndex(trailing.questionIndex);
      setTotalQuestions(trailing.totalQuestions);
      speak(trailing.text || liveText);
      setLoading(false);
      setResponse("");
      setFeedbackText("");
      if (trailing.finished) {
        setInterviewFinished(true);
        setAwaitingAnswer(false);
        setIsPaused(false);
      } else {
        startThinkingTimer();
      }
    } else if (!response) {
      setStatus("No response received from service.");
      setLoading(false);
    }
  };

  const requestInterview = useCallback(
    async (action: InterviewAction, options: RequestOptions = {}) => {
      if (loading || requestRunningRef.current) return;
      if (isPaused && action === "next") return;
      if (action === "next" && !options.auto && !answer.trim()) return;
      if (interviewFinished && action === "next") return;
      if (action === "start" && questionMode !== "behavioral" && !resumeFile) {
        setStatus("Upload your resume PDF to use resume-based questions.");
        return;
      }

      requestRunningRef.current = true;
      const rawAnswer = options.answerOverride?.trim() || answer.trim();
      const answerToSend =
        action === "next" ? (rawAnswer || "No answer was provided in the allotted time.") : "";

      setLoading(true);
      setResponse("");
      setAwaitingAnswer(false);
      clearTimer();

      if (action === "start") {
        setConversation([]);
        setQuestionIndex(0);
        setTotalQuestions(5);
        setInterviewFinished(false);
        setIsPaused(false);
        setFeedbackText("");
        setStatus("Booting session...");
        setSessionId("");
      } else if (action === "next") {
        if (rawAnswer.trim()) {
          setConversation((prev) => [...prev, { role: "You", text: rawAnswer }]);
        }
      }

      const hasResumeFile = action === "start" && Boolean(resumeFile);
      let requestBody: string | FormData;
      const headers: HeadersInit = {};

      if (action === "start" && hasResumeFile) {
        const form = new FormData();
        form.append("action", action);
        form.append("questionMode", questionMode);
        if (resumeFile) {
          form.append("resumeFile", resumeFile);
        }
        requestBody = form;
      } else {
        const body: Record<string, string | boolean> = { action };
        if (action === "next") {
          body.sessionId = sessionId;
          body.answer = answerToSend;
          if (feedbackEnabled) {
            body.includeFeedback = true;
          }
        } else if (action === "start") {
          body.questionMode = questionMode;
        }
        headers["Content-Type"] = "application/json";
        requestBody = JSON.stringify(body);
      }

      try {
        const res = await fetch("/api/interview", {
          method: "POST",
          headers,
          body: requestBody
        });

        const contentType = res.headers.get("content-type") || "";
        if (contentType.includes("text/event-stream")) {
          if (action === "next") {
            setAnswer("");
          }

          await parseInterviewStream(res);
          return;
        }

        if (!res.ok) {
          const payload = await res.text();
          try {
            const parsed = JSON.parse(payload);
            setResponse(parsed?.error || "Unable to continue interview.");
          } catch {
            setResponse(payload || "Unable to continue interview.");
          }
          setStatus("Server error.");
          setLoading(false);
          requestRunningRef.current = false;
          return;
        }

        const payload = await res.text();
        try {
          const parsed = JSON.parse(payload);
          setResponse(parsed?.error || payload || "Unable to continue interview.");
        } catch {
          setResponse(payload || "Unable to continue interview.");
        }
        setStatus("Server returned unexpected response.");
        setLoading(false);
        requestRunningRef.current = false;
      } catch {
        setResponse("Something went wrong. Try again.");
        setStatus("Network issue.");
        setLoading(false);
      } finally {
        requestRunningRef.current = false;
      }
    },
    [
      loading,
      sessionId,
      answer,
      interviewFinished,
      isPaused,
      resumeFile,
      questionMode,
      feedbackEnabled,
      clearTimer,
      parseInterviewStream
    ]
  );

  const startInterview = useCallback(() => requestInterview("start"), [requestInterview]);

  const submitAnswer = useCallback(() => requestInterview("next"), [requestInterview]);

  const autoSubmitAnswer = useCallback(
    () => requestInterview("next", { auto: true }),
    [requestInterview]
  );

  useEffect(() => {
    if (isPaused) return;
    if (!awaitingAnswer || thinkingLeft > 0 || loading || isRecordingRef.current) return;
    autoSubmitAnswer();
  }, [awaitingAnswer, thinkingLeft, loading, isPaused, autoSubmitAnswer]);

  const pauseInterview = useCallback(() => {
    if (interviewFinished || loading) return;
    clearTimer();
    stopVoiceCapture();
    setIsPaused(true);
    setStatus("Interview paused. Press Resume Interview to continue.");
  }, [interviewFinished, loading, clearTimer, stopVoiceCapture]);

  const resumeInterview = useCallback(() => {
    if (interviewFinished || loading) return;
    const resumeFrom = thinkingLeft > 0 ? thinkingLeft : THINKING_SECONDS;
    setIsPaused(false);
    if (awaitingAnswer) {
      startThinkingTimer(resumeFrom);
    }
    setStatus("Resume accepted.");
  }, [interviewFinished, loading, thinkingLeft, awaitingAnswer, startThinkingTimer]);

  useEffect(() => {
    return () => clearTimer();
  }, [clearTimer]);

  return (
    <main
      style={{
        minHeight: "100vh",
        padding: "24px",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background:
          "radial-gradient(circle at 10% 10%, #222 0%, #030303 30%, #000 55%, #0f0f0f 100%)",
        color: "#fff",
        boxSizing: "border-box",
        fontFamily: 'Times New Roman, Times, serif'
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 1100,
          border: "2px solid #fff",
          background: "#fff",
          color: "#000",
          padding: 0,
          boxShadow: "10px 10px 0 0 rgba(255,255,255,0.85)",
          display: "grid",
          gridTemplateColumns: "280px 1fr 260px",
          minHeight: "calc(100vh - 48px)",
          gap: 0
        }}
      >
        <aside
          style={{
            borderRight: "2px solid #000",
            padding: "16px",
            background: "#000",
            color: "#fff",
            display: "flex",
            flexDirection: "column",
            gap: 20
          }}
        >
          <div style={{ border: "2px solid #fff", padding: "16px" }}>
            <h1 style={{ margin: 0, fontSize: 36, lineHeight: 1 }}>Jarvis Terminal</h1>
            <p style={{ margin: "10px 0 0", lineHeight: 1.4 }}>
              AI Mock Interviewer
            </p>
            <div
              style={{
                marginTop: 16,
                borderTop: "2px dashed rgba(255,255,255,0.4)",
                paddingTop: 12
              }}
            >
              <p style={{ margin: "0 0 8px" }}>
                Mode: {questionMode === "behavioral" ? "Behavioral" : questionMode === "resume" ? "Resume" : "Both"}
              </p>
              <p style={{ margin: 0, color: "#88ffb7" }}>
                {questionIndex}/{totalQuestions} questions
              </p>
            </div>
          </div>

          <div style={{ border: "2px solid #fff", padding: "12px" }}>
            <div style={{ marginBottom: 8, fontWeight: "bold", borderBottom: "1px dashed #fff" }}>
              Session
            </div>
            <p style={{ margin: 0, fontSize: 14 }}>
              {sessionId ? "Active" : "Not started"}
            </p>
            <p style={{ margin: "10px 0 0", fontSize: 14 }}>
              Timer: {formatTimer(thinkingLeft)}
            </p>
          </div>

          <div style={{ border: "2px solid #fff", padding: "12px", flex: 1 }}>
            <div style={{ marginBottom: 8, fontWeight: "bold", borderBottom: "1px dashed #fff" }}>
              Question Mix
            </div>
            <div style={{ marginTop: 4, display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input
                  type="checkbox"
                  checked={questionMode === "behavioral"}
                  onChange={() => setQuestionMode("behavioral")}
                  disabled={loading || !!sessionId}
                />
                Behavioral questions
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input
                  type="checkbox"
                  checked={questionMode === "resume"}
                  onChange={() => setQuestionMode("resume")}
                  disabled={loading || !!sessionId || !canUseResumeMode}
                />
                Resume questions
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input
                  type="checkbox"
                  checked={questionMode === "both"}
                  onChange={() => setQuestionMode("both")}
                  disabled={loading || !!sessionId || !canUseResumeMode}
                />
                Both
              </label>
              {!canUseResumeMode ? (
                <p style={{ margin: 0, fontSize: 11, color: "#ffc97a" }}>
                  [Upload a resume PDF to unlock Resume and Both modes.]
                </p>
              ) : null}
            </div>
          </div>
        </aside>

        <section
          style={{
            borderRight: "2px solid #000",
            display: "flex",
            flexDirection: "column",
            background: "#fdfdfd",
            color: "#000"
          }}
        >
          <header
            style={{
              borderBottom: "2px solid #000",
              padding: "10px 14px",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              fontSize: 12,
              background: "#fff"
            }}
          >
            <span>INTERVIEW.CORE</span>
            <span style={{ textTransform: "uppercase", letterSpacing: 1 }}>Live</span>
          </header>

          <div
            style={{
              flex: 1,
              padding: 18,
              overflowY: "auto",
              borderBottom: "2px solid #000",
              backgroundImage:
                "linear-gradient(to right, transparent 97%, #000 97%, #000 97.5%, transparent 97.5%)"
            }}
          >
            <div style={{ marginBottom: 20, textAlign: "center" }}>
              <span
                style={{
                  border: "2px solid #000",
                  padding: "4px 10px",
                  display: "inline-block",
                  background: "#000",
                  color: "#fff",
                  fontSize: 12,
                  fontFamily: "monospace"
                }}
              >
                STATUS: {status}
              </span>
            </div>

            {conversation.map((turn, idx) => (
              <p
                key={`${turn.role}-${idx}`}
                style={{
                  maxWidth: "84%",
                  margin: "8px 0",
                  marginRight: turn.role === "You" ? "0" : "auto",
                  marginLeft: turn.role === "You" ? "auto" : "0",
                  padding: "10px 12px",
                  border: "2px solid #000",
                  background: turn.role === "Jarvis" ? "#fff" : "#000",
                  color: turn.role === "Jarvis" ? "#000" : "#fff",
                  boxShadow:
                    turn.role === "Jarvis"
                      ? "3px 3px 0 0 #000"
                      : "-3px 3px 0 0 #fff",
                  lineHeight: 1.45
                }}
              >
                <strong>{turn.role}: </strong>
                {turn.text}
              </p>
            ))}
            {response && conversation[conversation.length - 1]?.role !== "Jarvis" && (
              <p
                style={{
                  maxWidth: "84%",
                  margin: "10px 0",
                  padding: "10px 12px",
                  border: "2px solid #000",
                  background: "#fff",
                  color: "#000",
                  boxShadow: "3px 3px 0 0 #000",
                  lineHeight: 1.45
                }}
              >
                <strong>Jarvis: </strong>
                {response}
              </p>
            )}
          </div>

          <div style={{ padding: 14, background: "#fff" }}>
            <label htmlFor="answer" style={{ display: "block", marginBottom: 6, fontWeight: 700 }}>
              Your answer
            </label>
            <textarea
              id="answer"
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              rows={6}
              placeholder="Type your answer or let voice input capture it..."
              style={{
                width: "100%",
                resize: "vertical",
                border: "2px solid #000",
                background: "#f4f4f4",
                color: "#000",
                padding: 10,
                fontSize: 16,
                fontFamily: "Courier New, Courier, monospace",
                boxSizing: "border-box"
              }}
            />

            <div style={{ marginTop: 10, display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button
                onClick={startInterview}
                disabled={loading}
                style={{
                  background: "#000",
                  color: "#fff",
                  border: "2px solid #fff",
                  padding: "10px 14px",
                  cursor: loading ? "not-allowed" : "pointer",
                  fontFamily: 'Times New Roman, Times, serif'
                }}
              >
                Start Interview
              </button>

              <button
                onClick={isListening ? stopVoiceCapture : startVoiceCapture}
                disabled={loading || interviewFinished || isPaused || !awaitingAnswer}
                style={{
                  border: "2px solid #000",
                  padding: "10px 14px",
                  background: isListening ? "#000" : "#fff",
                  color: isListening ? "#fff" : "#000",
                  cursor: loading || interviewFinished || isPaused ? "not-allowed" : "pointer"
                }}
              >
                {isListening ? "Stop Recording" : "Record Answer"}
              </button>

              <button
                onClick={isPaused ? resumeInterview : pauseInterview}
                disabled={loading || interviewFinished}
                style={{
                  border: "2px solid #000",
                  padding: "10px 14px",
                  background: isPaused ? "#111" : "#fff",
                  color: isPaused ? "#fff" : "#000",
                  cursor: loading || interviewFinished ? "not-allowed" : "pointer"
                }}
              >
                {isPaused ? "Resume Interview" : "Pause Interview"}
              </button>

              <button
                onClick={() => setVoiceEnabled((prev) => !prev)}
                style={{
                  border: "2px solid #000",
                  padding: "10px 14px",
                  background: voiceEnabled ? "#e8e8e8" : "#000",
                  color: voiceEnabled ? "#000" : "#fff",
                  cursor: "pointer"
                }}
              >
                {voiceEnabled ? "Mute Jarvis Voice" : "Enable Jarvis Voice"}
              </button>

              <button
                onClick={() => setFeedbackEnabled((prev) => !prev)}
                style={{
                  border: "2px solid #000",
                  padding: "10px 14px",
                  background: feedbackEnabled ? "#111" : "#fff",
                  color: feedbackEnabled ? "#fff" : "#000",
                  cursor: "pointer"
                }}
              >
                {feedbackEnabled ? "Feedback: ON" : "Feedback: OFF"}
              </button>

              <button
                onClick={submitAnswer}
                disabled={loading || isPaused || !answer.trim() || interviewFinished}
                style={{
                  border: "2px solid #fff",
                  background:
                    loading || isPaused || !answer.trim() || interviewFinished ? "#999" : "#111",
                  color:
                    loading || isPaused || !answer.trim() || interviewFinished ? "#222" : "#fff",
                  padding: "10px 16px",
                  cursor:
                    loading || isPaused || !answer.trim() || interviewFinished
                      ? "not-allowed"
                      : "pointer"
                }}
              >
                {loading ? "Thinking..." : "Submit Answer"}
              </button>
            </div>
          </div>
        </section>

        <aside
          style={{
            background: "#000",
            color: "#fff",
            borderLeft: "2px solid #fff",
            padding: "16px",
            display: "flex",
            flexDirection: "column",
            gap: 16
          }}
        >
          <div style={{ border: "2px solid #fff", padding: "12px" }}>
            <div style={{ marginBottom: 8, fontSize: 12, letterSpacing: 1 }}>LIVE METRICS</div>
            <div style={{ marginBottom: 8, display: "flex", justifyContent: "space-between" }}>
              <span>Question</span>
              <span>{questionIndex}</span>
            </div>
            <div style={{ marginBottom: 8, display: "flex", justifyContent: "space-between" }}>
              <span>Target</span>
              <span>{totalQuestions}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span>Timer</span>
              <span>{formatTimer(thinkingLeft)}</span>
            </div>
          </div>

          <div style={{ border: "2px solid #fff", padding: "12px", flex: 1 }}>
            <div style={{ fontSize: 12, marginBottom: 6, borderBottom: "1px dashed #fff" }}>
              QUICK NOTES
            </div>
            <p style={{ margin: 0, fontFamily: "monospace", fontSize: 12, lineHeight: 1.45 }}>
              {" > "}Use STAR method<br />
              {" > "}Keep answers crisp<br />
              {" > "}Mention impact and outcome
            </p>
            <div style={{ marginTop: 12, borderTop: "1px dashed #fff", paddingTop: 10 }}>
              <div style={{ fontSize: 12, marginBottom: 4, borderBottom: "1px dashed #fff" }}>
                Suggestion
              </div>
              <p style={{ margin: 0, fontSize: 13, lineHeight: 1.45 }}>
                {feedbackText || "Keep your answer structured: Situation, Task, Action, Result."}
              </p>
            </div>
          </div>

          <div style={{ border: "2px solid #fff", padding: "12px", flex: 0.9 }}>
            <div style={{ fontSize: 12, marginBottom: 6, borderBottom: "1px dashed #fff" }}>
              RESUME INPUT
            </div>
            <p
              style={{
                margin: 0,
                fontSize: 12,
                lineHeight: 1.4,
                opacity: 0.9
              }}
            >
              Attach your resume PDF to generate role-ready follow-up questions.
            </p>
            <div style={{ marginTop: 10, marginBottom: 10 }}>
              <label
                htmlFor="resume-file"
                style={{ display: "block", marginBottom: 4, fontSize: 12, fontFamily: "monospace" }}
              >
                Upload resume PDF
              </label>
              <input
                id="resume-file"
                type="file"
                accept=".pdf,application/pdf"
                onChange={(e) => {
                  const file = e.target.files?.[0] || null;
                  setResumeFile(file);
                  if (file) {
                    setStatus("Resume uploaded. Jarvis is ready to screen this candidate.");
                  } else {
                    setStatus("Resume attachment removed.");
                    setQuestionMode("behavioral");
                  }
                }}
                disabled={loading || !!sessionId}
                style={{
                  width: "100%",
                  background: "#000",
                  color: "#fff",
                  border: "2px solid #fff"
                }}
              />
              <p style={{ margin: "8px 0 0", fontSize: 12, opacity: 0.85 }}>
                {resumeFile ? `Selected: ${resumeFile.name}` : "No resume file selected"}
              </p>
              <p
                style={{
                  margin: "6px 0 0",
                  fontSize: 12,
                  color: resumeFile ? "#59f89f" : "rgba(255,255,255,0.7)",
                  fontFamily: "Courier New, Courier, monospace",
                  fontWeight: 700
                }}
              >
                {resumeFile ? "✓ Resume uploaded — ready for resume-based screening" : "Awaiting resume attachment"}
              </p>
              <p style={{ margin: "6px 0 0", fontSize: 10, opacity: 0.7 }}>
                Supported: PDF (up to 4 MB). Text is optional when PDF is attached.
              </p>
            </div>
          </div>
        </aside>
      </div>
    </main>
  );
}
