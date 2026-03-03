/**
 * agent.js
 * Agentic framework for Sage — tool definitions, executor, and the agentic
 * loop that transparently intercepts every chat turn so Claude can call tools
 * before giving its final reply.
 */

import * as mem from "./memory.js";
import * as mongo from "./mongo.js";

// ── Tool definitions (Anthropic input_schema format) ──────────────────────────

export const TOOLS = [
  {
    name: "save_important_note",
    description:
      "Save a significant disclosure from this conversation as a remembered episode for future sessions. " +
      "Use this when the user shares something meaningful — a major life event, a breakthrough, " +
      "a fear, or a deeply personal concern — that Sage should remember across sessions.",
    input_schema: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description: "One concise sentence describing the key moment or disclosure",
        },
        emotion: {
          type: "string",
          description: "The primary emotion expressed (e.g. 'grief', 'anxiety', 'relief')",
        },
        context: {
          type: "string",
          description: "Brief context that will help future sessions understand the significance",
        },
      },
      required: ["summary", "emotion", "context"],
    },
  },
  {
    name: "get_coping_exercise",
    description:
      "Retrieve a structured coping exercise to share with the user. " +
      "Use this when the user asks for help calming down, grounding themselves, " +
      "managing anxiety, or wants a practical technique they can try right now.",
    input_schema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["breathing", "grounding", "journaling", "movement", "mindfulness"],
          description: "The type of exercise most appropriate for their current state",
        },
        intensity: {
          type: "string",
          enum: ["gentle", "moderate", "active"],
          description:
            "'gentle' for acute distress, 'moderate' for general anxiety, 'active' for restlessness",
        },
      },
      required: ["type"],
    },
  },
  {
    name: "recall_past_episodes",
    description:
      "Retrieve the user's significant past episodes and profile data to inform the current response. " +
      "Use this when the user references past conversations, asks if you remember something, " +
      "or when knowing their history would meaningfully improve your response.",
    input_schema: {
      type: "object",
      properties: {
        focus: {
          type: "string",
          enum: ["triggers", "coping", "mood", "all"],
          description: "Which aspect of the user's history to surface",
        },
      },
      required: ["focus"],
    },
  },
  {
    name: "find_crisis_resources",
    description:
      "Get crisis support resources to share when the user may be in distress, " +
      "expresses thoughts of self-harm, suicide, abuse, addiction, or any immediate safety concern. " +
      "Always use this if there is any sign of risk to the user or others.",
    input_schema: {
      type: "object",
      properties: {
        concern: {
          type: "string",
          enum: ["suicide", "self-harm", "abuse", "addiction", "general"],
          description: "The type of crisis or concern",
        },
        region: {
          type: "string",
          description: "Country or region (e.g. 'US', 'UK', 'AU'). Defaults to US.",
        },
      },
      required: ["concern"],
    },
  },
];

// Human-readable labels shown during tool execution
const TOOL_LABELS = {
  save_important_note:  "Saving to memory…",
  get_coping_exercise:  "Finding an exercise…",
  recall_past_episodes: "Recalling your history…",
  find_crisis_resources:"Finding crisis support…",
};

// ── Coping exercise library ───────────────────────────────────────────────────

const EXERCISES = {
  breathing: {
    title: "Box Breathing (4-4-4-4)",
    steps: [
      "Sit comfortably and close your eyes if you feel safe to do so.",
      "Breathe in slowly through your nose for 4 counts.",
      "Hold your breath for 4 counts.",
      "Breathe out slowly through your mouth for 4 counts.",
      "Hold for 4 counts before the next breath.",
      "Repeat 4–6 times. Notice how your body feels after each cycle.",
    ],
  },
  grounding: {
    title: "5-4-3-2-1 Grounding",
    steps: [
      "Notice 5 things you can SEE around you right now.",
      "Notice 4 things you can physically TOUCH — feel their texture.",
      "Notice 3 things you can HEAR in this moment.",
      "Notice 2 things you can SMELL (or two scents you enjoy).",
      "Notice 1 thing you can TASTE.",
      "Take a slow breath and notice how you feel now.",
    ],
  },
  journaling: {
    title: "Feelings Check-In Journal",
    steps: [
      "Find a quiet moment and a notebook or notes app.",
      "Write: 'Right now I feel ___' — don't censor yourself.",
      "Write: 'This feeling makes sense because ___'",
      "Write: 'One small thing that might help is ___'",
      "Read back what you wrote without judgment.",
      "Notice if anything shifts — even a little.",
    ],
  },
  movement: {
    title: "Shake It Out (Body Reset)",
    steps: [
      "Stand up if you're able — or stay seated if not.",
      "Gently shake your hands and wrists for 30 seconds.",
      "Roll your shoulders backward 5 times, then forward 5 times.",
      "Turn your head slowly left and right, 3 times each side.",
      "Take 3 deep breaths, dropping your shoulders on each exhale.",
      "Notice any tension that has softened.",
    ],
  },
  mindfulness: {
    title: "One-Minute Mindful Pause",
    steps: [
      "Set a timer for 60 seconds.",
      "Close your eyes or soften your gaze downward.",
      "Breathe naturally — don't try to control it.",
      "Each time a thought appears, gently label it 'thinking' and let it go.",
      "Return your attention to the physical sensation of breathing.",
      "When the timer ends, open your eyes slowly.",
    ],
  },
};

// ── Crisis resources ──────────────────────────────────────────────────────────

const CRISIS_RESOURCES = {
  suicide: {
    headline: "988 Suicide & Crisis Lifeline",
    resources: [
      { name: "988 Suicide & Crisis Lifeline (US)", contact: "Call or text 988", url: "https://988lifeline.org" },
      { name: "Crisis Text Line (US)", contact: "Text HOME to 741741", url: "https://www.crisistextline.org" },
      { name: "International crisis centres", contact: "", url: "https://www.iasp.info/resources/Crisis_Centres/" },
    ],
  },
  "self-harm": {
    headline: "Self-Harm Support",
    resources: [
      { name: "988 Suicide & Crisis Lifeline (US)", contact: "Call or text 988", url: "https://988lifeline.org" },
      { name: "Crisis Text Line (US)", contact: "Text HOME to 741741", url: "https://www.crisistextline.org" },
      { name: "To Write Love on Her Arms", contact: "", url: "https://twloha.com" },
    ],
  },
  abuse: {
    headline: "Abuse & Safety Resources",
    resources: [
      { name: "National Domestic Violence Hotline (US)", contact: "1-800-799-7233 or text START to 88788", url: "https://www.thehotline.org" },
      { name: "RAINN Sexual Assault Hotline (US)", contact: "1-800-656-4673", url: "https://www.rainn.org" },
      { name: "Crisis Text Line (US)", contact: "Text HOME to 741741", url: "https://www.crisistextline.org" },
    ],
  },
  addiction: {
    headline: "Addiction & Recovery Support",
    resources: [
      { name: "SAMHSA National Helpline (US)", contact: "1-800-662-4357 (free, 24/7)", url: "https://www.samhsa.gov/find-help/national-helpline" },
      { name: "Alcoholics Anonymous", contact: "", url: "https://www.aa.org" },
      { name: "Narcotics Anonymous", contact: "", url: "https://www.na.org" },
    ],
  },
  general: {
    headline: "Mental Health Crisis Support",
    resources: [
      { name: "988 Suicide & Crisis Lifeline (US)", contact: "Call or text 988", url: "https://988lifeline.org" },
      { name: "Crisis Text Line (US)", contact: "Text HOME to 741741", url: "https://www.crisistextline.org" },
      { name: "NAMI Helpline (US)", contact: "1-800-950-6264", url: "https://www.nami.org/help" },
    ],
  },
};

// ── Tool executor ─────────────────────────────────────────────────────────────

export async function executeTool(name, input, userId) {
  switch (name) {
    case "save_important_note": {
      const today = new Date().toISOString().split("T")[0];
      const episode = {
        date: today,
        summary: input.summary,
        emotion: input.emotion,
        context: input.context,
      };
      await mem.saveProfileUpdate(userId, { new_episodes: [episode] });
      mongo.saveProfileUpdate(userId, { new_episodes: [episode] });
      return { saved: true, episode };
    }

    case "get_coping_exercise": {
      const exercise = EXERCISES[input.type] ?? EXERCISES.breathing;
      return { ...exercise, type: input.type, intensity: input.intensity ?? "gentle" };
    }

    case "recall_past_episodes": {
      const memory = await mem.loadAllMemory(userId);
      const { episodes, profile, narrative } = memory;
      if (input.focus === "triggers") {
        return { triggers: profile?.triggers ?? [], episodes: episodes.slice(0, 5) };
      }
      if (input.focus === "coping") {
        return { coping_strategies: profile?.coping_strategies ?? [], episodes: episodes.slice(0, 5) };
      }
      if (input.focus === "mood") {
        return { mood_patterns: profile?.mood_patterns ?? [], episodes: episodes.slice(0, 5) };
      }
      return { profile, episodes: episodes.slice(0, 10), narrative };
    }

    case "find_crisis_resources": {
      const concern = input.concern ?? "general";
      return CRISIS_RESOURCES[concern] ?? CRISIS_RESOURCES.general;
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ── Agentic loop ──────────────────────────────────────────────────────────────

/**
 * Runs the agentic chat loop for a single user turn.
 *
 * Instead of a single streaming call, this iterates until Claude reaches
 * `end_turn`, transparently executing any tools it requests along the way.
 *
 * @param {import('@anthropic-ai/sdk').default} client  Anthropic client instance
 * @param {object}   opts
 * @param {string}   opts.userId        User identifier (for tool memory access)
 * @param {Array}    opts.messages      Conversation history (without the new user message)
 * @param {string}   opts.userInput     The user's latest message
 * @param {string}   opts.systemPrompt  Enriched system prompt for this turn
 * @param {Function} opts.onToolCall    Called with (label: string) before each tool runs
 * @param {Function} opts.onText        Called with (text: string) when final reply is ready
 *
 * @returns {{ text: string, messages: Array }}
 *   Final response text + full updated messages array (includes tool turns for
 *   intra-session API coherence; persist only the text turns to Redis/MongoDB).
 */
export async function runAgentLoop(client, { userId, messages, userInput, systemPrompt, onToolCall, onText }) {
  // Seed the loop with the full history plus the new user message
  const loopMessages = [...messages, { role: "user", content: userInput }];
  let finalText = "";
  let iterations = 0;
  const MAX_ITERATIONS = 6;

  while (iterations++ < MAX_ITERATIONS) {
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: systemPrompt,
      tools: TOOLS,
      messages: loopMessages,
    });

    // Append the assistant turn (may contain text and/or tool_use blocks)
    loopMessages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "end_turn") {
      finalText = response.content.find((b) => b.type === "text")?.text ?? "";
      onText(finalText);
      break;
    }

    if (response.stop_reason === "tool_use") {
      const toolUseBlocks = response.content.filter((b) => b.type === "tool_use");
      const toolResults = [];

      for (const block of toolUseBlocks) {
        onToolCall(TOOL_LABELS[block.name] ?? "Working…");
        const result = await executeTool(block.name, block.input, userId);
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify(result),
        });
      }

      // Feed results back as a user turn (required by the Anthropic API)
      loopMessages.push({ role: "user", content: toolResults });
      continue;
    }

    // Unexpected stop reason — emit whatever text exists and stop
    finalText = response.content.find((b) => b.type === "text")?.text ?? "";
    if (finalText) onText(finalText);
    break;
  }

  // Max iterations hit without end_turn — emit a safe fallback
  if (!finalText) {
    finalText = "I'm here with you. Let's continue — what's on your mind?";
    onText(finalText);
  }

  return { text: finalText, messages: loopMessages };
}
