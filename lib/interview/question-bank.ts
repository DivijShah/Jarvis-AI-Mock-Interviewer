type QuestionDifficulty = "easy" | "medium" | "hard";

type BehavioralQuestion = {
  text: string;
  difficulty: QuestionDifficulty;
};

const EASY_QUESTIONS: BehavioralQuestion[] = [
  { text: "Walk me through your background and how it prepared you for software engineering roles.", difficulty: "easy" },
  { text: "What is your strongest engineering skill, and what are you actively improving?", difficulty: "easy" },
  { text: "What attracts you to this software engineering role and team?", difficulty: "easy" },
  { text: "Why are you considering a new opportunity at this point in your career?", difficulty: "easy" },
  { text: "Where do you want to be as an engineer in five years?", difficulty: "easy" },
  {
    text: "Tell me about a time your engineering workload became overwhelming. How did you prioritize and deliver?",
    difficulty: "easy"
  },
  { text: "What are three engineering strengths and three growth areas you are working on?", difficulty: "easy" },
  {
    text: "Tell me about a time you were blocked waiting on information from another team. What did you do?",
    difficulty: "easy"
  },
  {
    text: "What is an engineering opinion you hold that many people disagree with, and why?",
    difficulty: "easy"
  },
  {
    text: "What are the best and hardest parts of your current or recent engineering environment?",
    difficulty: "easy"
  },
  { text: "How do you stay current with engineering best practices, tools, and system design trends?", difficulty: "easy" },
  { text: "What kind of engineering culture helps you do your best work?", difficulty: "easy" },
  { text: "Tell me about your internship or early-career engineering experience and what you learned.", difficulty: "easy" }
];

const MEDIUM_QUESTIONS: BehavioralQuestion[] = [
  { text: "What are your salary expectations?", difficulty: "medium" },
  {
    text: "Give me an example of a technical disagreement with a teammate. How did you resolve it?",
    difficulty: "medium"
  },
  {
    text: "Tell me about a recent production or delivery challenge. How did you tackle it and what was the outcome?",
    difficulty: "medium"
  },
  {
    text: "Tell me about your most interesting or challenging engineering project to date.",
    difficulty: "medium"
  },
  {
    text: "Why is this role appealing, and what kind of technical scope are you looking for next?",
    difficulty: "medium"
  },
  {
    text: "How do you work through conflict with difficult coworkers on engineering decisions? Share a specific example.",
    difficulty: "medium"
  },
  {
    text: "Tell me about a time someone had a different technical viewpoint than you. How did you handle it?",
    difficulty: "medium"
  },
  {
    text: "Teach me an engineering concept or tool you recently learned and applied.",
    difficulty: "medium"
  },
  { text: "What project did you enjoy most recently, and what engineering impact did it have?", difficulty: "medium" },
  {
    text: "What would your manager say is your biggest engineering strength?",
    difficulty: "medium"
  },
  {
    text: "What is your favorite feature you shipped, and why was it technically meaningful?",
    difficulty: "medium"
  },
  {
    text: "What would your previous manager say is your biggest area for growth?",
    difficulty: "medium"
  },
  {
    text: "Tell me about an analytical engineering problem you solved and the approach you used.",
    difficulty: "medium"
  },
  {
    text: "How do you handle engineering feedback and turn it into measurable improvement?",
    difficulty: "medium"
  }
];

const HARD_QUESTIONS: BehavioralQuestion[] = [
  {
    text: "Tell me the story of how you became the engineer you are today.",
    difficulty: "hard"
  },
  { text: "What have you built that you are most proud of, and why?", difficulty: "hard" },
  {
    text: "What is the hardest technical problem you have faced in production?",
    difficulty: "hard"
  },
  { text: "How did you solve that problem, and what trade-offs did you make?", difficulty: "hard" },
  {
    text: "Explain a difficult project you worked on recently, including constraints and outcome.",
    difficulty: "hard"
  },
  {
    text: "Describe your toughest project and the architecture decisions behind it.",
    difficulty: "hard"
  },
  {
    text: "How did you influence a teammate or stakeholder to align on a technical direction?",
    difficulty: "hard"
  },
  {
    text: "Tell me about a critical bug or incident you handled. What was your debugging process?",
    difficulty: "hard"
  },
  {
    text: "Tell me about a time you predicted a technical risk early and how it affected delivery.",
    difficulty: "hard"
  },
  {
    text: "What engineering process or system around you is broken, and how would you improve it?",
    difficulty: "hard"
  }
];

export const ENGINEERING_BEHAVIORAL_QUESTIONS = [
  ...EASY_QUESTIONS,
  ...MEDIUM_QUESTIONS,
  ...HARD_QUESTIONS
].map((entry) => entry.text);

const DEFAULT_DIFFICULTY_PATTERN: QuestionDifficulty[] = [
  "easy",
  "easy",
  "medium",
  "medium",
  "hard"
];

const FALLBACK_DIFFICULTY: Record<QuestionDifficulty, QuestionDifficulty[]> = {
  easy: ["easy", "medium", "hard"],
  medium: ["medium", "hard", "easy"],
  hard: ["hard", "medium", "easy"]
};

function seededRandom(seed = "jarvis-session"): () => number {
  let hash = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }

  return function next() {
    hash += hash << 1;
    hash ^= hash >>> 11;
    hash += hash << 15;
    return ((hash >>> 0) % 2147483648) / 2147483648;
  };
}

function shuffleWithRng<T>(values: T[], rng: () => number): T[] {
  const copy = [...values];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export function pickQuestionSet(seed = "", count = 5): string[] {
  const requested = Math.max(1, Math.min(count, 5));
  if (requested > EASY_QUESTIONS.length + MEDIUM_QUESTIONS.length + HARD_QUESTIONS.length) {
    return [];
  }

  const pools: Record<QuestionDifficulty, string[]> = {
    easy: shuffleWithRng(
      EASY_QUESTIONS.map((entry) => entry.text),
      seededRandom(`${seed}:easy`)
    ),
    medium: shuffleWithRng(
      MEDIUM_QUESTIONS.map((entry) => entry.text),
      seededRandom(`${seed}:medium`)
    ),
    hard: shuffleWithRng(
      HARD_QUESTIONS.map((entry) => entry.text),
      seededRandom(`${seed}:hard`)
    )
  };

  const selected: string[] = [];
  const used = new Set<string>();

  for (let index = 0; index < requested; index += 1) {
    const targetDifficulty =
      DEFAULT_DIFFICULTY_PATTERN[
        Math.min(index, DEFAULT_DIFFICULTY_PATTERN.length - 1)
      ];
    const candidateBuckets = FALLBACK_DIFFICULTY[targetDifficulty];
    let question: string | undefined;

    for (const bucket of candidateBuckets) {
      question = pools[bucket].shift();
      if (question && !used.has(question)) {
        break;
      }
      question = undefined;
    }

    if (!question) {
      const fallback = shuffleWithRng(
        [
          ...pools.easy,
          ...pools.medium,
          ...pools.hard
        ],
        seededRandom(`${seed}:fallback:${index}`)
      );
      question = fallback.shift();
    }

    if (!question) break;
    used.add(question);
    selected.push(question);
  }

  return selected;
}

export function pickBehavioralQuestion(seed?: string): string {
  if (!ENGINEERING_BEHAVIORAL_QUESTIONS.length) {
    return "Tell me about a challenging software engineering problem you solved recently.";
  }

  const baseText = seed?.trim() || "";
  if (!baseText) {
    const index = Math.floor(Math.random() * ENGINEERING_BEHAVIORAL_QUESTIONS.length);
    return ENGINEERING_BEHAVIORAL_QUESTIONS[index];
  }

  let hash = 0;
  for (let i = 0; i < baseText.length; i += 1) {
    hash = (hash * 31 + baseText.charCodeAt(i)) % ENGINEERING_BEHAVIORAL_QUESTIONS.length;
  }
  const index = Math.abs(hash) % ENGINEERING_BEHAVIORAL_QUESTIONS.length;
  return ENGINEERING_BEHAVIORAL_QUESTIONS[index];
}
