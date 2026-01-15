"use client";

import { useState } from "react";

export default function Home() {
  const [answer, setAnswer] = useState("");
  const [response, setResponse] = useState("");
  const [loading, setLoading] = useState(false);
  const [voiceEnabled, setVoiceEnabled] = useState(true);

  const speak = (text: string) => {
    if (!voiceEnabled) return;
    if (!window.speechSynthesis) return;

    // stop any previous speech
    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 0.95;
    utterance.pitch = 0.9;
    utterance.volume = 1;

    const voices = window.speechSynthesis.getVoices();
    const preferred = voices.find(
      (v) =>
        v.name.toLowerCase().includes("male") ||
        v.name.toLowerCase().includes("english")
    );

    if (preferred) {
      utterance.voice = preferred;
    }

    window.speechSynthesis.speak(utterance);
  };

  const submitAnswer = async () => {
    if (!answer.trim()) return;

    setLoading(true);
    setResponse("");

    try {
      const res = await fetch("/api/interview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answer })
      });

      const data = await res.json();

      if (data.error) {
        setResponse(data.error);
      } else {
        setResponse(data.interviewer);
        speak(data.interviewer);
      }
    } catch {
      setResponse("Something went wrong. Try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <main
      style={{
        minHeight: "100vh",
        width: "100vw",
        padding: "48px 20px",
        fontFamily: "sans-serif",
        fontSize: "24px",
        fontWeight: 700,
        backgroundImage:
          "linear-gradient(rgba(0, 0, 0, 0.92), rgba(0, 0, 0, 0.92)), url('/bg.jpeg')",
        backgroundSize: "cover",
        backgroundPosition: "center",
        backgroundRepeat: "no-repeat",
        color: "#f5f5f5",
        boxSizing: "border-box"
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 780,
          margin: "0 auto"
        }}
      >
        <h1>Jarvis Mock Interviewer</h1>
        <p>Answer the interview question and Jarvis will respond.</p>

        <textarea
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          placeholder="Type your interview answer here..."
          rows={6}
          style={{
            width: "100%",
            padding: 12,
            marginTop: 12,
            fontSize: "24px",
            fontWeight: 700,
            boxSizing: "border-box"
          }}
        />

        <div style={{ marginTop: 12 }}>
          <button
            onClick={submitAnswer}
            disabled={loading}
            style={{ padding: "10px 20px" }}
          >
            {loading ? "Thinking..." : "Submit Answer"}
          </button>

          <button
            onClick={() => setVoiceEnabled(!voiceEnabled)}
            style={{ marginLeft: 12, padding: "10px 20px" }}
          >
            {voiceEnabled ? "Mute Jarvis 🔇" : "Unmute Jarvis 🔊"}
          </button>
        </div>

        {response && (
          <div style={{ marginTop: 24 }}>
            <h3>Jarvis</h3>
            <p>{response}</p>
          </div>
        )}
      </div>
    </main>
  );
}
