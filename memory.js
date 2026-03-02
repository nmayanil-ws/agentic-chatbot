/**
 * memory.js
 * Redis-backed 5-layer memory for Sage mental health chatbot.
 *
 * Layers per user (keyed sage:{userId}:*):
 *   short_term   — List  — last 40 messages (20 pairs), newest-first
 *   profile      — String (JSON) — structured psychological profile
 *   episodes     — List  — significant events, newest-first, max 50
 *   narrative    — String — longitudinal summary paragraph
 *   preferences  — String (JSON) — explicit user preferences (name, pronouns, style, etc.)
 */

import { createClient } from "redis";

// ── Module state ──────────────────────────────────────────────────────────────

let redisClient = null;

const SHORT_TERM_MAX = 40; // 20 user/assistant pairs
const EPISODES_MAX = 50;

// ── Internal helpers ──────────────────────────────────────────────────────────

function requireClient() {
  if (!redisClient || !redisClient.isOpen) {
    throw new Error("Redis client is not connected");
  }
}

function key(userId, layer) {
  return `sage:${userId}:${layer}`;
}

// ── Connection ────────────────────────────────────────────────────────────────

export async function connect() {
  redisClient = createClient({
    url: process.env.REDIS_URL || "redis://localhost:6379",
  });

  redisClient.on("error", (err) => {
    console.warn("⚠️  Redis error:", err.message);
  });

  await redisClient.connect();
}

export async function disconnect() {
  if (redisClient && redisClient.isOpen) {
    await redisClient.quit();
  }
}

// ── Load all 5 layers ─────────────────────────────────────────────────────────

export async function loadAllMemory(userId) {
  try {
    requireClient();

    const [rawMessages, rawProfile, rawEpisodes, narrative, rawPreferences] =
      await Promise.all([
        redisClient.lRange(key(userId, "short_term"), 0, -1),
        redisClient.get(key(userId, "profile")),
        redisClient.lRange(key(userId, "episodes"), 0, -1),
        redisClient.get(key(userId, "narrative")),
        redisClient.get(key(userId, "preferences")),
      ]);

    // Lists are newest-first (LPUSH); reverse to get chronological order
    const shortTerm = rawMessages.reverse().map((m) => JSON.parse(m));
    const episodes = rawEpisodes.reverse().map((e) => JSON.parse(e));
    const profile = rawProfile ? JSON.parse(rawProfile) : null;
    const preferences = rawPreferences ? JSON.parse(rawPreferences) : {};

    return { shortTerm, profile, episodes, narrative: narrative || "", preferences };
  } catch {
    return { shortTerm: [], profile: null, episodes: [], narrative: "", preferences: {} };
  }
}

// ── Short-term conversation ───────────────────────────────────────────────────

export async function appendMessage(userId, role, content) {
  try {
    requireClient();
    const k = key(userId, "short_term");
    await redisClient.lPush(k, JSON.stringify({ role, content }));
    await redisClient.lTrim(k, 0, SHORT_TERM_MAX - 1);
  } catch (err) {
    console.warn("⚠️  Could not append message to Redis:", err.message);
  }
}

export async function getShortTerm(userId) {
  try {
    requireClient();
    const raw = await redisClient.lRange(key(userId, "short_term"), 0, -1);
    return raw.reverse().map((m) => JSON.parse(m));
  } catch {
    return [];
  }
}

export async function clearShortTerm(userId) {
  try {
    requireClient();
    await redisClient.del(key(userId, "short_term"));
  } catch (err) {
    console.warn("⚠️  Could not clear short-term memory:", err.message);
  }
}

// ── Full reset ────────────────────────────────────────────────────────────────

export async function clearAllMemory(userId) {
  try {
    requireClient();
    await redisClient.del([
      key(userId, "short_term"),
      key(userId, "profile"),
      key(userId, "episodes"),
      key(userId, "narrative"),
      key(userId, "preferences"),
    ]);
  } catch (err) {
    console.warn("⚠️  Could not clear all memory:", err.message);
  }
}

// ── Profile / episodes / narrative update ─────────────────────────────────────

export async function saveProfileUpdate(userId, data) {
  try {
    requireClient();

    const ops = [];

    if (data.profile) {
      ops.push(
        redisClient.set(key(userId, "profile"), JSON.stringify(data.profile))
      );
    }

    if (data.narrative) {
      ops.push(redisClient.set(key(userId, "narrative"), data.narrative));
    }

    await Promise.all(ops);

    // Episodes pushed individually so each gets its own list entry
    if (Array.isArray(data.new_episodes) && data.new_episodes.length > 0) {
      const k = key(userId, "episodes");
      for (const episode of data.new_episodes) {
        await redisClient.lPush(k, JSON.stringify(episode));
      }
      await redisClient.lTrim(k, 0, EPISODES_MAX - 1);
    }
  } catch (err) {
    console.warn("⚠️  Could not save profile update:", err.message);
  }
}

// ── User preferences ──────────────────────────────────────────────────────────

export async function getPreferences(userId) {
  try {
    requireClient();
    const raw = await redisClient.get(key(userId, "preferences"));
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export async function setPreference(userId, prefKey, value) {
  try {
    requireClient();
    const prefs = await getPreferences(userId);
    prefs[prefKey] = value;
    await redisClient.set(key(userId, "preferences"), JSON.stringify(prefs));
    return prefs;
  } catch (err) {
    console.warn("⚠️  Could not set preference:", err.message);
    return {};
  }
}

export async function clearPreferences(userId) {
  try {
    requireClient();
    await redisClient.del(key(userId, "preferences"));
  } catch (err) {
    console.warn("⚠️  Could not clear preferences:", err.message);
  }
}

// ── Summary for `history` command ─────────────────────────────────────────────

export async function getMemorySummary(userId) {
  try {
    requireClient();

    const [shortTermLen, rawProfile, episodesLen, narrative] =
      await Promise.all([
        redisClient.lLen(key(userId, "short_term")),
        redisClient.get(key(userId, "profile")),
        redisClient.lLen(key(userId, "episodes")),
        redisClient.get(key(userId, "narrative")),
      ]);

    return {
      turnCount: Math.floor(shortTermLen / 2),
      profile: rawProfile ? JSON.parse(rawProfile) : null,
      episodeCount: episodesLen,
      hasNarrative: !!narrative,
    };
  } catch {
    return { turnCount: 0, profile: null, episodeCount: 0, hasNarrative: false };
  }
}
