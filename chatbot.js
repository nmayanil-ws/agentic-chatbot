#!/usr/bin/env node

/**
 * 🧠 Mental Health Chatbot — Sage
 * Powered by Claude AI with Redis-backed 4-layer memory:
 *   1. Short-term conversational state   (recent messages)
 *   2. Structured psychological profile  (mood patterns, triggers, etc.)
 *   3. Episodic memory                   (significant past events)
 *   4. Longitudinal narrative            (running summary of the user's journey)
 */

import Anthropic from "@anthropic-ai/sdk";
import * as readline from "readline";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import * as mem from "./memory.js";
import * as mongo from "./mongo.js";
import { runAgentLoop } from "./agent.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Config ───────────────────────────────────────────────────────────────────

const PROFILE_UPDATE_EVERY = 5; // trigger a background profile update every N user turns
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

/**
 * Load the base system prompt with this priority:
 *   1. --prompt-file <path>  CLI flag
 *   2. system_prompt.txt     in the project directory (if it exists)
 *   3. DEFAULT_SYSTEM_PROMPT hardcoded fallback
 *
 * Returns { prompt, source } where source describes where it came from.
 */
function loadSystemPrompt() {
  // 1. --prompt-file <path> CLI flag
  const flagIdx = process.argv.indexOf("--prompt-file");
  if (flagIdx !== -1) {
    const filePath = process.argv[flagIdx + 1];
    if (!filePath) {
      console.error("❌  --prompt-file requires a path argument.");
      process.exit(1);
    }
    try {
      const prompt = fs.readFileSync(path.resolve(filePath), "utf8").trim();
      return { prompt, source: `file: ${filePath}` };
    } catch (e) {
      console.error(`❌  Could not read prompt file "${filePath}": ${e.message}`);
      process.exit(1);
    }
  }

  // 2. system_prompt.txt in project directory
  if (fs.existsSync(DEFAULT_PROMPT_FILE)) {
    try {
      const prompt = fs.readFileSync(DEFAULT_PROMPT_FILE, "utf8").trim();
      if (prompt) return { prompt, source: "system_prompt.txt" };
    } catch {
      /* fall through */
    }
  }

  // 3. Hardcoded default
  return { prompt: DEFAULT_SYSTEM_PROMPT, source: "built-in default" };
}

const PROFILE_UPDATE_SYSTEM_PROMPT = `You are a psychological profiling assistant helping a mental health chatbot build long-term memory about its users.

Analyze the conversation provided and return ONLY a valid JSON object with this exact structure — no markdown, no explanation, no extra text:

{
  "profile": {
    "mood_patterns": ["array of observed mood patterns, e.g. 'tends to feel anxious in the evenings'"],
    "triggers": ["array of identified emotional triggers, e.g. 'work deadlines', 'social conflict'"],
    "coping_strategies": ["strategies the user mentions using or responds well to"],
    "recurring_themes": ["themes that keep appearing, e.g. 'loneliness', 'imposter syndrome'"],
    "communication_style": "brief description, e.g. 'prefers validation before advice, uses self-deprecating humour'"
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

// ── Session state ─────────────────────────────────────────────────────────────

let messagesSinceLastProfileUpdate = 0;
let sessionMessageCount = 0; // total user messages sent this session (survives `new`)

// ── Helpers ───────────────────────────────────────────────────────────────────

function promptForUsername(rl) {
  return new Promise((resolve) => {
    rl.question("  What's your name? ", (answer) => {
      const name = answer.trim().replace(/[^a-z0-9_-]/gi, "_").toLowerCase();
      resolve(name || "friend");
    });
  });
}

const CHALLENGES = [
  "Anxiety or persistent worry",
  "Depression or low mood",
  "Work or academic stress",
  "Relationship difficulties",
  "Grief or loss",
  "Sleep problems",
  "Low self-esteem or confidence",
  "Loneliness or isolation",
  "Trauma or difficult past experiences",
  "Burnout or exhaustion",
];

/**
 * For new users: display a numbered list of common challenges and let them
 * select by number (comma-separated) or type their own free-text answer.
 * Returns an array of challenge strings.
 */
function promptForChallenges(rl) {
  return new Promise((resolve) => {
    console.log(
      "\n  To help personalise your experience, what are you currently dealing with?"
    );
    console.log(
      "  Enter one or more numbers (e.g. 1,3) or type your own, or press Enter to skip:\n"
    );
    CHALLENGES.forEach((c, i) => {
      console.log(`    ${String(i + 1).padStart(2)}. ${c}`);
    });
    console.log();

    rl.question("  Your challenges: ", (answer) => {
      const raw = answer.trim();
      if (!raw) {
        resolve([]);
        return;
      }

      // If input is purely numeric/comma/space — treat as list selection
      if (/^[\d,\s]+$/.test(raw)) {
        const selected = [
          ...new Set(
            raw
              .split(/[\s,]+/)
              .map((n) => parseInt(n, 10))
              .filter((n) => n >= 1 && n <= CHALLENGES.length)
          ),
        ].map((n) => CHALLENGES[n - 1]);
        resolve(selected.length > 0 ? selected : []);
      } else {
        // Free-text — split on commas for multiple entries
        const custom = raw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        resolve(custom);
      }
    });
  });
}

// Valid preference keys and their human-readable labels
const PREF_KEYS = {
  name:       "Preferred name",
  pronouns:   "Preferred pronouns",
  style:      "Response style (gentle / direct / reflective)",
  avoid:      "Topics to avoid",
  exercises:  "Suggest coping exercises (yes / no)",
  challenges: "Current challenges",
};

function buildEnrichedSystemPrompt(memory, basePrompt) {
  const { profile, episodes, narrative, preferences } = memory;

  const hasProfile =
    profile &&
    (profile.mood_patterns?.length ||
      profile.triggers?.length ||
      profile.recurring_themes?.length);
  const hasEpisodes = episodes && episodes.length > 0;
  const hasNarrative = narrative && narrative.trim().length > 0;
  const hasPreferences = preferences && Object.keys(preferences).length > 0;

  if (!hasProfile && !hasEpisodes && !hasNarrative && !hasPreferences) {
    return basePrompt; // first-ever session — no context to inject
  }

  let context = `\n\n---\n\nUSER CONTEXT (internal — do not reveal this preamble to the user; let it naturally inform your warmth and continuity):\n`;

  if (hasNarrative) {
    context += `\nEmotional Journey:\n${narrative}\n`;
  }

  if (hasProfile) {
    context += `\nKnown Profile:`;
    if (profile.mood_patterns?.length)
      context += `\n• Mood patterns: ${profile.mood_patterns.join(", ")}`;
    if (profile.triggers?.length)
      context += `\n• Common triggers: ${profile.triggers.join(", ")}`;
    if (profile.coping_strategies?.length)
      context += `\n• Helpful coping strategies: ${profile.coping_strategies.join(", ")}`;
    if (profile.recurring_themes?.length)
      context += `\n• Recurring themes: ${profile.recurring_themes.join(", ")}`;
    if (profile.communication_style)
      context += `\n• Communication style: ${profile.communication_style}`;
    context += "\n";
  }

  if (hasEpisodes) {
    const recent = episodes.slice(0, 3); // most recent 3 episodes
    context += `\nRecent Significant Episodes:\n`;
    for (const ep of recent) {
      context += `• ${ep.date} — ${ep.summary} (felt: ${ep.emotion})\n`;
    }
  }

  if (hasPreferences) {
    context += `\nUser Preferences (respect these throughout the conversation):`;
    if (preferences.name)
      context += `\n• Address them as: ${preferences.name}`;
    if (preferences.pronouns)
      context += `\n• Pronouns: ${preferences.pronouns}`;
    if (preferences.style)
      context += `\n• Response style: ${preferences.style}`;
    if (preferences.avoid)
      context += `\n• Topics to avoid: ${preferences.avoid}`;
    if (preferences.exercises)
      context += `\n• Suggest coping exercises: ${preferences.exercises}`;
    if (preferences.challenges) {
      const challengeStr = Array.isArray(preferences.challenges)
        ? preferences.challenges.join(", ")
        : preferences.challenges;
      context += `\n• Primary challenges they are working through: ${challengeStr}`;
    }
    context += "\n";
  }

  context +=
    "\nUse this context to provide continuity and warmth. Do not reference it in a way that feels surveillance-like — let it naturally inform your responses.";

  return basePrompt + context;
}

/**
 * For returning users, extends the enriched system prompt with a specific
 * instruction telling Sage to open with a contextual follow-up question
 * rather than a generic greeting.
 */
/**
 * For first-time users who provided challenges: instructs Sage to open with a
 * message that gently acknowledges those challenges rather than a generic greeting.
 */
function buildNewUserGreetingPrompt(memory, basePrompt) {
  const enriched = buildEnrichedSystemPrompt(memory, basePrompt);
  const { preferences } = memory;

  if (!preferences?.challenges?.length) return enriched;

  const challengeStr = Array.isArray(preferences.challenges)
    ? preferences.challenges.join(", ")
    : preferences.challenges;

  const instruction =
    "\n\nGREETING INSTRUCTION: This is a first-time user who just shared what they are working through. " +
    `They mentioned: ${challengeStr}. ` +
    "Open with a warm, welcoming message that gently acknowledges what they shared — do NOT list " +
    "their challenges back to them robotically. Weave their situation naturally into a caring, " +
    "personalised opening. End with ONE open-ended question that invites them to share more about " +
    "what brought them here today.";

  return enriched + instruction;
}

/**
 * For returning users, extends the enriched system prompt with a specific
 * instruction telling Sage to open with a contextual follow-up question
 * rather than a generic greeting.
 */
function buildGreetingSystemPrompt(memory, basePrompt) {
  const enriched = buildEnrichedSystemPrompt(memory, basePrompt);
  const { episodes, shortTerm, preferences } = memory;

  let instruction =
    "\n\nGREETING INSTRUCTION: The user is returning for a new session. " +
    "Open with a warm, personalised message — do NOT start with a generic " +
    '"How are you today?" — and end with ONE specific, open-ended follow-up ' +
    "question that shows you remember what they shared before. " +
    "Draw on the most relevant piece of context below:\n";

  // Most recent episode
  if (episodes && episodes.length > 0) {
    const ep = episodes[0];
    instruction += `• Last significant disclosure (${ep.date}): "${ep.summary}" — they felt ${ep.emotion}.\n`;
  }

  // Last user message from the previous session
  const lastUserMsg = [...(shortTerm || [])].reverse().find((m) => m.role === "user");
  if (lastUserMsg) {
    const snippet = lastUserMsg.content.slice(0, 120);
    instruction += `• Their last message: "${snippet}${lastUserMsg.content.length > 120 ? "…" : ""}"\n`;
  }

  // Preferences that should shape the opening
  if (preferences?.name) instruction += `• They prefer to be called: ${preferences.name}\n`;
  if (preferences?.style) instruction += `• Response style: ${preferences.style}\n`;
  if (preferences?.challenges) {
    const challengeStr = Array.isArray(preferences.challenges)
      ? preferences.challenges.join(", ")
      : preferences.challenges;
    instruction += `• Challenges they are working through: ${challengeStr}\n`;
  }

  instruction +=
    "Ask something specific — reference a detail they actually mentioned, not a generic check-in.";

  return enriched + instruction;
}

function printDivider() {
  console.log("\n" + "─".repeat(60) + "\n");
}

function formatSageResponse(text) {
  const width = process.stdout.columns || 80;
  const lines = text.split("\n");
  return lines
    .map((line) => {
      if (line.length <= width - 10) return line;
      const words = line.split(" ");
      let result = "";
      let current = "";
      for (const word of words) {
        if ((current + word).length > width - 10) {
          result += current.trimEnd() + "\n";
          current = word + " ";
        } else {
          current += word + " ";
        }
      }
      return result + current.trimEnd();
    })
    .join("\n");
}

// ── Profile update ────────────────────────────────────────────────────────────

/**
 * Core profile update logic — awaitable.
 * Calls Claude to analyse recent conversation and persists the result to
 * both Redis and MongoDB.
 */
async function runProfileUpdate(userId, messages) {
  const today = new Date().toISOString().split("T")[0];
  const context = messages.slice(-10); // last 5 pairs
  if (context.length === 0) return;

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system: PROFILE_UPDATE_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Today's date: ${today}\n\nRecent conversation:\n${context
          .map((m) => `${m.role === "user" ? "User" : "Sage"}: ${m.content}`)
          .join("\n\n")}\n\nReturn JSON only.`,
      },
    ],
  });

  const raw = response.content[0].text;
  const jsonStr = raw
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  const profileData = JSON.parse(jsonStr);
  await mem.saveProfileUpdate(userId, profileData);
  await mongo.saveProfileUpdate(userId, profileData);
}

/** Fire-and-forget wrapper — used for mid-session updates. */
function triggerProfileUpdate(userId, messages) {
  runProfileUpdate(userId, messages).catch(() => {
    // Silent failure — profile update is best-effort
  });
}

// ── Core chat function ────────────────────────────────────────────────────────

async function chat(userId, messages, userInput, systemPrompt) {
  let indicator = "";

  const { text: fullResponse, messages: updatedMessages } = await runAgentLoop(client, {
    userId,
    messages,
    userInput,
    systemPrompt,
    onToolCall: (label) => {
      // Overwrite the current line with a dim status indicator
      process.stdout.write(`\r  ⋯ ${label}${" ".repeat(Math.max(0, 40 - label.length))}`);
      indicator = label;
    },
    onText: (text) => {
      if (indicator) {
        // Clear the indicator line before printing Sage's reply
        process.stdout.write("\r" + " ".repeat(indicator.length + 45) + "\r");
        indicator = "";
      }
      process.stdout.write("\n🌿 Sage: " + formatSageResponse(text) + "\n\n");
    },
  });

  // Persist only the text turns to Redis + MongoDB (tool turns stay in-memory only)
  await mem.appendMessage(userId, "user", userInput);
  await mem.appendMessage(userId, "assistant", fullResponse);
  mongo.appendMessage(userId, "user", userInput);
  mongo.appendMessage(userId, "assistant", fullResponse);

  // Profile update — filter to text-only messages so the profiling prompt stays clean
  sessionMessageCount++;
  messagesSinceLastProfileUpdate++;
  if (messagesSinceLastProfileUpdate >= PROFILE_UPDATE_EVERY) {
    messagesSinceLastProfileUpdate = 0;
    const textOnly = updatedMessages.filter((m) => typeof m.content === "string");
    triggerProfileUpdate(userId, textOnly);
  }

  // Return the full updated history (including tool turns) for intra-session coherence
  return updatedMessages;
}

// ── Opening greeting ──────────────────────────────────────────────────────────

async function openingGreeting(userId, messages, systemPrompt) {
  process.stdout.write("\n🌿 Sage: ");
  let fullResponse = "";

  // Pass prior shortTerm history so Sage has conversation context for its greeting.
  // A silent "Hi" seed triggers the response without appearing as user-visible input.
  const apiMessages = [
    ...messages,
    { role: "user", content: "Hi" },
  ];

  const stream = await client.messages.stream({
    model: "claude-sonnet-4-6",
    max_tokens: 400,
    system: systemPrompt,
    messages: apiMessages,
  });

  for await (const chunk of stream) {
    if (
      chunk.type === "content_block_delta" &&
      chunk.delta.type === "text_delta"
    ) {
      process.stdout.write(chunk.delta.text);
      fullResponse += chunk.delta.text;
    }
  }

  console.log("\n");

  messages.push({ role: "user", content: "Hi" });
  messages.push({ role: "assistant", content: fullResponse });

  await mem.appendMessage(userId, "user", "Hi");
  await mem.appendMessage(userId, "assistant", fullResponse);
  mongo.appendMessage(userId, "user", "Hi");
  mongo.appendMessage(userId, "assistant", fullResponse);

  return messages;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      "❌  Please set the ANTHROPIC_API_KEY environment variable.\n   export ANTHROPIC_API_KEY=your_key_here"
    );
    process.exit(1);
  }

  console.clear();
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║          🧠  Mental Health Support Chatbot               ║");
  console.log("║               Powered by Claude AI (Sage)                ║");
  console.log("╠══════════════════════════════════════════════════════════╣");
  console.log("║  Commands:  new · reset · history · prompt · prefs · quit║");
  console.log(
    "║  ⚠️  Not a substitute for professional mental health care  ║"
  );
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  // Load base system prompt (file > system_prompt.txt > built-in default)
  const { prompt: BASE_SYSTEM_PROMPT, source: promptSource } = loadSystemPrompt();
  console.log(`  System prompt: ${promptSource}\n`);

  // Create readline interface before username prompt (needed for rl.question)
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "💬 You: ",
  });

  // Get username
  const userId = await promptForUsername(rl);
  console.log(`\n  Welcome, ${userId}.\n`);

  // Connect to Redis and MongoDB (both non-fatal if unavailable)
  let redisAvailable = false;
  let mongoAvailable = false;

  await Promise.allSettled([
    mem.connect().then(() => { redisAvailable = true; }),
    mongo.connect().then(() => { mongoAvailable = true; }),
  ]);

  if (!redisAvailable) {
    console.warn(
      "⚠️  Redis unavailable — short-term cache disabled.\n   Set REDIS_URL or start Redis locally.\n"
    );
  }
  if (!mongoAvailable) {
    console.warn(
      "⚠️  MongoDB unavailable — durable persistence disabled.\n   Set MONGO_URL or start MongoDB locally.\n"
    );
  }

  // Load all 4 memory layers — Redis first, MongoDB as fallback
  let memory = await mem.loadAllMemory(userId);
  const hasRedisData =
    memory.shortTerm.length > 0 || !!memory.profile || !!memory.narrative;

  if (!hasRedisData && mongoAvailable) {
    const mongoMemory = await mongo.loadAllMemory(userId);
    const hasMongoData =
      mongoMemory.shortTerm.length > 0 ||
      !!mongoMemory.profile ||
      !!mongoMemory.narrative;
    if (hasMongoData) memory = mongoMemory;
  }

  const isReturning =
    (redisAvailable || mongoAvailable) &&
    (memory.shortTerm.length > 0 || !!memory.profile || !!memory.narrative);

  if (isReturning) {
    const summary = await mem.getMemorySummary(userId);
    console.log(
      `📖  Resuming your history — ${summary.turnCount} turn(s) in memory` +
        (summary.episodeCount > 0
          ? `, ${summary.episodeCount} episode(s) remembered`
          : "") +
        `. Type "new" to start fresh.\n`
    );
  }

  // Build enriched system prompt from loaded memory
  let enrichedSystemPrompt = buildEnrichedSystemPrompt(memory, BASE_SYSTEM_PROMPT);

  // Hydrate local messages array and preferences from short-term memory
  let messages = [...memory.shortTerm];
  let preferences = { ...memory.preferences };

  // For brand-new users, ask about their challenges before the first greeting
  if (!isReturning) {
    const challenges = await promptForChallenges(rl);
    if (challenges.length > 0) {
      await mem.setPreference(userId, "challenges", challenges);
      mongo.setPreference(userId, "challenges", challenges);
      preferences.challenges = challenges;
      memory.preferences = preferences;
      // Rebuild so the opening greeting already knows their challenges
      enrichedSystemPrompt = buildEnrichedSystemPrompt(memory, BASE_SYSTEM_PROMPT);
    }
    console.log();
  }

  // Opening greeting — returning users get a contextual follow-up; new users
  // get a prompt that acknowledges the challenges they just shared.
  const greetingSystemPrompt = isReturning
    ? buildGreetingSystemPrompt(memory, BASE_SYSTEM_PROMPT)
    : buildNewUserGreetingPrompt(memory, BASE_SYSTEM_PROMPT);
  messages = await openingGreeting(userId, messages, greetingSystemPrompt);

  printDivider();
  rl.prompt();

  rl.on("line", async (input) => {
    const userInput = input.trim();

    if (!userInput) {
      rl.prompt();
      return;
    }

    const cmd = userInput.toLowerCase();

    // ── quit / exit ──
    if (cmd === "quit" || cmd === "exit") {
      console.log(
        "\n🌿 Sage: Take care of yourself. Remember, you can always come back whenever you need to talk. 💙\n"
      );
      if (sessionMessageCount > 0) {
        process.stdout.write("  Saving your session...");
        await runProfileUpdate(userId, messages).catch(() => {});
        process.stdout.write(" done.\n");
      }
      await Promise.allSettled([mem.disconnect(), mongo.disconnect()]);
      process.exit(0);
    }

    // ── new — clear short-term only, keep profile/episodes/narrative ──
    if (cmd === "new") {
      await mem.clearShortTerm(userId);
      await mongo.clearShortTerm(userId);
      messages = [];
      messagesSinceLastProfileUpdate = 0;
      console.log(
        "\n✨  Starting a fresh conversation (your profile and history are preserved)...\n"
      );
      // After "new", profile/episodes still exist — use contextual greeting
      messages = await openingGreeting(
        userId,
        messages,
        buildGreetingSystemPrompt(memory, BASE_SYSTEM_PROMPT)
      );
      printDivider();
      rl.prompt();
      return;
    }

    // ── reset — clear everything ──
    if (cmd === "reset") {
      await mem.clearAllMemory(userId);
      await mongo.clearAllMemory(userId);
      messages = [];
      messagesSinceLastProfileUpdate = 0;
      preferences = {};
      memory.preferences = preferences;
      enrichedSystemPrompt = BASE_SYSTEM_PROMPT; // no memory left
      console.log("\n🗑️   All memory cleared. Starting completely fresh...\n");
      messages = await openingGreeting(userId, messages, enrichedSystemPrompt);
      printDivider();
      rl.prompt();
      return;
    }

    // ── prompt — show the active base system prompt ──
    if (cmd === "prompt") {
      console.log(`\n📋  Active system prompt (${promptSource}):\n`);
      console.log("─".repeat(60));
      console.log(BASE_SYSTEM_PROMPT);
      console.log("─".repeat(60));
      console.log(
        "\n  To change it: create system_prompt.txt or run with --prompt-file <path>\n"
      );
      rl.prompt();
      return;
    }

    // ── prefs — view / set / clear user preferences ──
    if (cmd === "prefs" || cmd.startsWith("prefs ")) {
      // prefs clear
      if (cmd === "prefs clear") {
        await mem.clearPreferences(userId);
        await mongo.clearPreferences(userId);
        preferences = {};
        memory.preferences = preferences;
        enrichedSystemPrompt = buildEnrichedSystemPrompt(memory, BASE_SYSTEM_PROMPT);
        console.log("\n🗑️   All preferences cleared.\n");
        rl.prompt();
        return;
      }

      // prefs set <key> <value>
      if (cmd.startsWith("prefs set ")) {
        const rest = userInput.slice("prefs set ".length).trim();
        const spaceIdx = rest.indexOf(" ");
        if (spaceIdx === -1) {
          console.log(`\n  Usage: prefs set <key> <value>`);
          console.log(`  Valid keys: ${Object.keys(PREF_KEYS).join(", ")}\n`);
          rl.prompt();
          return;
        }
        const prefKey = rest.slice(0, spaceIdx).toLowerCase();
        const value = rest.slice(spaceIdx + 1).trim();
        if (!PREF_KEYS[prefKey]) {
          console.log(`\n  Unknown preference key "${prefKey}".`);
          console.log(`  Valid keys: ${Object.keys(PREF_KEYS).join(", ")}\n`);
          rl.prompt();
          return;
        }
        await mem.setPreference(userId, prefKey, value);
        mongo.setPreference(userId, prefKey, value);
        preferences[prefKey] = value;
        memory.preferences = preferences;
        enrichedSystemPrompt = buildEnrichedSystemPrompt(memory, BASE_SYSTEM_PROMPT);
        console.log(`\n  ✅  ${PREF_KEYS[prefKey]} set to: ${value}\n`);
        rl.prompt();
        return;
      }

      // prefs (show all)
      console.log(`\n⚙️   Preferences for ${userId}:`);
      const hasPref = Object.keys(PREF_KEYS).some((k) => preferences[k]);
      if (!hasPref) {
        console.log("   (none set)");
      } else {
        for (const [k, label] of Object.entries(PREF_KEYS)) {
          if (preferences[k]) {
            const val = Array.isArray(preferences[k])
              ? preferences[k].join(", ")
              : preferences[k];
            console.log(`   • ${label}: ${val}`);
          }
        }
      }
      console.log(`\n  prefs set <key> <value>  — set a preference`);
      console.log(`  prefs clear              — remove all preferences`);
      console.log(`  Keys: ${Object.keys(PREF_KEYS).join(", ")}\n`);
      rl.prompt();
      return;
    }

    // ── history ──
    if (cmd === "history") {
      const full = await mem.loadAllMemory(userId);
      const { profile, episodes, narrative, preferences: savedPrefs } = full;
      const turnCount = Math.floor((full.shortTerm?.length || 0) / 2);

      console.log(`\n📝  Memory Summary for ${userId}:`);
      console.log(`   • Conversation turns this session: ${turnCount}`);

      // Profile highlights
      if (profile?.mood_patterns?.length) {
        console.log(`   • Mood patterns: ${profile.mood_patterns.join(", ")}`);
      }
      if (profile?.triggers?.length) {
        console.log(`   • Triggers: ${profile.triggers.join(", ")}`);
      }
      if (profile?.recurring_themes?.length) {
        console.log(`   • Recurring themes: ${profile.recurring_themes.join(", ")}`);
      }
      if (profile?.communication_style) {
        console.log(`   • Communication style: ${profile.communication_style}`);
      }

      // Significant episodes
      if (episodes && episodes.length > 0) {
        console.log(`\n📌  Significant Episodes (${episodes.length} total):`);
        for (const ep of episodes) {
          const line = `   • ${ep.date} — ${ep.summary} (felt: ${ep.emotion})`;
          console.log(line);
          if (ep.context) console.log(`       Context: ${ep.context}`);
        }
      } else {
        console.log(`   • No significant episodes recorded yet.`);
      }

      // Longitudinal narrative
      if (narrative && narrative.trim().length > 0) {
        console.log(`\n🧵  Longitudinal Narrative:`);
        console.log(`   ${narrative.trim().replace(/\n/g, "\n   ")}`);
      } else {
        console.log(`\n   • Longitudinal narrative not yet built.`);
      }

      // Preferences including challenges
      const prefEntries = Object.entries(savedPrefs || {}).filter(([, v]) => v !== undefined && v !== null && v !== "");
      if (prefEntries.length > 0) {
        console.log(`\n⚙️  Preferences:`);
        for (const [k, v] of prefEntries) {
          const label = PREF_KEYS[k] || k;
          const display = Array.isArray(v) ? v.join(", ") : v;
          console.log(`   • ${label}: ${display}`);
        }
      }

      console.log();
      rl.prompt();
      return;
    }

    // ── Normal message ──
    try {
      messages = await chat(userId, messages, userInput, enrichedSystemPrompt);
    } catch (err) {
      console.error("\n⚠️  Error communicating with the AI:", err.message, "\n");
    }

    rl.prompt();
  });

  rl.on("close", async () => {
    if (sessionMessageCount > 0) {
      await runProfileUpdate(userId, messages).catch(() => {});
    }
    await Promise.allSettled([mem.disconnect(), mongo.disconnect()]);
    console.log("\nGoodbye! 💙\n");
  });

  process.on("SIGINT", async () => {
    if (sessionMessageCount > 0) {
      await runProfileUpdate(userId, messages).catch(() => {});
    }
    await Promise.allSettled([mem.disconnect(), mongo.disconnect()]);
    process.exit(0);
  });
}

main();
