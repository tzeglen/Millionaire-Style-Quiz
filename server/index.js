import cors from "cors";
import express from "express";
import { randomUUID } from "crypto";
import { existsSync, readdirSync, readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
const PORT = process.env.PORT || 4000;
const QUESTION_POINTS = Number(process.env.QUESTION_POINTS || 10);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SETS_DIR = path.join(__dirname, "question_sets");

app.use(cors());
app.use(express.json());

const players = new Map(); // playerId -> { id, nickname, score }
let question = {
  id: null,
  prompt: "",
  options: [],
  status: "idle", // idle | active | revealed
  correctIndex: null,
  createdAt: null,
  setId: null,
  setName: null,
  setQuestionIndex: null,
};
let answers = new Map(); // playerId -> { answerIndex, answeredAt, correct }
let questionSets = new Map(); // id -> { id, name, questions }
let activeSet = null; // { id, name, index, total }
let activeSetAnswerIndex = null;

const connections = new Set(); // { res, playerId }

const cleanNickname = (name) =>
  String(name || "")
    .trim()
    .slice(0, 24) || "Player";

const nicknameTaken = (nickname) => {
  const lowered = nickname.toLowerCase();
  for (const player of players.values()) {
    if (player.nickname.toLowerCase() === lowered) return true;
  }
  return false;
};

const buildAnswerCounts = () => {
  const counts = question.options.map(() => 0);
  answers.forEach(({ answerIndex }) => {
    if (typeof counts[answerIndex] === "number") counts[answerIndex] += 1;
  });
  return counts;
};

const sortedLeaderboard = () =>
  Array.from(players.values()).sort((a, b) => b.score - a.score);

const revealedAnswers = () => {
  if (question.status !== "revealed") return [];
  return Array.from(answers.entries()).map(([playerId, value]) => ({
    playerId,
    nickname: players.get(playerId)?.nickname || "Player",
    answerIndex: value.answerIndex,
    correct: value.correct,
    answeredAt: value.answeredAt,
  }));
};

const buildState = (requestingPlayerId) => ({
  question: {
    id: question.id,
    prompt: question.prompt,
    options: question.options,
    status: question.status,
    correctIndex: question.status === "revealed" ? question.correctIndex : null,
    createdAt: question.createdAt,
    setId: question.setId,
    setName: question.setName,
    setQuestionIndex:
      typeof question.setQuestionIndex === "number" ? question.setQuestionIndex : null,
  },
  leaderboard: sortedLeaderboard(),
  answerCounts:
    question.status === "idle" ? [] : buildAnswerCounts(question.options),
  answers: revealedAnswers(),
  selfAnswer: answers.get(requestingPlayerId) || null,
  playersOnline: connections.size,
  activeSet: activeSet
    ? {
        id: activeSet.id,
        name: activeSet.name,
        index: activeSet.index,
        total: activeSet.total,
      }
    : null,
});

const sendEvent = (connection, event, payload) => {
  try {
    connection.res.write(`event: ${event}\n`);
    connection.res.write(`data: ${JSON.stringify(payload)}\n\n`);
  } catch (error) {
    console.error("Failed to write SSE event", error);
  }
};

const broadcastState = () => {
  connections.forEach((connection) => {
    sendEvent(connection, "state", buildState(connection.playerId));
  });
};

const loadQuestionSets = () => {
  if (!existsSync(SETS_DIR)) return new Map();
  const found = new Map();
  const files = readdirSync(SETS_DIR).filter((f) => f.endsWith(".json"));
  files.forEach((file) => {
    const fullPath = path.join(SETS_DIR, file);
    try {
      const parsed = JSON.parse(readFileSync(fullPath, "utf-8"));
      const id = parsed.id || path.basename(file, ".json");
      if (!Array.isArray(parsed?.questions) || parsed.questions.length === 0) {
        console.warn(`Skipping set ${file}: no questions`);
        return;
      }
      const name = parsed.name || id;
      const questions = parsed.questions
        .map((q, idx) => {
          const prompt = String(q?.prompt || "").trim();
          const options = Array.isArray(q?.options)
            ? q.options.map((o) => String(o || "").trim()).filter(Boolean)
            : [];
          const correctIndex = Number.parseInt(q?.correctIndex, 10);
          if (!prompt || options.length < 2) {
            console.warn(`Skipping invalid question ${idx} in ${file}`);
            return null;
          }
          if (
            Number.isNaN(correctIndex) ||
            correctIndex < 0 ||
            correctIndex >= options.length
          ) {
            console.warn(`Skipping invalid correctIndex for ${id} question ${idx}`);
            return null;
          }
          return { prompt, options: options.slice(0, 6), correctIndex };
        })
        .filter(Boolean);
      if (questions.length === 0) {
        console.warn(`Skipping set ${file}: no valid questions`);
        return;
      }
      found.set(id, { id, name, questions });
    } catch (error) {
      console.error(`Failed to read set ${file}`, error);
    }
  });
  return found;
};

questionSets = loadQuestionSets();
console.log(`Loaded ${questionSets.size} question set(s)`);

const clearQuestionState = () => {
  question = {
    id: null,
    prompt: "",
    options: [],
    status: "idle",
    correctIndex: null,
    createdAt: null,
    setId: null,
    setName: null,
    setQuestionIndex: null,
  };
  answers = new Map();
  activeSetAnswerIndex = null;
};

const revealWithIndex = (correctIndex) => {
  question = { ...question, status: "revealed", correctIndex };
  answers.forEach((entry, playerId) => {
    const isCorrect = entry.answerIndex === correctIndex;
    if (isCorrect) {
      const player = players.get(playerId);
      if (player) {
        player.score += QUESTION_POINTS;
        players.set(playerId, player);
      }
    }
    answers.set(playerId, { ...entry, correct: isCorrect });
  });
  activeSetAnswerIndex = null;
  broadcastState();
};

app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/state", (req, res) => {
  const playerId = req.query.playerId;
  res.json(buildState(playerId));
});

app.get("/events", (req, res) => {
  const playerId = req.query.playerId;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  const connection = { res, playerId };
  connections.add(connection);
  sendEvent(connection, "state", buildState(playerId));
  req.on("close", () => {
    connections.delete(connection);
  });
});

app.post("/join", (req, res) => {
  const nickname = cleanNickname(req.body?.nickname);
  if (nicknameTaken(nickname)) {
    return res.status(409).json({ message: "Nickname already taken. Pick another." });
  }
  const id = randomUUID();
  players.set(id, { id, nickname, score: 0 });
  res.status(201).json({ playerId: id, nickname, state: buildState(id) });
  broadcastState();
});

app.post("/question", (req, res) => {
  const prompt = String(req.body?.prompt || "").trim();
  const rawOptions = Array.isArray(req.body?.options)
    ? req.body.options
    : [];
  const options = rawOptions.map((opt) => String(opt || "").trim()).filter(Boolean);
  if (!prompt || options.length < 2) {
    return res
      .status(400)
      .json({ message: "Question and at least two options are required." });
  }

  question = {
    id: randomUUID(),
    prompt,
    options: options.slice(0, 6),
    status: "active",
    correctIndex: null,
    createdAt: Date.now(),
    setId: null,
    setName: null,
    setQuestionIndex: null,
  };
  answers = new Map();
  broadcastState();
  res.status(201).json({ questionId: question.id });
});

app.get("/sets", (_req, res) => {
  const sets = Array.from(questionSets.values()).map((set) => ({
    id: set.id,
    name: set.name,
    total: set.questions.length,
    questions: set.questions.map((q) => ({
      prompt: q.prompt,
      options: q.options,
    })),
  }));
  res.json({ sets });
});

app.post("/sets/start", (req, res) => {
  const setId = String(req.body?.setId || "").trim();
  const set = questionSets.get(setId);
  if (!set) {
    return res.status(404).json({ message: "Question set not found." });
  }
  activeSet = { id: set.id, name: set.name, index: -1, total: set.questions.length };
  clearQuestionState();
  broadcastState();
  res.json({ activeSet });
});

app.post("/sets/next", (_req, res) => {
  if (!activeSet) {
    return res.status(409).json({ message: "No active set. Start one first." });
  }
  if (question.status === "active") {
    return res.status(409).json({ message: "Current question still live." });
  }
  const set = questionSets.get(activeSet.id);
  if (!set) {
    return res.status(410).json({ message: "Active set data missing." });
  }
  const nextIndex = activeSet.index + 1;
  if (nextIndex >= set.questions.length) {
    return res.status(404).json({ message: "No more questions in set." });
  }

  const setQuestion = set.questions[nextIndex];
  question = {
    id: randomUUID(),
    prompt: setQuestion.prompt,
    options: setQuestion.options,
    status: "active",
    correctIndex: null,
    createdAt: Date.now(),
    setId: set.id,
    setName: set.name,
    setQuestionIndex: nextIndex,
  };
  activeSet = { ...activeSet, index: nextIndex };
  answers = new Map();
  activeSetAnswerIndex = setQuestion.correctIndex;
  broadcastState();
  res.status(201).json({
    questionId: question.id,
    setId: set.id,
    index: nextIndex,
    remaining: set.questions.length - nextIndex - 1,
  });
});

app.post("/answer", (req, res) => {
  const { playerId, answerIndex, nickname } = req.body || {};
  if (!playerId || typeof playerId !== "string") {
    return res.status(400).json({ message: "Player ID is required." });
  }
  if (!players.has(playerId)) {
    const newNickname = cleanNickname(nickname) || "Player";
    players.set(playerId, { id: playerId, nickname: newNickname, score: 0 });
  }
  if (question.status !== "active") {
    return res.status(409).json({ message: "No active question." });
  }
  const parsedIndex = Number.parseInt(answerIndex, 10);
  if (
    Number.isNaN(parsedIndex) ||
    parsedIndex < 0 ||
    parsedIndex >= question.options.length
  ) {
    return res.status(400).json({ message: "Invalid answer option." });
  }
  if (answers.has(playerId)) {
    return res.json({ received: true, duplicate: true });
  }

  answers.set(playerId, {
    answerIndex: parsedIndex,
    answeredAt: Date.now(),
    correct: false,
  });
  broadcastState();
  res.json({ received: true });
});

app.post("/reveal", (req, res) => {
  if (question.status !== "active") {
    return res.status(409).json({ message: "No active question to reveal." });
  }
  const correctIndex = Number.parseInt(req.body?.correctIndex, 10);
  if (
    Number.isNaN(correctIndex) ||
    correctIndex < 0 ||
    correctIndex >= question.options.length
  ) {
    return res.status(400).json({ message: "Invalid correct option index." });
  }

  revealWithIndex(correctIndex);
  res.json({ revealed: true, correctIndex });
});

app.post("/sets/reveal", (_req, res) => {
  if (question.status !== "active") {
    return res.status(409).json({ message: "No active question to reveal." });
  }
  if (!activeSet || question.setId !== activeSet.id) {
    return res
      .status(409)
      .json({ message: "Current question is not from the active set." });
  }
  if (
    activeSetAnswerIndex === null ||
    activeSetAnswerIndex < 0 ||
    activeSetAnswerIndex >= question.options.length
  ) {
    return res.status(400).json({ message: "No stored correct answer for this set question." });
  }
  revealWithIndex(activeSetAnswerIndex);
  res.json({ revealed: true, correctIndex: activeSetAnswerIndex });
});

app.post("/reset", (_req, res) => {
  clearQuestionState();
  activeSet = null;
  players.forEach((player, id) => {
    players.set(id, { ...player, score: 0 });
  });
  broadcastState();
  res.json({ cleared: true });
});

app.listen(PORT, () => {
  console.log(`Quiz server ready on http://localhost:${PORT}`);
});
