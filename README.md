# Jarvis Mock Interviewer

AI-powered mock interview engine with real-time streaming follow-up question generation and voice interaction.

## Features

- Real-time streaming interview responses via `text/event-stream`.
- Modular conversation state handling with session-scoped interview turns.
- Server-side safeguards for quota errors, malformed model responses, and retry/fallback behavior.
- Optional voice input and browser speech synthesis for Jarvis responses.
- Gemini-first runtime (`GEMINI_API_KEY`) with fallback to alternate free-tier-friendly Gemini models.
- Basic in-memory rate limiting on `POST /api/interview` and `POST /api/transcribe`.

## Environment

Set your API key and optional model:

```bash
GEMINI_API_KEY=your_gemini_api_key
# optional (defaults to gemini-2.5-flash)
GEMINI_MODEL=gemini-2.5-flash
```

Add it to your environment (or `.env.local`) before running.

```bash
JARVIS_INTERVIEW_CODE=your_private_unlock_code
```

Keep all API keys server-side only. Do not expose them in client code or `NEXT_PUBLIC_*` variables.

## Run

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## API

`POST /api/interview`

Request body:

- `action`: `start` to begin interview, `next` for follow-up
- `sessionId`: optional existing session id
- `answer`: candidate answer (required for `next`)

Responses are delivered as SSE events:

- `interview-meta`
- `interview-token`
- `interview-complete`
- `interview-error`

## Quick API examples

Start a fresh interview session:

```bash
curl -N -X POST http://localhost:3000/api/interview \
  -H \"Content-Type: application/json\" \
  -d '{\"action\":\"start\"}'
```

Send your answer and get a follow-up:

```bash
curl -N -X POST http://localhost:3000/api/interview \
  -H \"Content-Type: application/json\" \
  -d '{\"action\":\"next\",\"sessionId\":\"<SESSION_ID_FROM_START>\",\"answer\":\"I led a team of 4 engineers on a full-stack rewrite using React and Node.\"}'
```

## Hosting at `/jarvis`

If you link to this app from another Next.js site, disable prefetch on the link:

```tsx
<Link href="/jarvis" prefetch={false}>Open Jarvis</Link>
```

This keeps Jarvis route code from being eagerly downloaded on unrelated pages.

## Question bank

Behavioral engineering prompts are seeded from:

- `lib/interview/question-bank.ts` (`ENGINEERING_BEHAVIORAL_QUESTIONS`)

Replace this list with your own questions and keep the structure:

```ts
export const ENGINEERING_BEHAVIORAL_QUESTIONS = [
  "Tell me about a time you..."
];
```
