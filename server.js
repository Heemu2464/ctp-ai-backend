import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { AzureOpenAI } from "openai";

dotenv.config();

const app = express();
const allowedOrigins = (process.env.FRONTEND_URL || "http://localhost:5173")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(cors({
  origin: allowedOrigins,
  credentials: true
}));
app.use(express.json());

const PORT = process.env.PORT || 5000;

const client = new AzureOpenAI({
  apiKey:     process.env.MB_GENAI_API_KEY,
  apiVersion: process.env.MB_GENAI_API_VERSION,
  endpoint:   process.env.MB_GENAI_ENDPOINT
});

// ─────────────────────────────────────────────────────────────
// Structured Senior BTV Planner Advisor Prompt (Step 6.2.d)
// ─────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = [
  "You are the AI Planning Advisor inside the BTV AI Planner tool, internally identified as Mission 865.",
  "You act as a senior BTV component timing planner at Mercedes-AMG in the AMG Chassis Team,",
  "with over 20 years of experience in component development planning, tooling risk analysis,",
  "sampling strategy, PPAP readiness, and supplier maturity assessment.",
  "",
  "You will be given a component timing plan as JSON in the user message.",
  "You must analyse it and return advisory feedback as strict JSON only.",
  "",
  "Return exactly one JSON object with the following schema and nothing else:",
  "{",
  "  \"overallRisk\": \"Green | Yellow | Red\",",
  "  \"summary\": \"short paragraph, 2-4 sentences\",",
  "  \"sequencingAndToolingRisk\": [\"bullet 1\", \"bullet 2\", \"bullet 3\"],",
  "  \"ppapAndSamplingDeviationRisk\": [\"bullet 1\", \"bullet 2\", \"bullet 3\"],",
  "  \"recommendation\": [\"action 1\", \"action 2\", \"action 3\"]",
  "}",
  "",
  "Hard rules for the response:",
  "- The response must contain only a single valid JSON object.",
  "- No markdown. No code fences. No asterisks. No headings.",
  "- No prose before or after the JSON.",
  "- No apologies, no disclaimers, no meta commentary.",
  "- Every field must always be present.",
  "- Bullet arrays must contain 2 to 5 items.",
  "- Never invent facts that are not in the plan JSON.",
  "- Never mention vehicles, customers, personal data, or confidential Mercedes topics.",
  "- Do not disclose that you are an AI.",
  "- Use precise engineering language of an internal Mercedes-AMG BTV senior planner.",
  "- Consider brake hoses as safety-relevant and always assess sampling deviation risk carefully.",
  "- Consider build sequencing, ESWFT vs first build after E-Build, SWFT vs next build after ESWFT,",
  "  W-Release timing, and PPAP vs Pro-1 relationship.",
  "- You will be given the current date. Treat it as today's date.",
  "- Milestones and builds that are entirely in the past are history. Do not flag them as risk.",
  "- Structural violations (for example W-Release before Proto Parts, or PPAP after Pro1) must still be flagged if they involve any future build.",
  "- If every build and milestone is in the past, respond gracefully. Set overallRisk to Green and summary to 'Plan Fully Complete — all milestones and builds are in the past.' No critical items.",
  "- overallRisk must reflect the worst risk area:",
  "    Green  = plan is realistic and healthy.",
  "    Yellow = plan is possible but tight or has notable concerns.",
  "    Red    = plan is not realistic or has critical sequencing / PPAP problems."
].join("\n");

// ─────────────────────────────────────────────────────────────
// Concierge Chat Prompt (Step 6.3.d)
// ─────────────────────────────────────────────────────────────
const CHAT_SYSTEM_PROMPT = [
  "You are the AI concierge inside the BTV AI Planner tool, internally identified as Mission 865.",
  "You act as a senior BTV component timing planner assistant at Mercedes-AMG.",
  "You have over 20 years of experience in component development planning, tooling risk,",
  "sampling strategy, PPAP readiness, and supplier maturity.",
  "",
  "You are the concierge AI inside an internal planning tool used by BTV engineers.",
  "You are given:",
  "  - The full list of all plans in the tool (allPlans)",
  "  - The currently selected plan JSON (currentPlan), which may be null",
  "  - The most recent chat messages (messages)",
  "",
  "You must always answer as a real Mercedes-AMG BTV senior planner in a calm,",
  "precise, engineering-professional tone. No markdown, no code fences, no asterisks,",
  "no emojis. Use short paragraphs and clean bullet points using '-' when useful.",
  "You never disclose that you are an AI.",
  "You never invent facts that are not in the provided plan data.",
  "",
  "You must always return exactly one JSON object with the following schema and nothing else:",
  "{",
  "  \"reply\": \"your natural language answer to the engineer\",",
  "  \"intent\": {",
  "    \"type\": \"none | open_plan | save_chat_to_plan | switch_plan_no_open\",",
  "    \"targetCarline\": \"string or empty\",",
  "    \"targetCommodity\": \"string or empty\"",
  "  }",
  "}",
  "",
  "How to choose intent.type:",
  "- Use 'open_plan' if the engineer clearly wants to open, view, or work on a different plan.",
  "  Examples: 'open V267', 'show me V267 brake hose', 'let me see W465'.",
  "- Use 'switch_plan_no_open' if the engineer wants to discuss another plan in chat but",
  "  does not want to leave the current page.",
  "  Examples: 'let us talk about V267 for a moment', 'switch chat to X192 without opening it'.",
  "- Use 'save_chat_to_plan' if the engineer explicitly asks to save the conversation to a plan.",
  "  Examples: 'save this discussion to X192', 'store this chat under V267'.",
  "- Otherwise use 'none'. Most messages are 'none'.",
  "",
  "You will be given today's date. Always treat it as the real current date when reasoning about builds, milestones, and plan history.",
  "Milestones and builds that are entirely in the past should be treated as history. Do not warn about them and do not describe them as risk.",
  "Structural violations (for example W-Release before Proto Parts, or PPAP after Pro1) should still be explained if they involve any future build.",
  "If a plan is fully in the past, answer gracefully. Do not raise alarms. Confirm that the plan is fully complete and offer to help with a different carline or commodity.",
  "",
  "Hard rules for intents:",
  "- Only choose 'open_plan', 'switch_plan_no_open', or 'save_chat_to_plan' if the target",
  "  carline actually exists in allPlans. If the carline does not exist, use intent.type 'none'",
  "  and politely tell the engineer that no plan with that carline is available yet.",
  "- If commodity is not clear, prefer 'Brake Hose' if it exists for that carline, else the",
  "  first commodity available. Leave empty only if you truly cannot decide.",
  "- Never fabricate a plan.",
  "",
  "Hard rules for reply:",
  "- Keep it under 250 words.",
  "- Reference exact carlines, commodities, or milestones from the provided plan data.",
  "- Never contradict the intent. If intent is 'open_plan V267', reply must confirm you are",
  "  opening V267 (or similar phrasing).",
  "- Do not repeat raw JSON in the reply."
].join("\n");

const MILESTONE_SYSTEM_PROMPT = [
  "You are a senior BTV component timing planner at Mercedes-AMG in the AMG Chassis Team.",
  "You are the AI Optimizer inside the BTV AI Planner tool, internally identified as Mission 865.",
  "",
  "You will be given a BTV component development plan as JSON in the user message.",
  "Your task is to propose a REFINED milestone plan that respects real-world engineering constraints.",
  "You do not replace the rule engine — you offer professional judgment on top of it.",
  "",
  "Return exactly one JSON object with the following schema and nothing else:",
  "",
  "{",
  "  \"aiMilestones\": {",
  "    \"supplierNomination\": { \"plannedDate\": \"YYYY-MM-DD\", \"reason\": \"short reason\" },",
  "    \"pDesignFreeze\":      { \"plannedDate\": \"YYYY-MM-DD\", \"reason\": \"short reason\" },",
  "    \"pRelease\":           { \"plannedDate\": \"YYYY-MM-DD\", \"reason\": \"short reason\" },",
  "    \"protoToolStart\":     { \"plannedDate\": \"YYYY-MM-DD\", \"reason\": \"short reason\" },",
  "    \"protoParts\":         { \"plannedDate\": \"YYYY-MM-DD\", \"reason\": \"short reason\" },",
  "    \"wDesignFreeze\":      { \"plannedDate\": \"YYYY-MM-DD\", \"reason\": \"short reason\" },",
  "    \"wRelease\":           { \"plannedDate\": \"YYYY-MM-DD\", \"reason\": \"short reason\" },",
  "    \"seriesToolStart\":    { \"plannedDate\": \"YYYY-MM-DD\", \"reason\": \"short reason\" },",
  "    \"eswft\":              { \"plannedDate\": \"YYYY-MM-DD\", \"reason\": \"short reason\" },",
  "    \"blankDesignFreeze\":  { \"plannedDate\": \"YYYY-MM-DD\", \"reason\": \"short reason\" },",
  "    \"blankRelease\":       { \"plannedDate\": \"YYYY-MM-DD\", \"reason\": \"short reason\" },",
  "    \"swft\":               { \"plannedDate\": \"YYYY-MM-DD\", \"reason\": \"short reason\" },",
  "    \"ppap\":               { \"plannedDate\": \"YYYY-MM-DD\", \"reason\": \"short reason\" }",
  "  },",
  "  \"overallCommentary\": \"One or two sentences summarising your refinement approach.\"",
  "}",
  "",
  "Hard rules:",
  "- Response must be a single valid JSON object.",
  "- No markdown. No code fences. No prose outside JSON.",
  "- No apologies. No hedging.",
  "- Every milestone key listed above must appear.",
  "- All dates must be valid YYYY-MM-DD.",
  "- Never place a milestone before its rule-based dependency.",
  "  Strict sequencing rules you MUST enforce:",
  "  1. pDesignFreeze must be exactly 2 weeks BEFORE P-Release.",
  "  2. wDesignFreeze must be exactly 2 weeks BEFORE W-Release.",
  "  3. blankDesignFreeze must be exactly 2 weeks BEFORE Blank Release.",
  "  4. W-Release must be at least 8 weeks AFTER Proto Parts.",
  "     Reason: engineers need to receive, fit, and test proto parts before design can be frozen.",
  "     Same-date or less than 8 weeks gap is invalid — push W-Release (and wDesignFreeze) forward if needed.",
  "  5. Series Tool Start must be at least 2 weeks after W-Release.",
  "  6. ESWFT must be after Series Tool Start by the tooling lead time (~30 weeks for Brake Hose).",
  "  7. PPAP must be before Pro1 build start.",
  "- PPAP must be scheduled before Pro1 build start.",
  "- Milestones for builds already in the past should retain their existing plannedDate.",
  "- Never fabricate carline names, supplier names, or vehicle details.",
  "- Reasons must be short (max 15 words) and specific.",
  "- The plan JSON includes builds, commodity, milestones, and health insights.",
  "  Use them all to justify your refinements.",
  "- Consider brake hose safety relevance for sampling deviation risk.",
  "- Consider tooling risk when refining Series Tool Start or ESWFT.",
  "- If a rule-based date is already realistic, keep it. Do not force changes.",
  "- The plan JSON may include aiSource and milestonesForAI.",
  "  If aiSource is 'rule', optimise from the rule-based milestones (plan.milestones).",
  "  If aiSource is 'myPlan', optimise from the engineer-owned My Plan milestones (plan.milestonesForAI).",
  "  When milestonesForAI is present, treat it as the primary baseline for all date calculations.",
  "- Never disclose that you are an AI.",
  "- Never refer to Mission 865 or the tool name in the reasons.",
  "- Keep overallCommentary under 200 characters."
].join("\n");

// ─────────────────────────────────────────────────────────────
// Utility — safely parse the model output as JSON
// ─────────────────────────────────────────────────────────────
function safeParseAIResponse(raw) {
  if (!raw || typeof raw !== "string") return null;

  let text = raw.trim();

  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  }

  try {
    return JSON.parse(text);
  } catch (_e) {
    // continue
  }

  const first = text.indexOf("{");
  const last  = text.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) {
    const candidate = text.slice(first, last + 1);
    try {
      return JSON.parse(candidate);
    } catch (_e2) {
      return null;
    }
  }

  return null;
}

function safeParseAIMilestones(raw) {
  if (!raw || typeof raw !== "string") return null;
  let text = raw.trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  }
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    const first = text.indexOf("{");
    const last  = text.lastIndexOf("}");
    if (first !== -1 && last !== -1 && last > first) {
      try { parsed = JSON.parse(text.slice(first, last + 1)); } catch { return null; }
    }
  }
  if (!parsed || typeof parsed !== "object") return null;
  if (!parsed.aiMilestones || typeof parsed.aiMilestones !== "object") return null;
  const expectedKeys = [
    "supplierNomination","pDesignFreeze","pRelease","protoToolStart","protoParts",
    "wDesignFreeze","wRelease","seriesToolStart","eswft","blankDesignFreeze","blankRelease","swft","ppap"
  ];
  // Allow missing design freeze keys from AI — we will compute them below if absent
  const requiredKeys = [
    "supplierNomination","pRelease","protoToolStart","protoParts",
    "wRelease","seriesToolStart","eswft","blankRelease","swft","ppap"
  ];
  for (const key of requiredKeys) {
    const m = parsed.aiMilestones[key];
    if (!m || typeof m !== "object" || typeof m.plannedDate !== "string") return null;
  }

  const ms = parsed.aiMilestones;

  // Guardrail 1: W-Release must be at least 8 weeks after Proto Parts
  const protoPartsDate = ms.protoParts?.plannedDate;
  const wReleaseDate   = ms.wRelease?.plannedDate;
  if (protoPartsDate && wReleaseDate) {
    const protoPartsMs = new Date(protoPartsDate).getTime();
    const wReleaseMs   = new Date(wReleaseDate).getTime();
    const gapWeeks     = (wReleaseMs - protoPartsMs) / (1000 * 60 * 60 * 24 * 7);
    if (gapWeeks < 8) {
      const corrected = new Date(protoPartsMs + 8 * 7 * 24 * 60 * 60 * 1000);
      ms.wRelease.plannedDate = corrected.toISOString().slice(0, 10);
      const seriesToolDate = ms.seriesToolStart?.plannedDate;
      if (seriesToolDate) {
        const minStMs = corrected.getTime() + 2 * 7 * 24 * 60 * 60 * 1000;
        if (new Date(seriesToolDate).getTime() < minStMs) {
          ms.seriesToolStart.plannedDate = new Date(minStMs).toISOString().slice(0, 10);
        }
      }
    }
  }

  // Guardrail 2: Design Freeze milestones = Release date − 2 weeks (enforce regardless of AI output)
  function twoWeeksBefore(dateStr) {
    if (!dateStr) return null;
    return new Date(new Date(dateStr).getTime() - 2 * 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  }
  if (ms.pRelease?.plannedDate) {
    if (!ms.pDesignFreeze) ms.pDesignFreeze = {};
    ms.pDesignFreeze.plannedDate = twoWeeksBefore(ms.pRelease.plannedDate);
    ms.pDesignFreeze.reason = ms.pDesignFreeze.reason || "2 weeks before P-Release";
  }
  if (ms.wRelease?.plannedDate) {
    if (!ms.wDesignFreeze) ms.wDesignFreeze = {};
    ms.wDesignFreeze.plannedDate = twoWeeksBefore(ms.wRelease.plannedDate);
    ms.wDesignFreeze.reason = ms.wDesignFreeze.reason || "2 weeks before W-Release";
  }
  if (ms.blankRelease?.plannedDate) {
    if (!ms.blankDesignFreeze) ms.blankDesignFreeze = {};
    ms.blankDesignFreeze.plannedDate = twoWeeksBefore(ms.blankRelease.plannedDate);
    ms.blankDesignFreeze.reason = ms.blankDesignFreeze.reason || "2 weeks before Blank Release";
  }

  return {
    aiMilestones: ms,
    overallCommentary: typeof parsed.overallCommentary === "string"
      ? parsed.overallCommentary.trim()
      : ""
  };
}

// ─────────────────────────────────────────────────────────────
// Health check
// ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "CTP AI Backend is running" });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// ─────────────────────────────────────────────────────────────
// AI advisory endpoint
// ─────────────────────────────────────────────────────────────
app.post("/ai-advice", async (req, res) => {
  try {
    const plan = req.body;

    if (!plan || !plan.carline) {
      return res.status(400).json({ error: "Invalid plan payload" });
    }

    // Determine which lanes are visible so the AI scopes its analysis accordingly
    const vl = plan._visibleLanes || {};
    const visibleLaneNames = [
      vl.buildPlan     && "Build Plan",
      vl.btvRule       && "BTV Milestones (Rule)",
      vl.btvMyPlan     && "My Plan (custom milestones)",
      vl.aiOptimized   && "AI Optimized Plan",
      vl.subActivities && "Sub-Activities"
    ].filter(Boolean);

    const laneScope = visibleLaneNames.length > 0
      ? `You must only analyse the data from the following visible timeline lanes: ${visibleLaneNames.join(", ")}. ` +
        `Ignore any data in the payload that belongs to hidden lanes. ` +
        `If a lane is listed as visible but its data is empty, state that it contains no data rather than flagging it as a risk.`
      : "No timeline lanes are currently visible. Advise the engineer to select at least one lane to get meaningful feedback.";

    // Strip internal UI field before sending to AI
    const { _visibleLanes, ...planForAI } = plan;

    const completion = await client.chat.completions.create({
      model: process.env.MB_GENAI_MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content:
            "Today's date is " + new Date().toISOString().slice(0, 10) + ".\n\n" +
            laneScope + "\n\n" +
            "Analyze the following component timing plan and return only the JSON object " +
            "in the required schema. No prose, no markdown, no code fences.\n\n" +
            "Plan JSON:\n" +
            JSON.stringify(planForAI)
        }
      ]
    });

    const rawContent = completion.choices?.[0]?.message?.content || "";
    const parsed     = safeParseAIResponse(rawContent);

    if (!parsed) {
      console.warn("Unparseable advisory output:", rawContent);
      return res.status(200).json({
        ok:    false,
        error: "AI returned unstructured content. Try again."
      });
    }

    const advisory = {
      overallRisk: parsed.overallRisk || "Yellow",
      summary:     parsed.summary     || "",
      sequencingAndToolingRisk:      Array.isArray(parsed.sequencingAndToolingRisk)      ? parsed.sequencingAndToolingRisk      : [],
      ppapAndSamplingDeviationRisk:  Array.isArray(parsed.ppapAndSamplingDeviationRisk)  ? parsed.ppapAndSamplingDeviationRisk  : [],
      recommendation:                Array.isArray(parsed.recommendation)                ? parsed.recommendation                : []
    };

    return res.json({ ok: true, advisory });

  } catch (err) {
    console.error("AI advice error:", err);
    return res.status(500).json({
      ok: false,
      error: err.message || "AI request failed"
    });
  }
});

// ─────────────────────────────────────────────────────────────
// AI chat endpoint (Step 6.3.d)
// ─────────────────────────────────────────────────────────────
app.post("/ai-chat", async (req, res) => {
  try {
    const { messages, currentPlan, allPlans } = req.body || {};

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "messages array is required" });
    }

    const safeAllPlans = Array.isArray(allPlans) ? allPlans : [];
    const knownCarlines = safeAllPlans
      .map((p) => (p && p.carline ? String(p.carline) : ""))
      .filter(Boolean);

    const contextMessages = [
      { role: "system", content: CHAT_SYSTEM_PROMPT }
    ];

    contextMessages.push({
      role: "system",
      content:
        "Today's date is " + new Date().toISOString().slice(0, 10) + ". " +
        "Use this as the authoritative current date whenever you reason about time."
    });

    contextMessages.push({
      role: "system",
      content:
        "Here is the full list of plans currently in the tool (allPlans). " +
        "Use it as the authoritative source of which carlines exist and their commodities. " +
        "Do not fabricate any plan not in this list.\n\n" +
        "Known carlines: " + JSON.stringify(knownCarlines) + "\n\n" +
        "allPlans JSON:\n" +
        JSON.stringify(safeAllPlans)
    });

    if (currentPlan && typeof currentPlan === "object") {
      contextMessages.push({
        role: "system",
        content:
          "This is the currently selected plan the engineer is looking at (currentPlan). " +
          "Prefer this plan when the question does not clearly reference another carline.\n\n" +
          JSON.stringify(currentPlan)
      });
    } else {
      contextMessages.push({
        role: "system",
        content:
          "No specific plan is currently selected. If the engineer asks about a specific " +
          "carline, use allPlans to answer."
      });
    }

    for (const m of messages) {
      if (!m || typeof m !== "object") continue;
      if (m.role === "user" || m.role === "assistant") {
        contextMessages.push({
          role: m.role,
          content: String(m.content || "")
        });
      }
    }

    const completion = await client.chat.completions.create({
      model: process.env.MB_GENAI_MODEL,
      messages: contextMessages
    });

    const raw    = completion.choices?.[0]?.message?.content || "";
    const parsed = safeParseAIResponse(raw);

    if (!parsed) {
      console.warn("Unparseable chat output:", raw);
      return res.status(200).json({
        ok:     true,
        reply:  raw && raw.trim().length ? raw : "I could not generate a structured response. Please try again.",
        intent: { type: "none", targetCarline: "", targetCommodity: "" }
      });
    }

    const reply  = typeof parsed.reply === "string" && parsed.reply.trim()
      ? parsed.reply.trim()
      : "I could not generate a response. Please try again.";

    let intent = {
      type:            "none",
      targetCarline:   "",
      targetCommodity: ""
    };

    if (parsed.intent && typeof parsed.intent === "object") {
      const t = parsed.intent.type;
      if (t === "open_plan" || t === "switch_plan_no_open" || t === "save_chat_to_plan" || t === "none") {
        intent = {
          type:            t,
          targetCarline:   typeof parsed.intent.targetCarline   === "string" ? parsed.intent.targetCarline.trim()   : "",
          targetCommodity: typeof parsed.intent.targetCommodity === "string" ? parsed.intent.targetCommodity.trim() : ""
        };
      }
    }

    // Backend-side guardrail: only accept intents whose targetCarline actually exists
    if (intent.type !== "none") {
      const exists = knownCarlines.some(
        (c) => c.toLowerCase() === intent.targetCarline.toLowerCase()
      );
      if (!exists) {
        intent = { type: "none", targetCarline: "", targetCommodity: "" };
      }
    }

    return res.json({
      ok:     true,
      reply,
      intent
    });

  } catch (err) {
    console.error("AI chat error:", err);
    return res.status(500).json({
      ok: false,
      error: err.message || "AI chat request failed"
    });
  }
});

// Phase 4 Sub-step 4F.1 — AI-suggested milestones
app.post("/ai-milestones", async (req, res) => {
  try {
    const { plan } = req.body || {};
    if (!plan || !plan.carline) {
      return res.status(400).json({ error: "Invalid plan payload" });
    }
    const completion = await client.chat.completions.create({
      model: process.env.MB_GENAI_MODEL,
      messages: [
        { role: "system", content: MILESTONE_SYSTEM_PROMPT },
        {
          role: "user",
          content:
            "Today's date is " + new Date().toISOString().slice(0, 10) + ".\n\n" +
            "Propose an AI-refined milestone plan for this component timing plan. " +
            "The input plan includes aiSource and milestonesForAI. " +
            "If aiSource is 'rule', use the rule-based milestone plan as the baseline. " +
            "If aiSource is 'myPlan', use the engineer's My Plan milestones (milestonesForAI) as the baseline. " +
            "Use milestonesForAI as the primary baseline for optimisation when present. " +
            "Return only the JSON object in the required schema. " +
            "No prose, no markdown.\n\n" +
            "Plan JSON:\n" +
            JSON.stringify(plan)
        }
      ]
    });
    const raw    = completion.choices?.[0]?.message?.content || "";
    const parsed = safeParseAIMilestones(raw);
    if (!parsed) {
      console.warn("Unparseable AI milestones output:", raw);
      return res.status(200).json({
        ok: false,
        error: "AI failed to generate valid milestone plan. Try again."
      });
    }
    return res.json({
      ok: true,
      aiMilestones: parsed.aiMilestones,
      overallCommentary: parsed.overallCommentary
    });
  } catch (err) {
    console.error("AI milestones error:", err);
    return res.status(500).json({
      ok: false,
      error: err.message || "AI milestones request failed"
    });
  }
});

process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err);
});

app.listen(PORT, () => {
  console.log("CTP AI Backend running on http://localhost:" + PORT);
});