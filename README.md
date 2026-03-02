# 🧠 Mental Health Support Chatbot

A compassionate, context-aware mental health support chatbot powered by **Claude AI** (Sage). Built in Node.js with full conversation history and streaming responses.

---

## Features

- **Persistent conversation history** — picks up where you left off across sessions (saved to `chat_history.json`)
- **Streaming responses** — Sage's replies appear word-by-word for a natural feel
- **Empathetic system prompt** — Sage is trained to listen, validate, and gently guide without judging
- **Crisis awareness** — automatically surfaces emergency resources when needed
- **Simple CLI commands** — `new`, `history`, `quit`

---

## Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Set your API key
```bash
export ANTHROPIC_API_KEY=your_api_key_here
```
Get a key at https://console.anthropic.com

### 3. Run the chatbot
```bash
npm start
```

---

## Commands

| Command   | Description                            |
|-----------|----------------------------------------|
| `new`     | Clear history and start a fresh conversation |
| `history` | Show how many turns are stored in memory |
| `quit` / `exit` | Save history and exit          |

---

## How Context Is Maintained

Every message (both user and assistant) is stored in a `messages` array and sent with **every API call**. This gives Claude the full conversation context so Sage can:

- Refer back to things mentioned earlier
- Track emotional themes across the session
- Avoid repeating advice already given

History is trimmed to the last **40 turns** (80 messages) to stay within token limits, and persisted to `chat_history.json` so sessions survive restarts.

---

## Architecture

```
chatbot.js
├── loadHistory()       — reads chat_history.json on startup
├── saveHistory()       — writes after every turn
├── trimHistory()       — enforces 40-turn window
├── openingGreeting()   — warm first message (skipped on resume)
├── chat()              — sends messages[], streams response, appends to history
└── main()              — CLI loop with readline
```

---

## ⚠️ Important Disclaimer

This chatbot is **not a substitute for professional mental health care**. If you or someone you know is in crisis, please contact:

- **988 Suicide & Crisis Lifeline** — call or text **988** (US)
- **Crisis Text Line** — text HOME to **741741** (US)
- **Emergency services** — **911** (US) or your local equivalent
