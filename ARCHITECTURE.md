# Sage — Architecture Document

> Mental health support chatbot powered by Claude AI, with persistent multi-layer memory across both CLI and web interfaces.

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [File Structure](#2-file-structure)
3. [Component Map](#3-component-map)
4. [Memory Architecture — The 5 Layers](#4-memory-architecture--the-5-layers)
5. [Dual-Store Pattern (Redis + MongoDB)](#5-dual-store-pattern-redis--mongodb)
6. [History Saving — How Data Gets Written](#6-history-saving--how-data-gets-written)
7. [History Retrieval — How Data Gets Read](#7-history-retrieval--how-data-gets-read)
8. [Prompt Engineering & Context Injection](#8-prompt-engineering--context-injection)
9. [Session Management](#9-session-management)
10. [Web API Reference](#10-web-api-reference)
11. [Data Schemas](#11-data-schemas)
12. [Key Design Decisions](#12-key-design-decisions)

---

## 1. System Overview

Sage has two interfaces sharing the same storage and AI backend:

```
┌─────────────────────────────────────────────────────────────┐
│                        Interfaces                           │
│                                                             │
│   CLI (chatbot.js)              Web (server.js + index.html)│
│   readline terminal             Express HTTP + SSE          │
└────────────────┬────────────────────────────┬──────────────┘
                 │                            │
                 ▼                            ▼
┌─────────────────────────────────────────────────────────────┐
│                    Shared Modules                           │
│                                                             │
│         memory.js (Redis)       mongo.js (MongoDB)         │
└────────────────┬────────────────────────────┬──────────────┘
                 │                            │
                 ▼                            ▼
┌───────────────────────┐      ┌──────────────────────────────┐
│  Redis                │      │  MongoDB                     │
│  sage:{userId}:*      │      │  sage_chatbot.users          │
│  (fast session cache) │      │  (durable long-term store)   │
└───────────────────────┘      └──────────────────────────────┘
                 │
                 ▼
┌───────────────────────────────────────────────────────────┐
│               Anthropic Claude API                        │
│           Model: claude-sonnet-4-6                        │
│   Streaming chat + non-streaming profile analysis        │
└───────────────────────────────────────────────────────────┘
```

---

## 2. File Structure

```
chatbot/
├── chatbot.js          CLI interface — readline loop, streaming chat
├── server.js           Web interface — Express + SSE API server
├── memory.js           Redis persistence layer (all 5 memory layers)
├── mongo.js            MongoDB persistence layer (mirrors memory.js)
├── public/
│   └── index.html      Single-page web app (HTML + CSS + JS, no framework)
├── system_prompt.txt   Optional custom system prompt (overrides built-in)
├── package.json
└── ARCHITECTURE.md     (this file)
```

**Key principle**: `chatbot.js` and `server.js` are both consumers of `memory.js` and `mongo.js`. The storage modules have no knowledge of which interface is using them.

---

## 3. Component Map

```
chatbot.js / server.js
│
├── loadSystemPrompt()
│     Loads base system prompt: --prompt-file > system_prompt.txt > built-in default
│
├── buildEnrichedSystemPrompt(memory, basePrompt)
│     Appends user context block to base prompt (profile + episodes + narrative + preferences)
│
├── buildNewUserGreetingPrompt(memory, basePrompt)
│     Extends enriched prompt with instruction to acknowledge challenges in opening
│
├── buildGreetingSystemPrompt(memory, basePrompt)
│     Extends enriched prompt with instruction for contextual returning-user greeting
│
├── runProfileUpdate(userId, messages)
│     Calls Claude (non-streaming) → parses JSON → saves to Redis + MongoDB
│     Triggered every 5 user turns AND on session end (quit/close/SIGINT)
│
├── chat(userId, messages, userInput, systemPrompt)          [CLI only]
│     Streams response → appends to local messages[] → dual-writes to Redis + MongoDB
│
├── openingGreeting(userId, messages, systemPrompt)          [CLI only]
│     Sends greeting using greeting-specific system prompt
│
└── main()                                                   [CLI only]
      startup → username → connect stores → load memory → enrich prompt → greet → loop
```

---

## 4. Memory Architecture — The 5 Layers

Each user has 5 independent memory layers, keyed separately in Redis and stored as fields in one MongoDB document.

### Layer 1 — Short-term Conversation (`short_term`)

Stores the raw message history for the current and recent conversations.

| Property | Value |
|---|---|
| Redis key | `sage:{userId}:short_term` |
| Redis type | List (LPUSH — newest first) |
| MongoDB field | `shortTerm` (array, newest last) |
| Cap | 40 entries (20 user/assistant pairs) |
| Entry format | `{ role: "user" \| "assistant", content: string }` |
| Purpose | Provides Claude with conversational context |

**Why capped at 40:** Beyond ~20 exchanges the oldest messages have diminishing value and would inflate context window cost. The longitudinal narrative (Layer 4) compensates for lost detail.

### Layer 2 — Psychological Profile (`profile`)

A structured JSON object built by Claude analysing conversation patterns. Updated every 5 user turns.

| Property | Value |
|---|---|
| Redis key | `sage:{userId}:profile` |
| Redis type | String (JSON) |
| MongoDB field | `profile` (embedded document) |
| Schema | `{ mood_patterns[], triggers[], coping_strategies[], recurring_themes[], communication_style }` |

This layer allows Sage to be immediately aware of patterns without re-reading full conversation history.

### Layer 3 — Episodic Memory (`episodes`)

A log of significant disclosures — distinct from routine check-ins. Each episode is added by the profile-update analysis.

| Property | Value |
|---|---|
| Redis key | `sage:{userId}:episodes` |
| Redis type | List (LPUSH — newest first) |
| MongoDB field | `episodes` (array, capped at 50) |
| Cap | 50 entries |
| Entry format | `{ date, summary, emotion, context }` |

Episodes give Sage anchors for the returning-user greeting: "Last time you mentioned feeling overwhelmed at work on 2026-01-15…"

### Layer 4 — Longitudinal Narrative (`narrative`)

A 2–3 sentence paragraph, written in third person by Claude, summarising the user's overall emotional journey. Rebuilt on every profile update (not appended — fully replaced).

| Property | Value |
|---|---|
| Redis key | `sage:{userId}:narrative` |
| Redis type | String (plain text) |
| MongoDB field | `narrative` (string) |
| Format | "Alex has been navigating…" (third-person, therapist-briefing tone) |

This is injected verbatim into the system prompt as the "Emotional Journey" section.

### Layer 5 — Preferences (`preferences`)

Explicit user-set preferences stored as a JSON object. Set via the `prefs` command (CLI) or Prefs modal (Web). Persisted immediately on change.

| Property | Value |
|---|---|
| Redis key | `sage:{userId}:preferences` |
| Redis type | String (JSON) |
| MongoDB field | `preferences` (embedded document) |
| Fields | `name`, `pronouns`, `style`, `avoid`, `exercises`, `challenges` |

`challenges` is the only array-valued preference (set during onboarding). All others are strings.

---

## 5. Dual-Store Pattern (Redis + MongoDB)

```
Write path (every message):
  await mem.appendMessage(...)        ← Redis, blocking (session continuity)
  mongo.appendMessage(...)            ← MongoDB, fire-and-forget (durability)

Write path (profile updates):
  await mem.saveProfileUpdate(...)    ← Redis
  await mongo.saveProfileUpdate(...)  ← MongoDB (both awaited — profile must land in both)

Read path (session start):
  memory = await mem.loadAllMemory(userId)
  if (Redis is empty) {
    memory = await mongo.loadAllMemory(userId)   ← fallback
  }
```

**Why two stores?**

| Store | Role | Failure behaviour |
|---|---|---|
| Redis | Fast session cache; low-latency reads; used for every API call | Non-fatal — chatbot runs stateless if Redis is down |
| MongoDB | Durable long-term store; survives Redis restarts/flushes | Non-fatal — Redis has the working copy |

If Redis is flushed (e.g. server restart), MongoDB acts as the recovery source. On the next session start, data is reloaded from MongoDB into Redis automatically via `loadAllMemory`.

---

## 6. History Saving — How Data Gets Written

### 6a. Per-message saving (every turn)

```
User sends message
        │
        ▼
chat() / POST /api/chat
        │
        ├── stream response from Claude API (SSE to client)
        │
        ├── await mem.appendMessage(userId, "user", userInput)
        │     Redis: LPUSH sage:{userId}:short_term '{"role":"user","content":"..."}'
        │           LTRIM sage:{userId}:short_term 0 39    (keep newest 40)
        │
        ├── await mem.appendMessage(userId, "assistant", fullResponse)
        │     Redis: LPUSH + LTRIM (same key)
        │
        ├── mongo.appendMessage(userId, "user", userInput)    ← fire-and-forget
        │     MongoDB: $push { shortTerm: { $each: [...], $slice: -40 } }
        │
        └── mongo.appendMessage(userId, "assistant", fullResponse)   ← fire-and-forget
```

MongoDB writes use `upsert: true` so the user document is created on first message.

### 6b. Profile update (background, every 5 turns + session end)

```
After every 5th user message:
        │
        ▼
triggerProfileUpdate(userId, messages)    ← fire-and-forget at call site
        │
        ▼
runProfileUpdate(userId, messages)        ← runs in background
        │
        ├── Take last 10 messages (last 5 pairs)
        │
        ├── POST to Claude API (non-streaming):
        │     system: PROFILE_UPDATE_SYSTEM_PROMPT
        │     user:   "Today's date: ... Recent conversation: ... Return JSON only."
        │
        ├── Parse response JSON:
        │     { profile{}, new_episodes[], narrative }
        │
        ├── await mem.saveProfileUpdate(userId, data)
        │     Redis:
        │       SET sage:{userId}:profile '{"mood_patterns":[...],...}'
        │       SET sage:{userId}:narrative "Alex has been..."
        │       for each episode: LPUSH sage:{userId}:episodes '{"date":...}'
        │                         LTRIM sage:{userId}:episodes 0 49
        │
        └── await mongo.saveProfileUpdate(userId, data)
              MongoDB: $set { profile, narrative }
                       $push { episodes: { $each: [...], $slice: -50 } }
```

**Session-end flush**: On `quit`, `close`, or `SIGINT`, if any messages were sent in the current session, `runProfileUpdate` is awaited (not fire-and-forget) to guarantee history is saved before exit.

```
sessionMessageCount > 0
        │
        ▼
await runProfileUpdate(userId, messages)   ← blocks until saved
        │
        ▼
disconnect Redis + MongoDB
        │
        ▼
exit
```

### 6c. Preferences saving (immediate on change)

```
User sets a preference:
        │
        ▼
await mem.setPreference(userId, key, value)
        │     Redis: GET preferences → merge → SET preferences (full JSON blob)
        │
mongo.setPreference(userId, key, value)   ← fire-and-forget
        │     MongoDB: $set { "preferences.{key}": value }
        │
Rebuild enrichedSystemPrompt in-memory
(takes effect from next message in same session)
```

---

## 7. History Retrieval — How Data Gets Read

### 7a. Session startup (CLI and Web)

```
User provides name (userId)
        │
        ▼
mem.loadAllMemory(userId)
        │     Redis: Promise.all([
        │       LRANGE short_term 0 -1  → reverse → parse JSON
        │       GET profile             → parse JSON
        │       LRANGE episodes 0 -1   → reverse → parse JSON
        │       GET narrative           → raw string
        │       GET preferences         → parse JSON
        │     ])
        │     Returns: { shortTerm[], profile, episodes[], narrative, preferences }
        │
        ▼
hasRedisData = shortTerm.length > 0 || !!profile || !!narrative
        │
        ├── [Redis has data] → use Redis memory directly
        │
        └── [Redis empty] → mongo.loadAllMemory(userId)
                │     MongoDB: findOne({ _id: userId })
                │     Returns same shape as Redis path
                │
                ▼
               use MongoDB memory as fallback

isReturning = shortTerm.length > 0 || !!profile || !!narrative
```

**Note on Redis list ordering**: Redis lists use LPUSH (newest-first storage). `loadAllMemory` reverses them with `.reverse()` before returning, so the caller always receives chronological order (oldest first) — matching what Claude expects in the `messages` array.

### 7b. System prompt enrichment (session start)

```
memory = { shortTerm, profile, episodes, narrative, preferences }
        │
        ▼
buildEnrichedSystemPrompt(memory, BASE_SYSTEM_PROMPT)
        │
        ├── if no profile, episodes, narrative, or preferences:
        │     return BASE_SYSTEM_PROMPT unchanged (first-ever session)
        │
        └── append USER CONTEXT block:
              ├── Emotional Journey: {narrative}
              ├── Known Profile:
              │     • Mood patterns: ...
              │     • Common triggers: ...
              │     • Coping strategies: ...
              │     • Recurring themes: ...
              │     • Communication style: ...
              ├── Recent Significant Episodes (up to 3):
              │     • {date} — {summary} (felt: {emotion})
              └── User Preferences:
                    • Address them as: ...
                    • Pronouns: ...
                    • Response style: ...
                    • Topics to avoid: ...
                    • Suggest coping exercises: ...
                    • Primary challenges: ...
```

### 7c. Greeting prompt construction

```
isReturning?
        │
        ├── YES → buildGreetingSystemPrompt(memory, BASE_SYSTEM_PROMPT)
        │           enrichedPrompt
        │           + GREETING INSTRUCTION:
        │               • Last significant disclosure: {date} "{summary}" — felt {emotion}
        │               • Their last message: "{snippet}"
        │               • Preferred name: ...
        │               • Response style: ...
        │               • Challenges: ...
        │             "Ask something specific — not a generic check-in."
        │
        └── NO  → buildNewUserGreetingPrompt(memory, BASE_SYSTEM_PROMPT)
                    enrichedPrompt
                    + GREETING INSTRUCTION (if challenges set):
                        "This is a first-time user who shared: {challenges}.
                         Weave into caring opening. End with ONE open-ended question."
```

### 7d. History panel / `history` command

```
GET /api/history/:userId   (Web)
history command            (CLI)
        │
        ▼
mem.loadAllMemory(userId)
        │
        ▼
Return / display:
  ├── Conversation turns (shortTerm.length / 2)
  ├── Profile highlights (mood_patterns, triggers, recurring_themes, communication_style)
  ├── All episodes: date — summary (felt: emotion) + context
  ├── Full narrative paragraph
  └── All preferences (including challenges array)
```

---

## 8. Prompt Engineering & Context Injection

### System prompt hierarchy

```
BASE_SYSTEM_PROMPT          (Sage's core persona and guidelines)
        +
USER CONTEXT block          (injected from memory — invisible to user)
        +
GREETING INSTRUCTION        (only during the opening message)
```

The user context block is explicitly marked as internal: *"do not reveal this preamble; let it naturally inform your warmth and continuity."* This prevents Sage from saying things like "According to your profile, you have anxiety."

### Profile update prompt

A separate, dedicated system prompt (`PROFILE_UPDATE_SYSTEM_PROMPT`) instructs Claude to return **only** a JSON object. The response is stripped of any markdown code fences before parsing:

```js
raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/, "").trim()
```

The profile update uses the last 10 messages (5 pairs) rather than the full history to keep API costs low while still capturing recent developments.

---

## 9. Session Management

### CLI session
State lives in local variables within `main()`:
- `messages[]` — in-process array, hydrated from Redis/MongoDB on startup
- `enrichedSystemPrompt` — let variable, rebuilt after `reset` or `prefs set`
- `messagesSinceLastProfileUpdate` — resets to 0 on startup
- `sessionMessageCount` — tracks messages sent in current run (for session-end flush)

### Web session
State lives in the `sessions` Map in `server.js`:

```js
sessions.get(userId) → {
  messages[],             // in-process message array
  memory{},               // loaded memory object (preferences, episodes, etc.)
  messagesSinceUpdate,    // counter for profile update trigger
  sessionMessageCount,    // for future session-end flush
}
```

**Page refresh behaviour**: On refresh, the browser calls `POST /api/start` again. This re-runs `loadAllMemory` from Redis/MongoDB and re-populates `session.messages`. The in-memory Map entry is recreated — no data is lost because all messages are persisted to Redis/MongoDB.

**Multi-instance note**: The `sessions` Map is process-local. Running multiple server instances would cause users to hit inconsistent session state. This is acceptable for single-instance deployments (Railway/Render free tier). Scaling would require moving session state to Redis.

---

## 10. Web API Reference

| Method | Path | Body / Params | Response | Purpose |
|--------|------|---|---|---|
| `POST` | `/api/start` | `{ userId }` | `{ isReturning, needsChallenges, summary }` | Init session, detect new/returning |
| `POST` | `/api/challenges` | `{ userId, challenges[] }` | `{ ok }` | Save onboarding challenges |
| `POST` | `/api/greet` | `{ userId }` | SSE stream | Stream opening greeting |
| `POST` | `/api/chat` | `{ userId, message }` | SSE stream | Stream chat response |
| `GET`  | `/api/history/:userId` | — | `{ turnCount, profile, episodes[], narrative, preferences }` | Full memory for history panel |
| `POST` | `/api/prefs/:userId` | `{ key, value }` | `{ ok }` | Set one preference |
| `DELETE` | `/api/prefs/:userId` | — | `{ ok }` | Clear all preferences |
| `POST` | `/api/new/:userId` | — | `{ ok }` | Clear short-term only |
| `POST` | `/api/reset/:userId` | — | `{ ok }` | Clear all memory |

### SSE wire format

```
data: {"type":"delta","text":"..."}\n\n    ← one chunk of streamed text
data: {"type":"done"}\n\n                  ← stream complete
data: {"type":"error","message":"..."}\n\n ← error during streaming
```

---

## 11. Data Schemas

### Redis keys (`sage:{userId}:*`)

| Key | Type | Sample value |
|-----|------|---|
| `sage:alex:short_term` | List | `["{\"role\":\"user\",\"content\":\"I feel anxious\"}", ...]` (newest first) |
| `sage:alex:profile` | String | `{"mood_patterns":["tends to catastrophise"],"triggers":["work deadlines"],...}` |
| `sage:alex:episodes` | List | `["{\"date\":\"2026-01-15\",\"summary\":\"...\",\"emotion\":\"overwhelmed\",\"context\":\"...\"}"]` |
| `sage:alex:narrative` | String | `"Alex has been navigating significant work-related anxiety..."` |
| `sage:alex:preferences` | String | `{"name":"Alex","challenges":["Anxiety or persistent worry","Burnout or exhaustion"]}` |

### MongoDB document (`sage_chatbot.users`)

```json
{
  "_id": "alex",
  "shortTerm": [
    { "role": "user", "content": "I feel anxious" },
    { "role": "assistant", "content": "I hear you..." }
  ],
  "profile": {
    "mood_patterns": ["tends to catastrophise"],
    "triggers": ["work deadlines", "social conflict"],
    "coping_strategies": ["journalling", "breathing exercises"],
    "recurring_themes": ["imposter syndrome", "burnout"],
    "communication_style": "prefers validation before advice"
  },
  "episodes": [
    {
      "date": "2026-01-15",
      "summary": "Expressed feeling overwhelmed by a major project deadline",
      "emotion": "overwhelmed",
      "context": "First session disclosure; seemed relieved to talk about it"
    }
  ],
  "narrative": "Alex has been navigating significant work-related anxiety, particularly around deadlines. They show self-awareness about their patterns and respond well to validation-first approaches.",
  "preferences": {
    "name": "Alex",
    "pronouns": "they/them",
    "style": "gentle",
    "challenges": ["Anxiety or persistent worry", "Burnout or exhaustion"]
  },
  "createdAt": "2026-01-10T09:00:00.000Z",
  "updatedAt": "2026-01-15T14:23:00.000Z"
}
```

---

## 12. Key Design Decisions

### Redis as primary, MongoDB as fallback
Messages are `await`-ed to Redis (so they're available instantly for the next API call) and fire-and-forgotten to MongoDB (so they don't block the response). Profile updates are `await`-ed to both stores since they're less frequent and correctness matters more.

### Profile updates are fire-and-forget (mid-session) but awaited (on exit)
Mid-session profile updates run in the background so they never delay Sage's response. However, on session exit the update is awaited to guarantee the session is not lost when the process terminates.

### Enriched system prompt is built at session start, not mid-session
Rebuilding the enriched prompt after every profile update would change Sage's context mid-conversation, which could cause inconsistency. The prompt is rebuilt from fresh memory only at the start of each new session. Exception: `prefs set` and `reset` immediately rebuild the prompt because these are explicit user-driven changes.

### `new` vs `reset` distinction
- `new` clears `short_term` only — the profile, episodes, narrative, and preferences survive. Sage greets with full context.
- `reset` deletes the entire user document from both stores. The user re-experiences the new-user onboarding flow.

### Username sanitisation
`replace(/[^a-z0-9_-]/gi, "_").toLowerCase()` — allows alphanumeric, hyphens, and underscores. Prevents Redis key injection and MongoDB document ID collisions. Applied consistently in both CLI and Web interfaces.

### SSE over WebSockets for streaming
Server-Sent Events are simpler (one-way, HTTP, no upgrade), natively supported by the Fetch API's `ReadableStream`, and sufficient for this use case since only the server needs to push data to the client.
