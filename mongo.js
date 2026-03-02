/**
 * mongo.js
 * MongoDB persistence layer for Sage mental health chatbot.
 *
 * Mirrors the same 4 memory layers as memory.js (Redis), acting as a
 * durable long-term store. Redis is the fast in-session cache;
 * MongoDB survives Redis restarts and flushes.
 *
 * Collection: sage_chatbot.users
 * One document per user:
 * {
 *   _id:         string   (userId)
 *   shortTerm:   [{ role, content }, ...]   max 40 entries, oldest-first
 *   profile:     { mood_patterns, triggers, coping_strategies, recurring_themes, communication_style }
 *   episodes:    [{ date, summary, emotion, context }, ...]  max 50, oldest-first
 *   narrative:   string
 *   preferences: { name, pronouns, style, avoid, exercises }
 *   createdAt:   Date
 *   updatedAt:   Date
 * }
 */

import { MongoClient } from "mongodb";

// ── Module state ──────────────────────────────────────────────────────────────

let mongoClient = null;
let db = null;
let users = null; // collection handle

const DB_NAME = "sage_chatbot";
const COLLECTION = "users";
const SHORT_TERM_MAX = 40;
const EPISODES_MAX = 50;

// ── Connection ────────────────────────────────────────────────────────────────

export async function connect() {
  mongoClient = new MongoClient(
    process.env.MONGO_URL || "mongodb://localhost:27017"
  );
  await mongoClient.connect();
  db = mongoClient.db(DB_NAME);
  users = db.collection(COLLECTION);

  // Sparse index on _id is automatic; add updatedAt index for future queries
  await users.createIndex({ updatedAt: -1 }, { background: true });
}

export async function disconnect() {
  if (mongoClient) {
    await mongoClient.close();
  }
}

// ── Guard ─────────────────────────────────────────────────────────────────────

function requireConnection() {
  if (!users) throw new Error("MongoDB not connected");
}

// ── Load all 5 layers ─────────────────────────────────────────────────────────

export async function loadAllMemory(userId) {
  try {
    requireConnection();
    const doc = await users.findOne({ _id: userId });
    if (!doc) {
      return { shortTerm: [], profile: null, episodes: [], narrative: "", preferences: {} };
    }
    return {
      shortTerm: doc.shortTerm || [],
      profile: doc.profile || null,
      episodes: doc.episodes || [],
      narrative: doc.narrative || "",
      preferences: doc.preferences || {},
    };
  } catch {
    return { shortTerm: [], profile: null, episodes: [], narrative: "", preferences: {} };
  }
}

// ── Short-term conversation ───────────────────────────────────────────────────

export async function appendMessage(userId, role, content) {
  try {
    requireConnection();
    await users.updateOne(
      { _id: userId },
      {
        $push: {
          shortTerm: {
            $each: [{ role, content }],
            $slice: -SHORT_TERM_MAX, // keep newest 40 (slice from tail)
          },
        },
        $setOnInsert: { createdAt: new Date() },
        $set: { updatedAt: new Date() },
      },
      { upsert: true }
    );
  } catch (err) {
    console.warn("⚠️  MongoDB: could not append message:", err.message);
  }
}

export async function clearShortTerm(userId) {
  try {
    requireConnection();
    await users.updateOne(
      { _id: userId },
      { $set: { shortTerm: [], updatedAt: new Date() } }
    );
  } catch (err) {
    console.warn("⚠️  MongoDB: could not clear short-term:", err.message);
  }
}

// ── Full reset ────────────────────────────────────────────────────────────────

export async function clearAllMemory(userId) {
  try {
    requireConnection();
    await users.deleteOne({ _id: userId });
  } catch (err) {
    console.warn("⚠️  MongoDB: could not clear all memory:", err.message);
  }
}

// ── Profile / episodes / narrative update ─────────────────────────────────────

export async function saveProfileUpdate(userId, data) {
  try {
    requireConnection();

    const setFields = { updatedAt: new Date() };
    const updateOp = { $set: setFields };

    if (data.profile) {
      setFields.profile = data.profile;
    }
    if (data.narrative) {
      setFields.narrative = data.narrative;
    }
    if (Array.isArray(data.new_episodes) && data.new_episodes.length > 0) {
      updateOp.$push = {
        episodes: {
          $each: data.new_episodes,
          $slice: -EPISODES_MAX,
        },
      };
    }

    await users.updateOne({ _id: userId }, updateOp, { upsert: true });
  } catch (err) {
    console.warn("⚠️  MongoDB: could not save profile update:", err.message);
  }
}

// ── User preferences ──────────────────────────────────────────────────────────

export async function getPreferences(userId) {
  try {
    requireConnection();
    const doc = await users.findOne(
      { _id: userId },
      { projection: { preferences: 1 } }
    );
    return doc?.preferences || {};
  } catch {
    return {};
  }
}

export async function setPreference(userId, prefKey, value) {
  try {
    requireConnection();
    await users.updateOne(
      { _id: userId },
      {
        $set: { [`preferences.${prefKey}`]: value, updatedAt: new Date() },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true }
    );
  } catch (err) {
    console.warn("⚠️  MongoDB: could not set preference:", err.message);
  }
}

export async function clearPreferences(userId) {
  try {
    requireConnection();
    await users.updateOne(
      { _id: userId },
      { $unset: { preferences: "" }, $set: { updatedAt: new Date() } }
    );
  } catch (err) {
    console.warn("⚠️  MongoDB: could not clear preferences:", err.message);
  }
}

// ── Summary (mirrors memory.js getMemorySummary) ──────────────────────────────

export async function getMemorySummary(userId) {
  try {
    requireConnection();
    const doc = await users.findOne(
      { _id: userId },
      { projection: { shortTerm: 1, profile: 1, episodes: 1, narrative: 1 } }
    );
    if (!doc) {
      return { turnCount: 0, profile: null, episodeCount: 0, hasNarrative: false };
    }
    return {
      turnCount: Math.floor((doc.shortTerm?.length || 0) / 2),
      profile: doc.profile || null,
      episodeCount: doc.episodes?.length || 0,
      hasNarrative: !!(doc.narrative),
    };
  } catch {
    return { turnCount: 0, profile: null, episodeCount: 0, hasNarrative: false };
  }
}
