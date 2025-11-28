# Millionaire-Style Quiz

Live multiplayer quiz inspired by the TV show. Includes host/player/display views, question sets, SSE updates, and an Express API.

## Prerequisites
- Node.js 18+
- npm

## Quick start (dev)
1. Backend:  
   ```bash
   cd server
   npm install
   npm start   # or npm run dev with nodemon
   ```
2. Frontend:  
   ```bash
   cd client
   npm install
   npm run dev
   ```
3. Open: player `/`, host `/host`, display `/display` (default ports: server 4000, Vite 5173 with `/api` proxy).

## Production build (single host/port)
1. Build client:
   ```bash
   cd client
   npm install
   npm run build   # outputs client/dist
   ```
2. Start server (serves API and static UI from dist):
   ```bash
   cd server
   npm install
   npm start
   ```
3. Open `http://localhost:4000` (use `/host` or `/display` for those views).

## Background run with logging
```bash
cd server
nohup npm start > server.log 2>&1 &
```
Stop: `pgrep -f "node .*server/index.js" | xargs kill`

## API overview
- `POST /join` { nickname } → { playerId, nickname, state }
- `GET /state?playerId=` → game state
- `GET /events?playerId=` → SSE stream of state
- `POST /question` { prompt, options[] } → start custom question (host)
- `POST /answer` { playerId, nickname, answerIndex }
- `POST /reveal` { correctIndex }
- `POST /reset` → clear scores/state
- Sets: `GET /sets`, `POST /sets/start`, `POST /sets/next`, `POST /sets/reveal`

## Question sets
JSON files in `server/question_sets/*.json`:
```json
{
  "id": "my-set",
  "name": "My Set",
  "questions": [
    { "prompt": "Question?", "options": ["A","B","C","D"], "correctIndex": 1 }
  ]
}
```
Loaded automatically on server start; pick and run from host view.

## Views
- Player: answer questions, see leaderboard (`/`)
- Host: load sets, send next/reveal, restart, open display (`/host`)
- Display: read-only current question + leaderboard (`/display`)

## Notes
- Nicknames must be unique; joining with a taken nickname returns 409.
- If API is hosted elsewhere, set `VITE_API_URL` before building the client.
