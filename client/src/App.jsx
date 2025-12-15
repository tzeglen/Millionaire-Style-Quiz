import { useEffect, useMemo, useState } from "react";
import displayBg from "./images/oracle-redbull.png";

const API_BASE = import.meta.env.VITE_API_URL || "/api";

const createBlankQuestion = () => ({
  prompt: "",
  options: ["", "", "", ""],
});

const fetchJson = async (url, options) => {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data?.message || "Request failed");
    error.data = data;
    throw error;
  }
  return data;
};

function App() {
  const isHost =
    typeof window !== "undefined" && window.location.pathname.startsWith("/host");
  const isDisplay =
    typeof window !== "undefined" && window.location.pathname.startsWith("/display");
  const [nickname, setNickname] = useState(
    localStorage.getItem("quiz_nickname") || ""
  );
  const [playerId, setPlayerId] = useState(
    localStorage.getItem("quiz_player_id") || ""
  );
  const [state, setState] = useState(null);
  const [questionForm, setQuestionForm] = useState(createBlankQuestion);
  const [revealIndex, setRevealIndex] = useState(0);
  const [status, setStatus] = useState("");
  const [nicknameSuggestions, setNicknameSuggestions] = useState([]);
  const [connectionState, setConnectionState] = useState("connecting");
  const [sets, setSets] = useState([]);
  const [selectedSetId, setSelectedSetId] = useState("");
  const selectedSet = useMemo(
    () => sets.find((s) => s.id === selectedSetId) || sets[0],
    [sets, selectedSetId]
  );
  const [confirmRestart, setConfirmRestart] = useState(false);

  const hasJoined = Boolean(playerId);
  const currentQuestion = state?.question;
  const myAnswerIndex = state?.selfAnswer?.answerIndex;
  const alreadyAnswered = typeof myAnswerIndex === "number";
  const isRevealed = currentQuestion?.status === "revealed";
  const canAnswer =
    !isHost && !isDisplay && currentQuestion?.status === "active" && !alreadyAnswered;
  const answersTotal = useMemo(
    () => (state?.answerCounts || []).reduce((a, b) => a + b, 0),
    [state?.answerCounts]
  );

  const sortedLeaderboard = useMemo(
    () => state?.leaderboard || [],
    [state?.leaderboard]
  );
  const activeSet = state?.activeSet;
  const activeSetLabel = activeSet
    ? `Set: ${activeSet.name} (${activeSet.index + 1 || 0}/${activeSet.total})`
    : "No set selected";

  useEffect(() => {
    const controller = new AbortController();
    const loadState = async () => {
      try {
        const data = await fetchJson(
          `${API_BASE}/state${
            playerId ? `?playerId=${encodeURIComponent(playerId)}` : ""
          }`,
          { signal: controller.signal }
        );
        setState(data);
        setConnectionState("connected");
      } catch {
        setConnectionState("disconnected");
      }
    };
    loadState();
    return () => controller.abort();
  }, [playerId]);

  useEffect(() => {
    const source = new EventSource(
      `${API_BASE}/events${playerId ? `?playerId=${playerId}` : ""}`
    );
    source.onopen = () => setConnectionState("connected");
    source.onerror = () => setConnectionState("disconnected");
    source.addEventListener("state", (event) => {
      try {
        const data = JSON.parse(event.data);
        setState(data);
      } catch {
        // ignore parsing errors
      }
    });
    return () => source.close();
  }, [playerId]);

  useEffect(() => {
    if (!isHost) return;
    const loadSets = async () => {
      try {
        const data = await fetchJson(`${API_BASE}/sets`);
        setSets(data.sets || []);
        if (!selectedSetId && data.sets?.length) {
          setSelectedSetId(data.sets[0].id);
        }
      } catch (error) {
        setStatus(error.message);
      }
    };
    loadSets();
  }, [isHost]);

  const joinGame = async (nicknameOverride) => {
    const nameToUse = (nicknameOverride ?? nickname).trim();
    if (!nameToUse) return;
    try {
      setStatus("Joining...");
      setNicknameSuggestions([]);
      const storedId = localStorage.getItem("quiz_player_id") || playerId || "";
      const data = await fetchJson(`${API_BASE}/join`, {
        method: "POST",
        body: JSON.stringify({ nickname: nameToUse, playerId: storedId }),
      });
      setNickname(nameToUse);
      setPlayerId(data.playerId);
      localStorage.setItem("quiz_player_id", data.playerId);
      localStorage.setItem("quiz_nickname", data.nickname);
      setStatus("Ready to play!");
    } catch (error) {
      if (error.data?.suggestions?.length) {
        setNicknameSuggestions(error.data.suggestions);
        setStatus(error.message || "Nickname taken. Choose another.");
      } else {
        setStatus(error.message);
      }
    }
  };

  const submitQuestion = async () => {
    try {
      const trimmedOptions = questionForm.options
        .map((opt) => opt.trim())
        .filter(Boolean);
      await fetchJson(`${API_BASE}/question`, {
        method: "POST",
        body: JSON.stringify({ prompt: questionForm.prompt.trim(), options: trimmedOptions }),
      });
      setQuestionForm(createBlankQuestion());
      setRevealIndex(0);
      setStatus("Question sent");
    } catch (error) {
      setStatus(error.message);
    }
  };

  const startSet = async () => {
    try {
      await fetchJson(`${API_BASE}/sets/start`, {
        method: "POST",
        body: JSON.stringify({ setId: selectedSetId }),
      });
      setStatus("Set loaded. Use Next to push a question.");
    } catch (error) {
      setStatus(error.message);
    }
  };

  const nextFromSet = async () => {
    try {
      await fetchJson(`${API_BASE}/sets/next`, { method: "POST" });
      setStatus("Set question sent");
    } catch (error) {
      setStatus(error.message);
    }
  };

  const revealFromSet = async () => {
    try {
      await fetchJson(`${API_BASE}/sets/reveal`, { method: "POST" });
      setStatus("Answer revealed");
    } catch (error) {
      setStatus(error.message);
    }
  };

  const restartGame = async () => {
    try {
      await fetchJson(`${API_BASE}/reset`, { method: "POST" });
      setStatus("Game restarted");
      setConfirmRestart(false);
    } catch (error) {
      setStatus(error.message);
      setConfirmRestart(false);
    }
  };

  const revealAnswer = async () => {
    try {
      await fetchJson(`${API_BASE}/reveal`, {
        method: "POST",
        body: JSON.stringify({ correctIndex: revealIndex }),
      });
      setStatus("Answer revealed");
    } catch (error) {
      setStatus(error.message);
    }
  };

  const submitAnswer = async (answerIndex) => {
    try {
      await fetchJson(`${API_BASE}/answer`, {
        method: "POST",
        body: JSON.stringify({ playerId, answerIndex, nickname }),
      });
      setStatus("Locked in");
    } catch (error) {
      setStatus(error.message);
    }
  };

  const leaveLobby = async () => {
    try {
      await fetchJson(`${API_BASE}/leave`, {
        method: "POST",
        body: JSON.stringify({ playerId }),
      });
      setStatus("You left the lobby");
    } catch (error) {
      setStatus(error.message);
    } finally {
      setPlayerId("");
      setNickname("");
      setNicknameSuggestions([]);
    }
  };

  const answeredLabel = () => {
    if (!alreadyAnswered) return "";
    if (!isRevealed) return "Locked";
    return state?.selfAnswer?.correct ? "Correct" : "Wrong";
  };

  const openDisplay = () => {
    window.open("/display", "quiz-display", "noopener");
  };

  if (isDisplay) {
    const displayBackground = `url(${displayBg})`;
    return (
      <div
        className="page display-page"
        style={{ backgroundImage: displayBackground }}
      >
        <header className="hero">
          <div>
            <p className="eyebrow">Live Trivia Lobby</p>
            <h1>Audience Display</h1>
            <p className="subhead">Current question and leaderboard only.</p>
            <div className="tags">
              <span className="pill">Display view</span>
              <span className="pill quiet">
                {connectionState === "connected" ? "Connected" : "Offline"}
              </span>
              <span className="pill quiet">{state?.playersOnline || 0} online</span>
            </div>
          </div>
        </header>
        <section className="grid">
          <div className="card accent">
            <div className="card-header">
              <h2>Current question</h2>
              <span className="badge">
                {currentQuestion?.status === "active"
                  ? "Live"
                  : currentQuestion?.status === "revealed"
                    ? "Revealed"
                    : "Idle"}
              </span>
            </div>
            {currentQuestion?.prompt ? (
              <>
                <p className="question-text">{currentQuestion.prompt}</p>
                <div className="options">
                  {currentQuestion.options.map((option, index) => {
                    const isCorrect =
                      isRevealed && currentQuestion.correctIndex === index;
                    return (
                      <div
                        key={option + index}
                        className={`option ${isCorrect ? "correct" : ""}`}
                      >
                        <span className="option-index">
                          {String.fromCharCode(65 + index)}
                        </span>
                        <span>{option}</span>
                        {isRevealed && state?.answerCounts?.length ? (
                          <span className="pill quiet">
                            {state.answerCounts[index] || 0} votes
                          </span>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
                <div className="meta">
                  <span>Answers: {answersTotal}</span>
                </div>
              </>
            ) : (
              <p className="muted">Waiting for the host to send the next question.</p>
            )}
          </div>

          <div className="card">
            <div className="card-header">
              <h2>Leaderboard</h2>
              <span className="badge">Top players</span>
            </div>
            <p className="muted small">
              Players at 0 pts: {state?.zeroScorePlayers || 0}
            </p>
            <div className="leaderboard">
              {sortedLeaderboard.length === 0 && (
                <p className="muted">No players yet. Join to claim the top spot.</p>
              )}
              {sortedLeaderboard.map((player, idx) => (
                <div key={player.id} className="leader">
                  <div>
                    <span className="rank">#{idx + 1}</span>
                    <strong>{player.nickname}</strong>
                  </div>
                  <span className="score">{player.score} pts</span>
                </div>
              ))}
            </div>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="hero">
        <div>
          <p className="eyebrow">Live Trivia Lobby</p>
          <h1>Millionaire-Style Quiz</h1>
          <p className="subhead">
            Host questions, join with a nickname, answer fast, and climb the leaderboard.
          </p>
          <div className="tags">
            <span className="pill">{isHost ? "Host view" : "Player view"}</span>
            <span className="pill quiet">
              {connectionState === "connected" ? "Connected" : "Offline"}
            </span>
            <span className="pill quiet">{state?.playersOnline || 0} online</span>
          </div>
          {isHost && (
            <div className="actions" style={{ marginTop: "0.5rem" }}>
              <button className="secondary" onClick={openDisplay}>
                Open display screen
              </button>
            </div>
          )}
        </div>
      </header>

      <section className="grid">
        <div className="card">
          <div className="card-header">
            <h2>
              {isHost
                ? "Host identity (optional)"
                : hasJoined
                  ? `Welcome, ${nickname || "Player"}`
                  : "Join the game"}
            </h2>
            <span className="badge">Step 1</span>
          </div>
          <div className="stack">
            <label className="field">
              <span>Nickname</span>
              <input
                value={nickname}
                onChange={(e) => setNickname(e.target.value)}
                placeholder="Enter a fun handle"
                disabled={hasJoined}
              />
            </label>
            {nicknameSuggestions.length > 0 && !hasJoined && (
              <>
                <p className="muted small">That name is taken. Try one of these:</p>
                <div className="actions">
                  {nicknameSuggestions.map((option) => (
                    <button
                      key={option}
                      className="secondary"
                      onClick={() => joinGame(option)}
                      type="button"
                    >
                      {option}
                    </button>
                  ))}
                </div>
              </>
            )}
            {!hasJoined && (
              <button className="primary" onClick={() => joinGame()} disabled={!nickname.trim()}>
                Join Lobby
              </button>
            )}
            {hasJoined && (
              <>
                <p className="muted">
                  Player ID saved locally — {isHost ? "you can host and answer" : "you can start answering"}.
                </p>
                <div className="actions">
                  <button className="secondary danger" onClick={leaveLobby}>
                    Leave lobby
                  </button>
                </div>
              </>
            )}
            {status && <p className="status">{status}</p>}
          </div>
        </div>

        {isHost && (
          <div className="card">
            <div className="card-header">
              <h2>Game control</h2>
              <span className="badge">{activeSetLabel}</span>
            </div>
            <div className="stack">
              <div className="actions">
                <button
                  className="primary"
                  onClick={nextFromSet}
                  disabled={!activeSet || currentQuestion?.status === "active"}
                >
                  Next question
                </button>
                <button
                  className="primary ghost"
                  onClick={revealFromSet}
                  disabled={!activeSet || currentQuestion?.status !== "active"}
                >
                  Reveal answer
                </button>
                {!confirmRestart ? (
                  <button className="secondary danger" onClick={() => setConfirmRestart(true)}>
                    Restart game
                  </button>
                ) : (
                  <div className="confirm-row">
                    <span className="muted">Restart game?</span>
                    <div className="actions">
                      <button className="secondary danger" onClick={restartGame}>
                        Yes
                      </button>
                      <button className="secondary" onClick={() => setConfirmRestart(false)}>
                        No
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        <div className="card accent">
          <div className="card-header">
            <h2>Current question</h2>
            <span className="badge">
              {currentQuestion?.status === "active"
                ? "Live"
                : currentQuestion?.status === "revealed"
                  ? "Revealed"
                  : "Idle"}
            </span>
          </div>
          {currentQuestion?.prompt ? (
            <>
              <p className="question-text">{currentQuestion.prompt}</p>
              <div className="options">
                {currentQuestion.options.map((option, index) => {
                  const isMine = myAnswerIndex === index;
                  const isCorrect =
                    isRevealed && currentQuestion.correctIndex === index;
                  return (
                    <button
                      key={option + index}
                      className={`option ${
                        isCorrect ? "correct" : ""
                      } ${isMine ? "mine" : ""}`}
                      onClick={() => canAnswer && submitAnswer(index)}
                      disabled={!canAnswer}
                    >
                      <span className="option-index">{String.fromCharCode(65 + index)}</span>
                      <span>{option}</span>
                    </button>
                  );
                })}
              </div>
              <div className="meta">
                <span>Answers: {state?.answerCounts?.reduce((a, b) => a + b, 0) || 0}</span>
                {currentQuestion.setName && (
                  <span className="pill quiet">
                    {currentQuestion.setName} — Q{(currentQuestion.setQuestionIndex || 0) + 1}
                  </span>
                )}
                {alreadyAnswered && <span className="pill quiet">{answeredLabel()}</span>}
              </div>
            </>
          ) : (
            <p className="muted">Waiting for the host to send the next question.</p>
          )}
        </div>

        {isHost && (
          <div className="card">
            <div className="card-header">
              <h2>Leaderboard</h2>
              <span className="badge">Top players</span>
            </div>
            <p className="muted small">Players at 0 pts: {state?.zeroScorePlayers || 0}</p>
            <div className="leaderboard">
              {sortedLeaderboard.length === 0 && (
                <p className="muted">No players yet. Join to claim the top spot.</p>
              )}
              {sortedLeaderboard.map((player, idx) => (
                <div
                  key={player.id}
                  className={`leader ${player.id === playerId ? "self" : ""}`}
                >
                  <div>
                    <span className="rank">#{idx + 1}</span>
                    <strong>{player.nickname}</strong>
                  </div>
                  <span className="score">{player.score} pts</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {isHost && (
          <div className="card">
            <div className="card-header">
              <h2>Custom question</h2>
              <span className="badge">Manual</span>
            </div>
            <div className="stack">
              <label className="field">
                <span>Question</span>
                <textarea
                  value={questionForm.prompt}
                  onChange={(e) =>
                    setQuestionForm((prev) => ({ ...prev, prompt: e.target.value }))
                  }
                  placeholder="What is the capital of France?"
                  rows={2}
                />
              </label>
              {questionForm.options.map((opt, idx) => (
                <label key={idx} className="field">
                  <span>Option {idx + 1}</span>
                  <input
                    value={opt}
                    onChange={(e) => {
                      const next = [...questionForm.options];
                      next[idx] = e.target.value;
                      setQuestionForm((prev) => ({ ...prev, options: next }));
                    }}
                    placeholder={`Answer ${idx + 1}`}
                  />
                </label>
              ))}
              <button
                className="secondary"
                onClick={() => setQuestionForm(createBlankQuestion())}
              >
                Clear
              </button>
              <button
                className="primary"
                onClick={submitQuestion}
                disabled={!questionForm.prompt.trim()}
              >
                Send question
              </button>
              {currentQuestion?.options?.length ? (
                <>
                  <label className="field inline">
                    <span>Reveal correct</span>
                    <select
                      value={revealIndex}
                      onChange={(e) => setRevealIndex(Number(e.target.value))}
                    >
                      {currentQuestion.options.map((opt, idx) => (
                        <option key={idx} value={idx}>
                          {String.fromCharCode(65 + idx)} — {opt}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    className="primary ghost"
                    onClick={revealAnswer}
                    disabled={currentQuestion.status !== "active"}
                  >
                    Reveal answer
                  </button>
                </>
              ) : null}
            </div>
          </div>
        )}

        {isHost && (
          <div className="card">
            <div className="card-header">
              <h2>Question sets</h2>
              <span className="badge">{activeSetLabel}</span>
            </div>
            <div className="stack">
              <label className="field inline">
                <span>Select set</span>
                <select
                  value={selectedSetId}
                  onChange={(e) => setSelectedSetId(e.target.value)}
                >
                  {sets.map((set) => (
                    <option key={set.id} value={set.id}>
                      {set.name} ({set.total})
                    </option>
                  ))}
                </select>
              </label>
              <div className="actions">
                <button className="secondary" onClick={startSet} disabled={!selectedSetId}>
                  Load set
                </button>
              </div>
              {selectedSet && (
                <div className="question-list">
                  <p className="muted small">
                    Questions in "{selectedSet.name}" ({selectedSet.total || selectedSet.questions?.length || 0})
                  </p>
                  {selectedSet.questions?.map((q, idx) => {
                    const isCurrent =
                      activeSet?.id === selectedSet.id &&
                      activeSet?.index === idx &&
                      currentQuestion?.status !== "idle";
                    return (
                      <div key={idx} className={`question-chip ${isCurrent ? "current" : ""}`}>
                        <span className="pill quiet">Q{idx + 1}</span>
                        <span className="prompt">{q.prompt}</span>
                      </div>
                    );
                  })}
                </div>
              )}
              {sets.length === 0 && (
                <p className="muted">No sets found on server. Add JSON under server/question_sets.</p>
              )}
            </div>
          </div>
        )}

        {isRevealed && state?.answers?.length ? (
          <div className="card accent">
            <div className="card-header">
              <h2>Answer breakdown</h2>
              <span className="badge">Revealed</span>
            </div>
            <div className="answers">
              {state.answers.map((entry) => (
                <div key={entry.playerId} className="answer-row">
                  <span className={`pill ${entry.correct ? "good" : "bad"}`}>
                    {entry.correct ? "Correct" : "Wrong"}
                  </span>
                  <span className="name">{entry.nickname}</span>
                  <span className="option-label">
                    {String.fromCharCode(65 + entry.answerIndex)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}

export default App;
