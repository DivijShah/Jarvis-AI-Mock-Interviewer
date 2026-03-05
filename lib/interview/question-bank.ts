type QuestionDifficulty = "easy" | "medium" | "hard";

type BehavioralQuestion = {
  text: string;
  difficulty: QuestionDifficulty;
};

const EASY_QUESTIONS: BehavioralQuestion[] = [
  { text: "Tell me about yourself.", difficulty: "easy" },
  { text: "What is your biggest strength and area of growth?", difficulty: "easy" },
  { text: "Why are you interested in this opportunity?", difficulty: "easy" },
  { text: "Why are you considering a new opportunity now?", difficulty: "easy" },
  { text: "Where do you want to be in five years?", difficulty: "easy" },
  {
    text: "Tell me about a time your work responsibilities got a little overwhelming. What did you do?",
    difficulty: "easy"
  },
  { text: "What are your three strengths and three weaknesses?", difficulty: "easy" },
  {
    text: "Tell me about a time you needed information from someone who was not responsive. What did you do?",
    difficulty: "easy"
  },
  {
    text: "What is something 90% of people disagree with you about?",
    difficulty: "easy"
  },
  {
    text: "What are some of the best and worst things about your current or recent workplace?",
    difficulty: "easy"
  },
  { text: "How do you stay up to date with the latest technologies?", difficulty: "easy" },
  { text: "How would you describe your preferred work environment?", difficulty: "easy" },
  { text: "Tell me something about your internship experience.", difficulty: "easy" }
];

const MEDIUM_QUESTIONS: BehavioralQuestion[] = [
  { text: "What are your salary expectations?", difficulty: "medium" },
  {
    text: "Give me an example of a time you disagreed with a team member. How did you handle it?",
    difficulty: "medium"
  },
  {
    text: "Tell me about a recent challenge in your role. How did you tackle it and what was the outcome?",
    difficulty: "medium"
  },
  {
    text: "Tell me about your most interesting or challenging project to date.",
    difficulty: "medium"
  },
  {
    text: "Why is this company/role appealing to you, and what are you looking for in your next role?",
    difficulty: "medium"
  },
  {
    text: "How do you deal with difficult coworkers? Share a specific conflict-resolution example.",
    difficulty: "medium"
  },
  {
    text: "Tell me about a time someone had a different viewpoint than you. How did you handle it?",
    difficulty: "medium"
  },
  {
    text: "Teach me something you've recently learned.",
    difficulty: "medium"
  },
  { text: "What was the most fun thing you worked on recently?", difficulty: "medium" },
  {
    text: "What would your manager likely say your biggest strength was?",
    difficulty: "medium"
  },
  {
    text: "What is your favorite feature in any product you have worked on, and why?",
    difficulty: "medium"
  },
  {
    text: "What would your previous boss say your biggest strength was?",
    difficulty: "medium"
  },
  {
    text: "Tell me about an analytical problem you have worked on in the past.",
    difficulty: "medium"
  },
  {
    text: "How do you handle receiving feedback and turning it into action?",
    difficulty: "medium"
  }
];

const HARD_QUESTIONS: BehavioralQuestion[] = [
  {
    text: "Tell me the story of how you became who you are professionally today.",
    difficulty: "hard"
  },
  { text: "What have you built that you are proud of?", difficulty: "hard" },
  {
    text: "What is the hardest technical problem you have run into?",
    difficulty: "hard"
  },
  { text: "How did you solve it?", difficulty: "hard" },
  {
    text: "Explain a project you worked on recently that was especially difficult.",
    difficulty: "hard"
  },
  {
    text: "Describe your toughest project and the architecture you designed.",
    difficulty: "hard"
  },
  {
    text: "How did you convince a difficult teammate to align with the team direction?",
    difficulty: "hard"
  },
  {
    text: "Did you find any bugs in a product you used? What did you do with that finding?",
    difficulty: "hard"
  },
  {
    text: "Tell me about a time you predicted something in your work that proved right.",
    difficulty: "hard"
  },
  {
    text: "What is something in your environment or workflow you think is currently broken?",
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
    return "Tell me about a challenging problem you solved recently.";
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
