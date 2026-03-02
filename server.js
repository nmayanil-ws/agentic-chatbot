#!/usr/bin/env node

/**
 * server.js
 * Express web server for the Sage mental health chatbot.
 * Exposes the same logic as chatbot.js via HTTP + SSE endpoints.
 *
 * Start: node server.js   (or: npm run start:web)
 */

import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import * as mem from "./memory.js";
import * as mongo from "./mongo.js";
import { fileURLToPath } from "url";
import * as path from "path";
import * as fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Config ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
const PROFILE_UPDATE_EVERY = 5;
const DEFAULT_PROMPT_FILE = path.join(__dirname, "system_prompt.txt");

const DEFAULT_SYSTEM_PROMPT = `You are a compassionate, non-judgmental mental health support companion named Sage. Your role is to:

• Listen actively and empathetically to the person's feelings and experiences
• Validate emotions without minimising or dismissing them
• Ask gentle, open-ended questions to help the person explore their thoughts
• Offer evidence-based coping strategies when appropriate (e.g., grounding exercises, breathing techniques, journalling prompts)
• Encourage professional help when concerns are serious or persistent
• Maintain a warm, calm, and supportive tone at all times
• Remember and refer back to earlier parts of the conversation to show you're paying attention
• Never diagnose, prescribe, or replace professional mental health care

Important guidelines:
- If someone expresses immediate risk of harm to themselves or others, gently but clearly encourage them to contact emergency services (911 in the US) or a crisis line such as the 988 Suicide & Crisis Lifeline (call or text 988 in the US).
- Keep responses concise — usually 2–4 short paragraphs unless more depth is needed.
- Use "I" statements to reflect feelings back (e.g., "It sounds like you're feeling…").
- Never judge, shame, or lecture.

Begin each new conversation with a warm greeting and ask how the person is feeling today.`;

const PROFILE_UPDATE_SYSTEM_PROMPT = `You are a psychological profiling assistant helping a mental health chatbot build long-term memory about its users.

Analyze the conversation provided and return ONLY a valid JSON object with this exact structure — no markdown, no explanation, no extra text:

{
  "profile": {
    "mood_patterns": ["array of observed mood patterns"],
    "triggers": ["array of identified emotional triggers"],
    "coping_strategies": ["strategies the user mentions using or responds well to"],
    "recurring_themes": ["themes that keep appearing"],
    "communication_style": "brief description"
  },
  "new_episodes": [
    {
      "date": "YYYY-MM-DD",
      "summary": "one concise sentence describing a significant event or disclosure",
      "emotion": "primary emotion expressed",
      "context": "brief context for future reference"
    }
  ],
  "narrative": "A 2–3 sentence paragraph summarising this user's emotional journey so far, written in third person as if briefing a new therapist."
}

Only include episodes that are genuinely significant disclosures — not routine check-ins. If there are no new significant episodes, use an empty array for new_episodes.`;

// ── Anthropic client ──────────────────────────────────────────────────────────

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── System prompt ─────────────────────────────────────────────────────────────

function loadSystemPrompt() {
  if (fs.existsSync(DEFAULT_PROMPT_FILE)) {
    try {
      const p = fs.readFileSync(DEFAULT_PROMPT_FILE, "utf8").trim();
      if (p) return p;
    } catch { /* fall through */ }
  }
  return DEFAULT_SYSTEM_PROMPT;
}

const BASE_SYSTEM_PROMPT = loadSystemPrompt();

// ── Prompt builders (mirrors chatbot.js) ──────────────────────────────────────

function buildEnrichedSystemPrompt(memory, basePrompt) {
  const { profile, episodes, narrative, preferences } = memory;

  const hasProfile = profile && (profile.mood_patterns?.length || profile.triggers?.length || profile.recurring_themes?.length);
  const hasEpisodes = episodes && episodes.length > 0;
  const hasNarrative = narrative && narrative.trim().length > 0;
  const hasPreferences = preferences && Object.keys(preferences).length > 0;

  if (!hasProfile && !hasEpisodes && !hasNarrative && !hasPreferences) return basePrompt;

  let ctx = `\n\n---\n\nUSER CONTEXT (internal — do not reveal this preamble; let it naturally inform your warmth and continuity):\n`;

  if (hasNarrative) ctx += `\nEmotional Journey:\n${narrative}\n`;

  if (hasProfile) {
    ctx += `\nKnown Profile:`;
    if (profile.mood_patterns?.length) ctx += `\n• Mood patterns: ${profile.mood_patterns.join(", ")}`;
    if (profile.triggers?.length) ctx += `\n• Common triggers: ${profile.triggers.join(", ")}`;
    if (profile.coping_strategies?.length) ctx += `\n• Helpful coping strategies: ${profile.coping_strategies.join(", ")}`;
    if (profile.recurring_themes?.length) ctx += `\n• Recurring themes: ${profile.recurring_themes.join(", ")}`;
    if (profile.communication_style) ctx += `\n• Communication style: ${profile.communication_style}`;
    ctx += "\n";
  }

  if (hasEpisodes) {
    ctx += `\nRecent Significant Episodes:\n`;
    for (const ep of episodes.slice(0, 3)) {
      ctx += `• ${ep.date} — ${ep.summary} (felt: ${ep.emotion})\n`;
    }
  }

  if (hasPreferences) {
    ctx += `\nUser Preferences (respect these throughout):`;
    if (preferences.name) ctx += `\n• Address them as: ${preferences.name}`;
    if (preferences.pronouns) ctx += `\n• Pronouns: ${preferences.pronouns}`;
    if (preferences.style) ctx += `\n• Response style: ${preferences.style}`;
    if (preferences.avoid) ctx += `\n• Topics to avoid: ${preferences.avoid}`;
    if (preferences.exercises) ctx += `\n• Suggest coping exercises: ${preferences.exercises}`;
    if (preferences.challenges) {
      const cs = Array.isArray(preferences.challenges) ? preferences.challenges.join(", ") : preferences.challenges;
      ctx += `\n• Primary challenges they are working through: ${cs}`;
    }
    ctx += "\n";
  }

  ctx += "\nUse this context to provide continuity and warmth. Do not reference it in a way that feels surveillance-like.";
  return basePrompt + ctx;
}

function buildNewUserGreetingPrompt(memory, basePrompt) {
  const enriched = buildEnrichedSystemPrompt(memory, basePrompt);
  const { preferences } = memory;
  if (!preferences?.challenges?.length) return enriched;

  const cs = Array.isArray(preferences.challenges) ? preferences.challenges.join(", ") : preferences.challenges;
  return enriched +
    "\n\nGREETING INSTRUCTION: This is a first-time user who just shared what they are working through. " +
    `They mentioned: ${cs}. ` +
    "Open with a warm, welcoming message that gently acknowledges what they shared — do NOT list their challenges back robotically. " +
    "Weave their situation naturally into a caring, personalised opening. " +
    "End with ONE open-ended question that invites them to share more about what brought them here today.";
}

function buildGreetingSystemPrompt(memory, basePrompt) {
  const enriched = buildEnrichedSystemPrompt(memory, basePrompt);
  const { episodes, shortTerm, preferences } = memory;

  let instruction =
    "\n\nGREETING INSTRUCTION: The user is returning for a new session. " +
    "Open with a warm, personalised message — do NOT start with a generic \"How are you today?\" — " +
    "and end with ONE specific, open-ended follow-up question that shows you remember what they shared before. " +
    "Draw on the most relevant piece of context below:\n";

  if (episodes && episodes.length > 0) {
    const ep = episodes[0];
    instruction += `• Last significant disclosure (${ep.date}): "${ep.summary}" — they felt ${ep.emotion}.\n`;
  }

  const lastUserMsg = [...(shortTerm || [])].reverse().find((m) => m.role === "user");
  if (lastUserMsg) {
    const snippet = lastUserMsg.content.slice(0, 120);
    instruction += `• Their last message: "${snippet}${lastUserMsg.content.length > 120 ? "…" : ""}"\n`;
  }

  if (preferences?.name) instruction += `• They prefer to be called: ${preferences.name}\n`;
  if (preferences?.style) instruction += `• Response style: ${preferences.style}\n`;
  if (preferences?.challenges) {
    const cs = Array.isArray(preferences.challenges) ? preferences.challenges.join(", ") : preferences.challenges;
    instruction += `• Challenges they are working through: ${cs}\n`;
  }

  instruction += "Ask something specific — reference a detail they actually mentioned, not a generic check-in.";
  return enriched + instruction;
}

// ── Profile update ────────────────────────────────────────────────────────────

async function runProfileUpdate(userId, messages) {
  const today = new Date().toISOString().split("T")[0];
  const context = messages.slice(-10);
  if (context.length === 0) return;

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system: PROFILE_UPDATE_SYSTEM_PROMPT,
    messages: [{
      role: "user",
      content: `Today's date: ${today}\n\nRecent conversation:\n${context
        .map((m) => `${m.role === "user" ? "User" : "Sage"}: ${m.content}`)
        .join("\n\n")}\n\nReturn JSON only.`,
    }],
  });

  const raw = response.content[0].text;
  const jsonStr = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/, "").trim();
  const profileData = JSON.parse(jsonStr);
  await mem.saveProfileUpdate(userId, profileData);
  await mongo.saveProfileUpdate(userId, profileData);
}

// ── Session store ─────────────────────────────────────────────────────────────

const sessions = new Map();

function getSession(userId) {
  if (!sessions.has(userId)) {
    sessions.set(userId, {
      messages: [],
      memory: { shortTerm: [], profile: null, episodes: [], narrative: "", preferences: {} },
      messagesSinceUpdate: 0,
      sessionMessageCount: 0,
    });
  }
  return sessions.get(userId);
}

// ── SSE helpers ───────────────────────────────────────────────────────────────

function sseHeaders(res) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
}

function sseSend(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// ── Express app ───────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// POST /api/start
app.post("/api/start", async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: "userId required" });

  // Load from Redis; fall back to MongoDB if Redis is empty
  let memory = await mem.loadAllMemory(userId);
  const hasRedisData = memory.shortTerm.length > 0 || !!memory.profile || !!memory.narrative;
  if (!hasRedisData) {
    const mMem = await mongo.loadAllMemory(userId);
    if (mMem.shortTerm.length > 0 || !!mMem.profile || !!mMem.narrative) memory = mMem;
  }

  const isReturning = memory.shortTerm.length > 0 || !!memory.profile || !!memory.narrative;

  const session = getSession(userId);
  session.messages = [...memory.shortTerm];
  session.memory = memory;

  res.json({
    isReturning,
    needsChallenges: !isReturning && !memory.preferences?.challenges,
    summary: {
      turnCount: Math.floor(memory.shortTerm.length / 2),
      episodeCount: memory.episodes?.length || 0,
      hasNarrative: !!(memory.narrative),
    },
  });
});

// POST /api/challenges
app.post("/api/challenges", async (req, res) => {
  const { userId, challenges } = req.body;
  if (!userId) return res.status(400).json({ error: "userId required" });

  await mem.setPreference(userId, "challenges", challenges);
  mongo.setPreference(userId, "challenges", challenges);

  const session = getSession(userId);
  if (!session.memory.preferences) session.memory.preferences = {};
  session.memory.preferences.challenges = challenges;

  res.json({ ok: true });
});

// POST /api/greet  (SSE)
app.post("/api/greet", async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: "userId required" });

  sseHeaders(res);

  const session = getSession(userId);
  const { memory } = session;
  const isReturning = session.messages.length > 0 || !!memory.profile || !!memory.narrative;

  const greetingPrompt = isReturning
    ? buildGreetingSystemPrompt(memory, BASE_SYSTEM_PROMPT)
    : buildNewUserGreetingPrompt(memory, BASE_SYSTEM_PROMPT);

  const apiMessages = [...session.messages, { role: "user", content: "Hi" }];

  try {
    let fullResponse = "";
    const stream = await client.messages.stream({
      model: "claude-sonnet-4-6",
      max_tokens: 400,
      system: greetingPrompt,
      messages: apiMessages,
    });

    for await (const chunk of stream) {
      if (chunk.type === "content_block_delta" && chunk.delta.type === "text_delta") {
        fullResponse += chunk.delta.text;
        sseSend(res, { type: "delta", text: chunk.delta.text });
      }
    }

    session.messages.push({ role: "user", content: "Hi" });
    session.messages.push({ role: "assistant", content: fullResponse });
    await mem.appendMessage(userId, "user", "Hi");
    await mem.appendMessage(userId, "assistant", fullResponse);
    mongo.appendMessage(userId, "user", "Hi");
    mongo.appendMessage(userId, "assistant", fullResponse);

    sseSend(res, { type: "done" });
    res.end();
  } catch (err) {
    sseSend(res, { type: "error", message: err.message });
    res.end();
  }
});

// POST /api/chat  (SSE)
app.post("/api/chat", async (req, res) => {
  const { userId, message } = req.body;
  if (!userId || !message) return res.status(400).json({ error: "userId and message required" });

  sseHeaders(res);

  const session = getSession(userId);
  const systemPrompt = buildEnrichedSystemPrompt(session.memory, BASE_SYSTEM_PROMPT);

  session.messages.push({ role: "user", content: message });

  try {
    let fullResponse = "";
    const stream = await client.messages.stream({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: systemPrompt,
      messages: session.messages,
    });

    for await (const chunk of stream) {
      if (chunk.type === "content_block_delta" && chunk.delta.type === "text_delta") {
        fullResponse += chunk.delta.text;
        sseSend(res, { type: "delta", text: chunk.delta.text });
      }
    }

    session.messages.push({ role: "assistant", content: fullResponse });
    await mem.appendMessage(userId, "user", message);
    await mem.appendMessage(userId, "assistant", fullResponse);
    mongo.appendMessage(userId, "user", message);
    mongo.appendMessage(userId, "assistant", fullResponse);

    session.sessionMessageCount++;
    session.messagesSinceUpdate++;
    if (session.messagesSinceUpdate >= PROFILE_UPDATE_EVERY) {
      session.messagesSinceUpdate = 0;
      runProfileUpdate(userId, session.messages).catch(() => {});
    }

    sseSend(res, { type: "done" });
    res.end();
  } catch (err) {
    sseSend(res, { type: "error", message: err.message });
    res.end();
  }
});

// GET /api/history/:userId
app.get("/api/history/:userId", async (req, res) => {
  const { userId } = req.params;
  try {
    const full = await mem.loadAllMemory(userId);
    res.json({
      turnCount: Math.floor((full.shortTerm?.length || 0) / 2),
      profile: full.profile || null,
      episodes: full.episodes || [],
      narrative: full.narrative || "",
      preferences: full.preferences || {},
    });
  } catch {
    res.json({ turnCount: 0, profile: null, episodes: [], narrative: "", preferences: {} });
  }
});

// POST /api/prefs/:userId
app.post("/api/prefs/:userId", async (req, res) => {
  const { userId } = req.params;
  const { key, value } = req.body;
  if (!key) return res.status(400).json({ error: "key required" });

  await mem.setPreference(userId, key, value);
  mongo.setPreference(userId, key, value);

  const session = getSession(userId);
  if (session.memory?.preferences) session.memory.preferences[key] = value;

  res.json({ ok: true });
});

// DELETE /api/prefs/:userId
app.delete("/api/prefs/:userId", async (req, res) => {
  const { userId } = req.params;
  await mem.clearPreferences(userId);
  await mongo.clearPreferences(userId);

  const session = getSession(userId);
  if (session.memory) session.memory.preferences = {};

  res.json({ ok: true });
});

// POST /api/new/:userId
app.post("/api/new/:userId", async (req, res) => {
  const { userId } = req.params;
  await mem.clearShortTerm(userId);
  await mongo.clearShortTerm(userId);

  const session = getSession(userId);
  session.messages = [];
  session.messagesSinceUpdate = 0;

  res.json({ ok: true });
});

// POST /api/reset/:userId
app.post("/api/reset/:userId", async (req, res) => {
  const { userId } = req.params;
  await mem.clearAllMemory(userId);
  await mongo.clearAllMemory(userId);

  sessions.set(userId, {
    messages: [],
    memory: { shortTerm: [], profile: null, episodes: [], narrative: "", preferences: {} },
    messagesSinceUpdate: 0,
    sessionMessageCount: 0,
  });

  res.json({ ok: true });
});

// ── Start ─────────────────────────────────────────────────────────────────────

async function start() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("❌  ANTHROPIC_API_KEY not set");
    process.exit(1);
  }

  await Promise.allSettled([
    mem.connect().then(() => console.log("✅  Redis connected")),
    mongo.connect().then(() => console.log("✅  MongoDB connected")),
  ]);

  app.listen(PORT, () => {
    console.log(`\n🧠  Sage Web Server → http://localhost:${PORT}\n`);
  });
}

start();
