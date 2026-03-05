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
  | {
      type: "interview-locked";
      reason: string;
      sessionId: string;
      questionIndex: number;
      totalQuestions: number;
    }
  | { type: "interview-feedback"; feedback: string }
  | { type: "interview-error"; error: string };

type InterviewAction = "start" | "next" | "unlock";
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
  const [totalQuestions, setTotalQuestions] = useState(2);
  const [thinkingLeft, setThinkingLeft] = useState(0);
  const [awaitingAnswer, setAwaitingAnswer] = useState(false);
  const [feedbackText, setFeedbackText] = useState("");
  const [feedbackEnabled, setFeedbackEnabled] = useState(false);
  const [resumeFile, setResumeFile] = useState<File | null>(null);
  const [questionMode, setQuestionMode] = useState<QuestionMode>("behavioral");
  const [interviewLocked, setInterviewLocked] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [unlockCode, setUnlockCode] = useState("");
  const canUseResumeMode = Boolean(resumeFile);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const recordedChunksRef = useRef<BlobPart[]>([]);
  const recordingTimeoutRef = useRef<number | null>(null);
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

  const clearRecordingTimeout = useCallback(() => {
    if (recordingTimeoutRef.current !== null) {
      window.clearTimeout(recordingTimeoutRef.current);
      recordingTimeoutRef.current = null;
    }
  }, []);

  const stopMediaStream = useCallback(() => {
    if (mediaStreamRef.current) {
      for (const track of mediaStreamRef.current.getTracks()) {
        track.stop();
      }
      mediaStreamRef.current = null;
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

  const transcribeRecordedAudio = useCallback(async (audioBlob: Blob) => {
    if (!audioBlob || audioBlob.size <= 0) {
      setStatus("No audio captured. Please try recording again.");
      return;
    }

    setStatus("Transcribing your answer...");
    try {
      const form = new FormData();
      form.append("audio", audioBlob, `answer-${Date.now()}.webm`);

      const res = await fetch("/api/transcribe", {
        method: "POST",
        body: form
      });

      const payload = await res.json().catch(() => ({} as { text?: string; error?: string }));
      if (!res.ok) {
        setStatus(payload?.error || "Transcription failed. You can type your answer.");
        return;
      }

      const text = normalizeTranscript(typeof payload?.text === "string" ? payload.text : "");
      if (!text) {
        setStatus("No speech detected. Try again or type your answer.");
        return;
      }

      setAnswer((prev) => normalizeTranscript(`${prev} ${text}`));
      setStatus("Transcription added. Review and submit your answer.");
    } catch {
      setStatus("Transcription request failed. You can still type your answer.");
    }
  }, []);

  const stopVoiceCapture = useCallback(() => {
    clearRecordingTimeout();
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      try {
        recorder.stop();
      } catch {
        // Ignore cleanup failures if recorder is already stopped.
      }
      return;
    }

    isRecordingRef.current = false;
    setIsListening(false);
    stopMediaStream();
  }, [clearRecordingTimeout, stopMediaStream]);

  const startVoiceCapture = useCallback(() => {
    if (isPaused || !awaitingAnswer || interviewFinished || !sessionId) return;
    stopVoiceCapture();
    clearTimer();

    if (!navigator?.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setStatus("Audio recording is unavailable in this browser.");
      return;
    }

    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((stream) => {
        mediaStreamRef.current = stream;
        recordedChunksRef.current = [];

        const mimeCandidates = [
          "audio/webm;codecs=opus",
          "audio/webm",
          "audio/ogg;codecs=opus"
        ];
        const preferredMimeType =
          mimeCandidates.find((candidate) => {
            try {
              return MediaRecorder.isTypeSupported(candidate);
            } catch {
              return false;
            }
          }) || "";

        const recorder = preferredMimeType
          ? new MediaRecorder(stream, { mimeType: preferredMimeType })
          : new MediaRecorder(stream);

        mediaRecorderRef.current = recorder;
        isRecordingRef.current = true;
        setIsListening(true);
        setStatus("Recording your answer. Press Stop Recording when done.");

        recorder.ondataavailable = (event) => {
          if (event.data && event.data.size > 0) {
            recordedChunksRef.current.push(event.data);
          }
        };

        recorder.onerror = () => {
          setStatus("Recorder error. You can retry recording or type your answer.");
        };

        recorder.onstop = () => {
          clearRecordingTimeout();
          setIsListening(false);
          isRecordingRef.current = false;

          const audioBlob = new Blob(recordedChunksRef.current, {
            type: recorder.mimeType || "audio/webm"
          });
          recordedChunksRef.current = [];
          stopMediaStream();
          mediaRecorderRef.current = null;
          void transcribeRecordedAudio(audioBlob);
        };

        recorder.start(250);

        recordingTimeoutRef.current = window.setTimeout(() => {
          if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
            setStatus("Max recording window reached (2 minutes). Stopping and transcribing...");
            stopVoiceCapture();
          }
        }, THINKING_SECONDS * 1000);
      })
      .catch(() => {
        setIsListening(false);
        isRecordingRef.current = false;
        stopMediaStream();
        setStatus("Microphone access denied. You can still type your answer.");
      });
  }, [
    awaitingAnswer,
    stopVoiceCapture,
    isPaused,
    interviewFinished,
    sessionId,
    clearTimer,
    clearRecordingTimeout,
    stopMediaStream,
    transcribeRecordedAudio
  ]);

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
            setInterviewLocked(false);
            setUnlockCode("");
            clearTimer();
            setIsPaused(false);
          } else {
            startThinkingTimer();
          }
          return;
        }

        if (event.type === "interview-locked") {
          const lockedText =
            event.reason || "Trial limit reached. Enter your unlock code to continue.";
          setResponse(lockedText);
          setConversation((prev) => [...prev, { role: "Jarvis", text: lockedText }]);
          setQuestionIndex(event.questionIndex);
          setTotalQuestions(event.totalQuestions);
          setStatus(lockedText);
          setInterviewFinished(true);
          setInterviewLocked(true);
          setAwaitingAnswer(false);
          setLoading(false);
          setResponse("");
          setFeedbackText("");
          clearTimer();
          setIsPaused(false);
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
        setInterviewLocked(false);
        setUnlockCode("");
        setIsPaused(false);
      } else {
        startThinkingTimer();
      }
    } else if (trailing?.type === "interview-locked") {
      const lockedText =
        trailing.reason || "Trial limit reached. Enter your unlock code to continue.";
      setResponse(lockedText);
      setConversation((prev) => [...prev, { role: "Jarvis", text: lockedText }]);
      setQuestionIndex(trailing.questionIndex);
      setTotalQuestions(trailing.totalQuestions);
      setStatus(lockedText);
      setInterviewFinished(true);
      setInterviewLocked(true);
      setAwaitingAnswer(false);
      setLoading(false);
      setResponse("");
      setFeedbackText("");
      clearTimer();
      setIsPaused(false);
    } else if (!response) {
      setStatus("No response received from service.");
      setLoading(false);
    }
  };

  const requestInterview = useCallback(
    async (action: InterviewAction, options: RequestOptions = {}) => {
      if (loading || requestRunningRef.current) return;
      if (isPaused && action === "next") return;
      if (action === "next" && interviewLocked) return;
      if (action === "next" && isListening) {
        setStatus("Stop recording and wait for transcription before submitting.");
        return;
      }
      if (action === "next" && !options.auto && !answer.trim()) return;
      if (interviewFinished && action === "next") return;
      if (action === "start" && questionMode !== "behavioral" && !resumeFile) {
        setStatus("Upload your resume PDF to use resume-based questions.");
        return;
      }
      if (action === "unlock" && !unlockCode.trim()) {
        setStatus("Enter the unlock code to continue.");
        return;
      }
      if (action === "unlock" && !sessionId) {
        setStatus("Start an interview before trying to unlock.");
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
        setTotalQuestions(2);
        setInterviewFinished(false);
        setIsPaused(false);
        setInterviewLocked(false);
        setUnlockCode("");
        setFeedbackText("");
        setStatus("Booting session...");
        setSessionId("");
      } else if (action === "next") {
        if (rawAnswer.trim()) {
          setConversation((prev) => [...prev, { role: "You", text: rawAnswer }]);
        }
      } else if (action === "unlock") {
        setInterviewFinished(false);
        setInterviewLocked(false);
        setFeedbackText("");
        setStatus("Validating unlock code...");
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
        if (action === "unlock") {
          body.unlockCode = unlockCode;
        }
        if (action === "next") {
          body.sessionId = sessionId;
          body.answer = answerToSend;
          if (feedbackEnabled) {
            body.includeFeedback = true;
          }
        } else if (action === "unlock") {
          body.sessionId = sessionId;
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
      isListening,
      interviewFinished,
      interviewLocked,
      isPaused,
      unlockCode,
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
    return () => {
      clearTimer();
      stopVoiceCapture();
      stopMediaStream();
      clearRecordingTimeout();
    };
  }, [clearTimer, stopVoiceCapture, stopMediaStream, clearRecordingTimeout]);

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
                disabled={loading || isPaused || isListening || !answer.trim() || interviewFinished}
                style={{
                  border: "2px solid #fff",
                  background:
                    loading || isPaused || isListening || !answer.trim() || interviewFinished ? "#999" : "#111",
                  color:
                    loading || isPaused || isListening || !answer.trim() || interviewFinished ? "#222" : "#fff",
                  padding: "10px 16px",
                  cursor:
                    loading || isPaused || isListening || !answer.trim() || interviewFinished
                      ? "not-allowed"
                      : "pointer"
                }}
              >
                {loading ? "Thinking..." : "Submit Answer"}
              </button>
            </div>

            {interviewLocked ? (
              <div
                style={{
                  marginTop: 12,
                  border: "2px solid #000",
                  padding: 12,
                  background: "#e9e9e9"
                }}
              >
                <p style={{ margin: 0, fontSize: 12, fontWeight: 700 }}>
                  Session locked after 2 questions. Enter code to continue.
                </p>
                <input
                  type="password"
                  value={unlockCode}
                  onChange={(e) => setUnlockCode(e.target.value)}
                  placeholder="Enter unlock code"
                  style={{
                    width: "100%",
                    marginTop: 8,
                    marginBottom: 8,
                    border: "2px solid #000",
                    padding: "8px",
                    fontFamily: "Courier New, Courier, monospace"
                  }}
                />
                <button
                  onClick={() => requestInterview("unlock")}
                  disabled={loading || !unlockCode.trim()}
                  style={{
                    border: "2px solid #000",
                    padding: "10px 14px",
                    background: loading || !unlockCode.trim() ? "#999" : "#111",
                    color: loading || !unlockCode.trim() ? "#222" : "#fff",
                    cursor: loading || !unlockCode.trim() ? "not-allowed" : "pointer"
                  }}
                >
                  Continue with code
                </button>
              </div>
            ) : null}
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
