import cors from "cors";
import express from "express";
import { randomUUID } from "crypto";
import { existsSync, readdirSync, readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createClient } from "redis";

const app = express();
const PORT = process.env.PORT || 4000;
const QUESTION_POINTS = Number(process.env.QUESTION_POINTS || 10);
//const STORE_BACKEND = (process.env.STORE_BACKEND || "memory").toLowerCase();
const STORE_BACKEND = (process.env.STORE_BACKEND || "redis").toLowerCase();
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SETS_DIR = path.join(__dirname, "question_sets");
const DIST_DIR = path.join(__dirname, "..", "client", "dist");

app.use(cors());
app.use(express.json());
// Allow both "/api/..." and bare paths to hit the same handlers in production.
app.use((req, _res, next) => {
  if (req.url.startsWith("/api/")) {
    req.url = req.url.replace(/^\/api/, "");
  }
  next();
});

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
let redisClient = null;

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

const nicknameTakenBySamePlayer = (nickname, playerId) => {
  if (!playerId) return false;
  const player = players.get(playerId);
  if (!player) return false;
  return player.nickname.toLowerCase() === nickname.toLowerCase();
};

const generateNickname = (first) => {
  const suffixes = [
    "Slayer",
    "Rider",
    "Blade",
    "Hunter",
    "Ghost",
    "Shadow",
    "Strike",
    "Storm",
    "Nova",
    "Vortex",
    "Fury",
    "Drift",
    "Rogue",
    "Phantom",
    "Wolf",
    "Dragon",
    "Reaper",
    "Flash",
    "Venom",
    "Spike",
    "Burst",
  ];

  const modifiers = ["", "X", "Pro", "Ultra", "Neo", "Dark", "Night", "Zero", "Alpha", "Omega"];
  const numbers = ["", "07", "13", "99", "404", "777", "1337"];

  const suf = suffixes[Math.floor(Math.random() * suffixes.length)];
  const mod = modifiers[Math.floor(Math.random() * modifiers.length)];
  const num = numbers[Math.floor(Math.random() * numbers.length)];

  return first + mod + suf + num;
};

const stateKey = "quiz:state:v1";

const snapshotState = () => ({
  players: Array.from(players.values()),
  question,
  answers: Array.from(answers.entries()).map(([playerId, value]) => ({
    playerId,
    ...value,
  })),
  activeSet,
  activeSetAnswerIndex,
});

const hydrateState = (data) => {
  if (!data) return;
  players.clear();
  (data.players || []).forEach((p) => {
    if (p?.id) players.set(p.id, p);
  });
  question = {
    id: data.question?.id || null,
    prompt: data.question?.prompt || "",
    options: data.question?.options || [],
    status: data.question?.status || "idle",
    correctIndex:
      data.question?.status === "revealed" ? data.question?.correctIndex : null,
    createdAt: data.question?.createdAt || null,
    setId: data.question?.setId || null,
    setName: data.question?.setName || null,
    setQuestionIndex:
      typeof data.question?.setQuestionIndex === "number"
        ? data.question.setQuestionIndex
        : null,
  };
  answers = new Map();
  (data.answers || []).forEach((a) => {
    if (a?.playerId && typeof a.answerIndex === "number") {
      answers.set(a.playerId, {
        answerIndex: a.answerIndex,
        answeredAt: a.answeredAt || null,
        correct: Boolean(a.correct),
      });
    }
  });
  activeSet = data.activeSet || null;
  activeSetAnswerIndex =
    typeof data.activeSetAnswerIndex === "number"
      ? data.activeSetAnswerIndex
      : null;
};

const persistState = async () => {
  if (STORE_BACKEND !== "redis" || !redisClient) return;
  try {
    await redisClient.set(stateKey, JSON.stringify(snapshotState()));
  } catch (error) {
    console.error("Failed to persist state to Redis", error);
  }
};

const loadState = async () => {
  if (STORE_BACKEND !== "redis" || !redisClient) return;
  try {
    const raw = await redisClient.get(stateKey);
    if (raw) {
      hydrateState(JSON.parse(raw));
      console.log("State loaded from Redis");
    }
  } catch (error) {
    console.error("Failed to load state from Redis", error);
  }
};

const buildAnswerCounts = () => {
  const counts = question.options.map(() => 0);
  answers.forEach(({ answerIndex }) => {
    if (typeof counts[answerIndex] === "number") counts[answerIndex] += 1;
  });
  return counts;
};

const sortedLeaderboard = () =>
  Array.from(players.values())
    .filter((player) => player.score > 0)
    .sort((a, b) => b.score - a.score);

const countZeroScorePlayers = () => {
  let count = 0;
  players.forEach((player) => {
    if (player.score === 0) count += 1;
  });
  return count;
};

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

const disconnectPlayer = (playerId) => {
  if (!playerId) return false;
  let hadConnection = false;
  connections.forEach((connection) => {
    if (connection.playerId === playerId) {
      hadConnection = true;
      try {
        connection.res.end();
      } catch {
        // ignore
      }
      connections.delete(connection);
    }
  });
  return hadConnection;
};

const getOnlinePlayersCount = () => {
  const online = new Set();
  connections.forEach((connection) => {
    if (connection.playerId && players.has(connection.playerId)) {
      online.add(connection.playerId);
    }
  });
  return online.size;
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
  zeroScorePlayers: countZeroScorePlayers(),
  answerCounts:
    question.status === "idle" ? [] : buildAnswerCounts(question.options),
  answers: revealedAnswers(),
  selfAnswer: answers.get(requestingPlayerId) || null,
  playersOnline: getOnlinePlayersCount(),
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
  persistState().finally(broadcastState);
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
  if (playerId && players.has(playerId)) {
    broadcastState();
  }
  req.on("close", () => {
    connections.delete(connection);
    if (playerId && players.has(playerId)) {
      broadcastState();
    }
  });
});

app.post("/join", async (req, res) => {
  const nickname = cleanNickname(req.body?.nickname);
  const providedPlayerId = String(req.body?.playerId || "").trim();

  const isClaimingOwnName = nicknameTakenBySamePlayer(nickname, providedPlayerId);
  if (nicknameTaken(nickname) && !isClaimingOwnName) {
    const suggestions = [];
    while (suggestions.length < 5) {
      const candidate = generateNickname(nickname);
      if (!nicknameTaken(candidate) && !suggestions.includes(candidate)) {
        suggestions.push(candidate);
      }
    }
    return res
      .status(409)
      .json({ message: "Nickname already taken. Pick one of these.", suggestions });
  }
  const existingPlayer = providedPlayerId ? players.get(providedPlayerId) : null;
  const id = existingPlayer ? existingPlayer.id : providedPlayerId || randomUUID();
  players.set(id, { id, nickname, score: existingPlayer?.score || 0 });
  await persistState();
  res.status(201).json({ playerId: id, nickname, state: buildState(id) });
  broadcastState();
});

app.post("/question", async (req, res) => {
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
  await persistState();
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

app.post("/sets/start", async (req, res) => {
  const setId = String(req.body?.setId || "").trim();
  const set = questionSets.get(setId);
  if (!set) {
    return res.status(404).json({ message: "Question set not found." });
  }
  activeSet = { id: set.id, name: set.name, index: -1, total: set.questions.length };
  clearQuestionState();
  await persistState();
  broadcastState();
  res.json({ activeSet });
});

app.post("/sets/next", async (_req, res) => {
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
  await persistState();
  broadcastState();
  res.status(201).json({
    questionId: question.id,
    setId: set.id,
    index: nextIndex,
    remaining: set.questions.length - nextIndex - 1,
  });
});

app.post("/answer", async (req, res) => {
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
  await persistState();
  broadcastState();
  res.json({ received: true });
});

app.post("/reveal", async (req, res) => {
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
  await persistState();
  res.json({ revealed: true, correctIndex });
});

app.post("/leave", async (req, res) => {
  const playerId = String(req.body?.playerId || "").trim();
  if (!playerId) {
    return res.status(400).json({ message: "Player ID is required." });
  }
  const removed = disconnectPlayer(playerId);
  await persistState();
  broadcastState();
  res.json({ removed });
});

app.post("/sets/reveal", async (_req, res) => {
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
  await persistState();
  res.json({ revealed: true, correctIndex: activeSetAnswerIndex });
});

app.post("/reset", async (_req, res) => {
  clearQuestionState();
  activeSet = null;
  players.forEach((player, id) => {
    players.set(id, { ...player, score: 0 });
  });
  await persistState();
  broadcastState();
  res.json({ cleared: true });
});

if (existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR));
  app.get("*", (req, res, next) => {
    if (req.originalUrl.startsWith("/api")) return next();
    res.sendFile(path.join(DIST_DIR, "index.html"));
  });
}

app.listen(PORT, () => {
  console.log(`Quiz server ready on http://localhost:${PORT}`);
});

const bootstrap = async () => {
  if (STORE_BACKEND === "redis") {
    try {
      redisClient = createClient({ url: REDIS_URL });
      redisClient.on("error", (err) => console.error("Redis error", err));
      await redisClient.connect();
      await loadState();
      console.log("Redis store enabled");
    } catch (error) {
      console.error("Failed to init Redis, falling back to memory", error);
      redisClient = null;
    }
  }
};

bootstrap();
