import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import session from "express-session";
import OpenAI, { AzureOpenAI } from "openai";
import multer from "multer";
import { PDFParse } from "pdf-parse";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const allowedOrigins = (process.env.FRONTEND_URL || "http://localhost:5005,http://localhost:5173")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const allowedOriginPorts = new Set(["5005", "5173"]);

app.use(cors({
  // The app is shared over the LAN via hostname/IP (see start-timing-planner.bat), not just
  // "localhost" — a static origin allow-list rejected every colleague's browser with a silent
  // CORS failure (save/load requests never even reached the server). Any origin on the app's
  // own port is allowed so LAN access works, while still not opening this up to the internet.
  origin: (origin, callback) => {
    if (!origin) return callback(null, true); // same-origin, curl, Postman, etc.
    if (allowedOrigins.includes(origin)) return callback(null, true);
    try {
      if (allowedOriginPorts.has(new URL(origin).port)) return callback(null, true);
    } catch { /* malformed Origin header — fall through to reject */ }
    return callback(new Error("Not allowed by CORS"));
  },
  credentials: true
}));
app.use(express.json({ limit: "50mb" }));
app.use(session({
  secret: process.env.SESSION_SECRET || "btv-planner-session-secret",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: false
  }
}));

const PORT = Number(process.env.PORT || 5000);
const STORAGE_ROOT = path.resolve(process.env.BTV_STORAGE_ROOT || path.join(__dirname, "..", "BTV_PLANNER"));
const LLM_PROVIDER = String(process.env.LLM_PROVIDER || (process.env.OPENAI_API_KEY ? "openai" : "azure")).toLowerCase();
const LLM_MODEL = process.env.OPENAI_MODEL || process.env.MB_GENAI_MODEL || "gpt-4.1-mini";

const client = LLM_PROVIDER === "openai"
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : new AzureOpenAI({
    apiKey: process.env.MB_GENAI_API_KEY,
    apiVersion: process.env.MB_GENAI_API_VERSION,
    endpoint: process.env.MB_GENAI_ENDPOINT
  });

function normalizeReferenceImages(images) {
  if (!Array.isArray(images)) return [];
  return images
    .filter((img) => typeof img === "string" && img.startsWith("data:image/"))
    .slice(0, 4)
    .map((img) => ({ type: "image_url", image_url: { url: img } }));
}

function buildUserContent(text, referenceImages = []) {
  const imageParts = normalizeReferenceImages(referenceImages);
  if (!imageParts.length) return String(text || "");
  return [
    { type: "text", text: String(text || "") },
    ...imageParts
  ];
}

// Adds the raw PDF as a file part so the model sees layout/columns, not just extracted text.
function buildUserContentWithPdf(text, referenceImages = [], pdfDataUrl = "", pdfFilename = "supplier.pdf") {
  const parts = [{ type: "text", text: String(text || "") }];
  if (typeof pdfDataUrl === "string" && pdfDataUrl.startsWith("data:application/pdf")) {
    parts.push({
      type: "file",
      file: { file_data: pdfDataUrl, filename: pdfFilename }
    });
  }
  parts.push(...normalizeReferenceImages(referenceImages));
  return parts;
}

async function requestModel(messages, options = {}) {
  const payload = {
    model: LLM_MODEL,
    messages
  };
  if (options.maxTokens) payload.max_tokens = options.maxTokens;
  const completion = await client.chat.completions.create(payload);
  return completion.choices?.[0]?.message?.content || "";
}

// OpenAI chat.completions silently drops PDF file parts; Responses API is the only path that
// actually reads PDFs. Used for supplier import parity with Copilot chat.
async function requestModelResponsesWithPdf({ system, userText, pdfDataUrl, pdfFilename, referenceImages = [] }) {
  if (!client.responses || typeof client.responses.create !== "function") {
    throw new Error("responses_api_unavailable");
  }
  const userContent = [{ type: "input_text", text: String(userText || "") }];
  if (typeof pdfDataUrl === "string" && pdfDataUrl.startsWith("data:application/pdf")) {
    userContent.push({ type: "input_file", filename: pdfFilename || "supplier.pdf", file_data: pdfDataUrl });
  }
  const images = Array.isArray(referenceImages)
    ? referenceImages.filter((u) => typeof u === "string" && u.startsWith("data:image/")).slice(0, 4)
    : [];
  images.forEach((url) => userContent.push({ type: "input_image", image_url: url, detail: "auto" }));

  const payload = {
    model: LLM_MODEL,
    temperature: 0,
    max_output_tokens: 8000,
    input: [
      { role: "system", content: [{ type: "input_text", text: String(system || "") }] },
      { role: "user", content: userContent }
    ]
  };

  const response = await client.responses.create(payload);
  if (typeof response.output_text === "string" && response.output_text) return response.output_text;
  const outputs = response.output || [];
  for (const item of outputs) {
    const parts = item?.content || [];
    for (const part of parts) {
      if (typeof part?.text === "string" && part.text) return part.text;
      if (typeof part?.text?.value === "string" && part.text.value) return part.text.value;
    }
  }
  return "";
}

const pdfUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    const isPdf = file.mimetype === "application/pdf" || file.originalname.toLowerCase().endsWith(".pdf");
    callback(isPdf ? null : new Error("PDF files only"), isPdf);
  }
});

function normalizeUserName(value) {
  const rawValue = String(value || "").trim();
  const shortId = rawValue.split(/[\\/@]/).pop();

  return shortId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "")
    .replace(/\.+/g, ".")
    .replace(/^-+|-+$/g, "");
}

function getWindowsUserCandidates() {
  return [
    process.env.USERNAME,
    process.env.USER,
    process.env.LOGONUSER,
    process.env.AD_USER,
    process.env.BTV_USER,
    process.env.DEFAULT_USER
  ].filter(Boolean);
}

function resolveCurrentUser(req) {
  const sessionUser = normalizeUserName(req.session?.user);
  if (sessionUser) return sessionUser;

  const headerUser = normalizeUserName(
    req.headers["x-user"] ||
    req.headers["x-forwarded-user"] ||
    req.headers["x-auth-user"]
  );
  if (headerUser) return headerUser;

  const candidates = getWindowsUserCandidates();
  const candidate = candidates.map(normalizeUserName).find(Boolean);
  if (candidate) return candidate;

  const fallback = normalizeUserName(process.env.DEFAULT_USER || "hemanth");
  return fallback;
}

async function ensureStorageStructure() {
  const directories = [
    STORAGE_ROOT,
    path.join(STORAGE_ROOT, "users"),
    path.join(STORAGE_ROOT, "shared_templates")
  ];

  for (const dir of directories) {
    await fs.mkdir(dir, { recursive: true });
  }

  const userNames = ["hemanth", "nethravathi", "shreya", "hari"];
  for (const user of userNames) {
    await fs.mkdir(path.join(STORAGE_ROOT, "users", user), { recursive: true });
  }
}

function sanitizeFileName(value) {
  return String(value || "untitled")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "") || "untitled";
}

function createPlanFileId(carline, commodity) {
  const cleanCarline = sanitizeFileName(carline || "plan");
  const cleanCommodity = String(commodity || "commodity")
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, "") || "commodity";
  return `${cleanCarline}_${cleanCommodity}`;
}

function ensureMetadata(plan, user) {
  const now = new Date().toISOString();
  const owner = normalizeUserName(plan?.owner || user || "");
  const createdBy = normalizeUserName(plan?.createdBy || user || owner || "");
  const lastModifiedBy = normalizeUserName(user || plan?.lastModifiedBy || createdBy || owner || "");
  const createdDate = plan?.createdDate || now;
  const lastModifiedDate = plan?.lastModifiedDate || now;
  const planId = plan?.planId || plan?.id || createPlanFileId(plan?.carline, plan?.commodity);

  return {
    ...plan,
    owner,
    createdBy,
    lastModifiedBy,
    createdDate,
    lastModifiedDate,
    planId,
    id: plan?.id || planId
  };
}

async function listJsonFiles(rootDir) {
  try {
    const entries = await fs.readdir(rootDir, { withFileTypes: true });
    const nested = [];

    for (const entry of entries) {
      const fullPath = path.join(rootDir, entry.name);
      if (entry.isDirectory()) {
        nested.push(...await listJsonFiles(fullPath));
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".json")) {
        nested.push(fullPath);
      }
    }

    return nested;
  } catch {
    return [];
  }
}

async function readPlanFileData(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    if (!raw.trim()) return null;
    const plan = JSON.parse(raw);
    return plan && typeof plan === "object" ? plan : null;
  } catch {
    return null;
  }
}

function readOnlyPlanResponse(plan) {
  const { _filePath, ...publicPlan } = plan;
  return publicPlan;
}

function readOnlyError() {
  return {
    ok: false,
    code: "READ_ONLY_PLAN",
    message: "This plan belongs to another user. Copy it to My Plans before editing."
  };
}

function validatePlanPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return "Plan payload must be an object.";
  }
  for (const field of ["planId", "carline", "commodity"]) {
    if (!String(payload[field] || "").trim()) return `${field} is required.`;
  }
  return null;
}

async function getAllPlansForUser(owner) {
  const userDir = path.join(STORAGE_ROOT, "users", owner || "");
  const files = await listJsonFiles(userDir);
  const plans = [];

  for (const filePath of files) {
    const plan = await readPlanFileData(filePath);
    if (plan) plans.push(plan);
  }

  return plans
    .map((plan) => ({ ...ensureMetadata({ ...plan, owner }, owner), owner }))
    .sort((a, b) => (b.lastModifiedDate || "").localeCompare(a.lastModifiedDate || ""));
}

async function getAllPlansAcrossUsers() {
  const usersRoot = path.join(STORAGE_ROOT, "users");
  const entries = await fs.readdir(usersRoot, { withFileTypes: true });
  const plans = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const owner = entry.name;
    const userPlans = await getAllPlansForUser(owner);
    plans.push(...userPlans);
  }

  return plans.sort((a, b) => (b.lastModifiedDate || "").localeCompare(a.lastModifiedDate || ""));
}

async function getSharedPlans(currentUser) {
  const usersRoot = path.join(STORAGE_ROOT, "users");
  const excludedOwner = normalizeUserName(currentUser);
  const plans = [];
  let invalidCount = 0;

  let entries = [];
  try {
    entries = await fs.readdir(usersRoot, { withFileTypes: true });
  } catch (error) {
    // Surface the real reason (e.g. network share unreachable/permission denied) instead of
    // silently reporting zero shared plans, which looks identical to "no one has shared plans".
    const err = new Error(`Could not list the shared plans folder: ${error.message}`);
    err.cause = error;
    throw err;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || normalizeUserName(entry.name) === excludedOwner) continue;
    const owner = normalizeUserName(entry.name);
    const ownerFiles = await listJsonFiles(path.join(usersRoot, entry.name));
    for (const file of ownerFiles) {
      const plan = await readPlanFileData(file);
      if (!plan) {
        invalidCount += 1;
        continue;
      }
      plans.push({
        ...ensureMetadata(plan, owner),
        owner,
        readOnly: true,
        _filePath: file
      });
    }
  }

  return {
    plans: plans.sort((a, b) => (b.lastModifiedDate || "").localeCompare(a.lastModifiedDate || "")),
    invalidCount
  };
}

function buildPlanPath(owner, plan) {
  const safeOwner = normalizeUserName(owner || "");
  const safePlanId = sanitizeFileName(plan?.planId || plan?.id || `${plan?.carline || "plan"}_${Date.now()}`);
  return path.join(STORAGE_ROOT, "users", safeOwner || "unknown", `${safePlanId}.json`);
}

async function findPlanByIdOrFileId(targetId, requestedOwner = "") {
  const planId = String(targetId || "");
  const allPlans = requestedOwner
    ? await getAllPlansForUser(normalizeUserName(requestedOwner))
    : await getAllPlansAcrossUsers();
  const match = allPlans.find((plan) => {
    const ids = [plan.planId, plan.id, path.basename(plan._filePath || "")];
    return ids.some((entry) => String(entry || "") === planId);
  });

  if (match) {
    return { ...match, _filePath: match._filePath || buildPlanPath(match.owner, match) };
  }

  return null;
}

// Turns raw Node.js filesystem error codes into messages that actually help someone diagnose a
// network-share problem, instead of a generic "Failed to save plan."
function describeStorageError(error) {
  const code = error?.code || "";
  if (code === "ENOENT") return `The plan storage folder could not be found (${STORAGE_ROOT}). Check the network share path/connection.`;
  if (code === "EACCES" || code === "EPERM") return "Access denied writing to the network plan storage folder. Check your share permissions.";
  if (code === "ETIMEDOUT" || code === "ENETUNREACH" || code === "EHOSTUNREACH") return "The network plan storage share timed out/unreachable. Check your VPN or network connection.";
  if (code === "ENOSPC") return "The network plan storage share is out of disk space.";
  return error?.message || "Failed to save plan.";
}

async function writePlan(plan, currentUser) {
  const normalizedPlan = ensureMetadata(plan, currentUser);
  const owner = normalizeUserName(normalizedPlan.owner || currentUser || "");
  const filePath = buildPlanPath(owner, normalizedPlan);

  await fs.mkdir(path.dirname(filePath), { recursive: true });

  normalizedPlan.owner = owner;
  normalizedPlan.createdBy = normalizeUserName(normalizedPlan.createdBy || owner || currentUser || "");
  normalizedPlan.lastModifiedBy = normalizeUserName(currentUser || normalizedPlan.lastModifiedBy || normalizedPlan.createdBy || owner || "");
  normalizedPlan.lastModifiedDate = new Date().toISOString();
  normalizedPlan.id = normalizedPlan.planId || normalizedPlan.id;

  const temporaryPath = `${filePath}.tmp`;
  try {
    const serialized = JSON.stringify(normalizedPlan, null, 2);
    await fs.writeFile(temporaryPath, serialized, "utf8");
    JSON.parse(await fs.readFile(temporaryPath, "utf8"));
    try {
      await fs.rename(temporaryPath, filePath);
    } catch (renameError) {
      // Some network/SMB shares reject atomic rename (EPERM/EXDEV) even within the same UNC
      // root — fall back to a direct write so a save never silently fails on those drives.
      console.warn("Rename failed, falling back to direct write:", renameError.message);
      await fs.writeFile(filePath, serialized, "utf8");
      await fs.unlink(temporaryPath).catch(() => {});
    }
  } catch (error) {
    await fs.unlink(temporaryPath).catch(() => {});
    throw error;
  }
  return { ...normalizedPlan, _filePath: filePath };
}

app.use(async (req, res, next) => {
  try {
    await ensureStorageStructure();
    next();
  } catch (error) {
    next(error);
  }
});

app.get("/api/session", (req, res) => {
  const currentUser = resolveCurrentUser(req);
  req.session.user = currentUser;
  res.json({ ok: true, user: currentUser, availableUsers: ["hemanth", "nethravathi", "shreya", "hari"] });
});

app.get("/api/plans/my", async (req, res) => {
  const currentUser = resolveCurrentUser(req);
  req.session.user = currentUser;
  const plans = await getAllPlansForUser(currentUser);
  res.json({ ok: true, plans });
});

app.get("/api/plans/team", async (req, res) => {
  const plans = await getAllPlansAcrossUsers();
  res.json({ ok: true, plans: plans.map(readOnlyPlanResponse) });
});

app.get("/api/plans/shared", async (req, res) => {
  try {
    const currentUser = resolveCurrentUser(req);
    req.session.user = currentUser;
    const result = await getSharedPlans(currentUser);
    res.json({
      ok: true,
      plans: result.plans.map(readOnlyPlanResponse),
      warningCount: result.invalidCount
    });
  } catch (error) {
    console.error("Shared plans error:", error);
    res.status(500).json({ ok: false, error: error.message || "Failed to load shared plans.", plans: [] });
  }
});

app.get("/api/plans/templates", async (_req, res) => {
  res.json({ ok: true, plans: [], warningCount: 0 });
});

app.get("/api/storage/status", async (req, res) => {
  const currentUser = resolveCurrentUser(req);
  let available = false;
  try {
    await fs.access(STORAGE_ROOT);
    available = true;
  } catch {
    available = false;
  }
  const currentUserFolder = path.join(STORAGE_ROOT, "users", currentUser);
  let writable = false;
  try {
    await fs.access(currentUserFolder);
    await fs.access(currentUserFolder, 2);
    writable = true;
  } catch {
    writable = false;
  }
  res.json({
    available,
    writable: available && writable,
    currentUserFolderAvailable: available && writable
  });
});

app.get("/api/plans/:id", async (req, res) => {
  const currentUser = resolveCurrentUser(req);
  req.session.user = currentUser;
  const requestedOwner = normalizeUserName(req.query.owner || "");
  const plan = requestedOwner
    ? await findPlanByIdOrFileId(req.params.id, requestedOwner)
    : await findPlanByIdOrFileId(req.params.id);
  if (!plan) {
    return res.status(404).json({ ok: false, error: "Plan not found" });
  }

  return res.json({ ok: true, plan: readOnlyPlanResponse({
    ...plan,
    readOnly: normalizeUserName(plan.owner) !== normalizeUserName(currentUser)
  }) });
});

app.post("/api/plans/save", async (req, res) => {
  try {
    const currentUser = resolveCurrentUser(req);
    req.session.user = currentUser;
    const incomingPlan = req.body || {};
    const validationError = validatePlanPayload(incomingPlan);
    if (validationError) return res.status(400).json({ ok: false, error: validationError });
    const plan = ensureMetadata(incomingPlan, currentUser);

    const owner = normalizeUserName(currentUser);
    if (plan.owner && normalizeUserName(plan.owner) !== owner) {
      return res.status(403).json(readOnlyError());
    }
    // Plans are stored per-owner (users/<owner>/<planId>.json), so two different users creating
    // a plan for the same carline+commodity never actually collide on disk — only check whether
    // *this user's own* existing file for that planId belongs to someone else somehow.
    const existingOwnedPlan = await findPlanByIdOrFileId(plan.planId, owner);
    if (existingOwnedPlan && normalizeUserName(existingOwnedPlan.owner) !== owner) {
      return res.status(403).json(readOnlyError());
    }

    const savedPlan = await writePlan({
      ...plan,
      owner,
      createdBy: normalizeUserName(plan.createdBy || currentUser),
      lastModifiedBy: normalizeUserName(currentUser),
      lastModifiedDate: new Date().toISOString()
    }, currentUser);

    return res.json({ ok: true, plan: readOnlyPlanResponse(savedPlan) });
  } catch (error) {
    console.error("Save plan error:", error);
    return res.status(500).json({ ok: false, error: describeStorageError(error) });
  }
});

app.post("/api/plans/copy", async (req, res) => {
  try {
    const currentUser = resolveCurrentUser(req);
    req.session.user = currentUser;
    const { planId, sourceOwner, carline, commodity, planName } = req.body || {};
    if (!planId) {
      return res.status(400).json({ ok: false, error: "Plan id is required." });
    }

    const sourcePlan = await findPlanByIdOrFileId(planId, normalizeUserName(sourceOwner || ""));

    if (!sourcePlan) {
      return res.status(404).json({ ok: false, error: "Plan not found." });
    }

    const copiedFromOwner = normalizeUserName(sourcePlan.owner || "");
    const requestedName = sanitizeFileName(planName || `${sourcePlan.carline || "copy"}_${sourcePlan.commodity || "plan"}`);
    let copyId = requestedName;
    let suffix = 1;
    while (await fs.access(buildPlanPath(currentUser, { planId: copyId })).then(() => true).catch(() => false)) {
      copyId = `${requestedName}_${suffix++}`;
    }
    const copiedPlan = ensureMetadata({
      ...sourcePlan,
      owner: currentUser,
      carline: String(carline || sourcePlan.carline || "").trim(),
      commodity: String(commodity || sourcePlan.commodity || "").trim(),
      createdBy: currentUser,
      lastModifiedBy: currentUser,
      createdDate: new Date().toISOString(),
      lastModifiedDate: new Date().toISOString(),
      planId: copyId,
      id: copyId,
      copiedFromOwner,
      copiedFromPlanId: String(sourcePlan.planId || sourcePlan.id || planId)
    }, currentUser);

    const saved = await writePlan(copiedPlan, currentUser);
    return res.json({ ok: true, plan: readOnlyPlanResponse(saved) });
  } catch (error) {
    console.error("Copy plan error:", error);
    return res.status(500).json({ ok: false, error: error.message || "Failed to copy plan." });
  }
});

app.delete("/api/plans/:id", async (req, res) => {
  try {
    const currentUser = resolveCurrentUser(req);
    req.session.user = currentUser;
    const plan = await findPlanByIdOrFileId(req.params.id);
    if (!plan) {
      return res.status(404).json({ ok: false, error: "Plan not found" });
    }

    if (normalizeUserName(plan.owner || "") !== normalizeUserName(currentUser)) {
      return res.status(403).json(readOnlyError());
    }

    const filePath = plan._filePath || buildPlanPath(plan.owner, plan);
    await fs.unlink(filePath).catch(() => {});
    return res.json({ ok: true, deleted: true, id: req.params.id });
  } catch (error) {
    console.error("Delete plan error:", error);
    return res.status(500).json({ ok: false, error: error.message || "Delete failed." });
  }
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

function getReadinessSummary(plan) {
  const createdDate = plan?.createdDate ? new Date(plan.createdDate) : null;
  const milestones = plan?.milestones || {};
  const builds = Array.isArray(plan?.builds) ? plan.builds : [];
  const gates = [["proto", "protoParts"], ["series", "eswft"], ["pro", "ppap"]];

  const statuses = gates.map(([role, key]) => {
    const build = builds.find((item) => (item.type || item.role) === role);
    const milestone = milestones[key] || {};
    const buildStart = build?.start || "";
    const milestoneDate = milestone.overrideDate || milestone.plannedDate || "";
    if (!buildStart) return "Not Relevant";
    if (!milestoneDate) return "Tight";

    const milestoneTime = new Date(milestoneDate).getTime();
    const createdTime = createdDate?.getTime();
    if (Number.isFinite(createdTime) && Number.isFinite(milestoneTime) && milestoneTime < createdTime) {
      return "Completed";
    }

    const gapWeeks = (new Date(buildStart).getTime() - milestoneTime) / (1000 * 60 * 60 * 24 * 7);
    const minimumBuffer = role === "proto" ? 1 : 2;
    if (gapWeeks < 0) return "Not Realistic";
    if (gapWeeks < minimumBuffer) return "Tight";
    return "Feasible";
  });

  return {
    statuses,
    allCompletedOrIrrelevant: builds.some((build) => build.start) &&
      statuses.every((status) => status === "Completed" || status === "Not Relevant")
  };
}

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
  const last = text.lastIndexOf("}");
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

function safeParsePDFPlanResponse(raw) {
  const parsed = safeParseAIResponse(raw);
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.detectedBuilds)) return null;

  const allowedTypes = new Set(["proto", "series", "pro", "sop", "milestone", "tooling", "validation", "custom"]);
  const allowedConfidence = new Set(["high", "medium", "low"]);

  const GERMAN_MONTHS = {
    januar: "01", jan: "01",
    februar: "02", feb: "02",
    märz: "03", maerz: "03", mrz: "03", mar: "03",
    april: "04", apr: "04",
    mai: "05", may: "05",
    juni: "06", jun: "06",
    juli: "07", jul: "07",
    august: "08", aug: "08",
    september: "09", sep: "09", sept: "09",
    oktober: "10", okt: "10", oct: "10",
    november: "11", nov: "11",
    dezember: "12", dez: "12", dec: "12"
  };

  const normalizeDateIso = (d) => {
    if (!d) return "";
    const str = String(d).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;

    // Chinese date format: 2026年9月28日
    const zhMatch = str.match(/(\d{4})[年/-](\d{1,2})[月/-](\d{1,2})/);
    if (zhMatch) {
      return `${zhMatch[1]}-${zhMatch[2].padStart(2, "0")}-${zhMatch[3].padStart(2, "0")}`;
    }

    // Dot-separated: European/German DD.MM.YYYY (e.g. 28.09.2026)
    const dotMatch = str.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
    if (dotMatch) {
      return `${dotMatch[3]}-${dotMatch[2].padStart(2, "0")}-${dotMatch[1].padStart(2, "0")}`;
    }

    // Slash/dash-separated: Excel's default US locale export is MM/DD/YYYY (e.g. 11/22/2027);
    // swap to DD/MM if the first number can't possibly be a month (e.g. 28/09/2026).
    const slashMatch = str.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
    if (slashMatch) {
      let month = parseInt(slashMatch[1], 10);
      let day = parseInt(slashMatch[2], 10);
      if (month > 12 && day <= 12) { [month, day] = [day, month]; }
      if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
        return `${slashMatch[3]}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      }
    }

    // German / English text: 15. März 2026, 28. Sept 2026, 15 Jan 2026
    const textDateMatch = str.match(/^(\d{1,2})\.?\s+([a-zA-ZäöüÄÖÜß]+)\.?\s+(\d{4})$/);
    if (textDateMatch) {
      const day = textDateMatch[1].padStart(2, "0");
      const monthKey = textDateMatch[2].toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue");
      const month = GERMAN_MONTHS[monthKey] || GERMAN_MONTHS[textDateMatch[2].toLowerCase()] || "01";
      const year = textDateMatch[3];
      return `${year}-${month}-${day}`;
    }

    // Calendar week in German/English: KW 37 2026, CW 37 2026, WK 37 2026
    const kwMatch = str.match(/(?:kw|cw|wk)\s*(\d{1,2})\D+(\d{4})/i);
    if (kwMatch) {
      const week = parseInt(kwMatch[1], 10);
      const year = parseInt(kwMatch[2], 10);
      const jan4 = new Date(Date.UTC(year, 0, 4));
      const jan4Day = jan4.getUTCDay() || 7;
      const week1Monday = new Date(jan4);
      week1Monday.setUTCDate(jan4.getUTCDate() - jan4Day + 1);
      const target = new Date(week1Monday);
      target.setUTCDate(week1Monday.getUTCDate() + (week - 1) * 7);
      return target.toISOString().slice(0, 10);
    }

    const parsedDate = new Date(str);
    return Number.isNaN(parsedDate.getTime()) ? "" : parsedDate.toISOString().slice(0, 10);
  };

  const detectedBuilds = parsed.detectedBuilds
    .filter((build) => build && typeof build === "object")
    .map((build) => {
      const name = String(build.name || build.label || "Imported milestone").trim();
      const start = normalizeDateIso(build.start || build.startDate || build.date);
      const end = normalizeDateIso(build.end || build.endDate || build.finishDate || build.finish || start);
      const startDate = start || end;
      const endDate = end || start;
      const type = allowedTypes.has(build.type) ? build.type : allowedTypes.has(build.role) ? build.role : "custom";
      const hasValidDate = /^\d{4}-\d{2}-\d{2}$/.test(startDate);
      const confidence = !hasValidDate ? "low" : (allowedConfidence.has(build.confidence) ? build.confidence : "high");
      const duration = String(build.duration || "").trim();
      const category = String(build.category || build.group || build.parentTask || "").trim();
      const isMilestone = build.isMilestone !== undefined ? Boolean(build.isMilestone) : (startDate === endDate);
      return {
        name,
        label: name,
        date: startDate,
        start: startDate,
        endDate,
        end: endDate,
        duration,
        category,
        isMilestone,
        type,
        role: type,
        confidence
      };
    })
    // Keep rows even without a recognized date — the frontend lets the user fill missing
    // start/end dates manually instead of losing the build/milestone entirely.
    .filter((build) => build.name)
    .sort((a, b) => {
      const aHas = /^\d{4}-\d{2}-\d{2}$/.test(a.start);
      const bHas = /^\d{4}-\d{2}-\d{2}$/.test(b.start);
      if (aHas !== bHas) return aHas ? -1 : 1;
      if (!aHas) return 0;
      return new Date(a.start) - new Date(b.start);
    });

  return {
    carline: parsed.carline == null ? null : String(parsed.carline).trim(),
    projectTitle: parsed.projectTitle == null ? null : String(parsed.projectTitle).trim(),
    detectedBuilds,
    unparsedRows: Array.isArray(parsed.unparsedRows) ? parsed.unparsedRows.map((row) => String(row)) : [],
    notes: typeof parsed.notes === "string" ? parsed.notes : ""
  };
}

const PDF_PLAN_SYSTEM_PROMPT = [
  "You are a senior automotive BTV component timing planner and project schedule specialist fluent in German (Deutsch), English, and Chinese engineering documents.",
  "Your task is to analyze documents (MS Project exports, Gantt charts, supplier timelines, Excel tables, PDF reports, PowerPoint timeline slides, screenshots) and extract EVERY milestone, vehicle build gate, validation phase, tooling period, and task.",
  "DO NOT skip or slip any milestone or task. Make sure all summary phases, sub-tasks, and major milestones are extracted with both start and end dates.",
  "",
  "German Language & Terminology Comprehension:",
  "- Fully support German documents and German engineering terms:",
  "  * 'Lieferantennominierung', 'Vergabe', 'Nominierung' -> Supplier Nomination",
  "  * 'Konzeptfreigabe', 'P-Design Freeze', 'P-Konzept' -> P Design Freeze",
  "  * 'Zeichnungsfreigabe P', 'P-Freigabe', 'Datenfreigabe P' -> P-Release",
  "  * 'Prototypenwerkzeug', 'Proto-Werkzeugstart', 'Werkzeugerstellung Proto' -> Proto Tool Start",
  "  * 'Musterteile', 'Prototypenteile', 'Musterbereitstellung', 'B-Muster', 'C-Muster' -> Proto Parts / Samples",
  "  * 'Serienkonstruktionsfreigabe', 'W-Design Freeze', 'Konstruktionsfreeze' -> W Design Freeze",
  "  * 'Serienzeichnungsfreigabe', 'W-Freigabe', 'Datenfreigabe W' -> W-Release",
  "  * 'Serienwerkzeug', 'Werkzeugerstellung Serie', 'Werkzeugbau', 'Werkzeugstart' -> Series Tool Start",
  "  * 'Erste Teile aus Serienwerkzeug', 'ESWFT' -> ESWFT",
  "  * 'Rohlingfreigabe', 'Blank Release' -> Blank Release",
  "  * 'Rohling Design Freeze', 'Blank Design Freeze' -> Blank Design Freeze",
  "  * 'Teile aus Serienwerkzeug', 'Serienfallende Teile', 'SWFT' -> SWFT",
  "  * 'Erstbemusterung', 'PPAP', 'EMPB', 'ISIR', 'VDA 2 Freigabe' -> PPAP / Approval",
  "  * 'Serienanlauf', 'Produktionsstart', 'SOP', 'Start of Production' -> SOP",
  "  * 'Erprobung', 'Validierung', 'Dauerlauf', 'Bauteilprüfung', 'Versuch' -> Testing / Validation",
  "  * 'Baustufe', 'Prototypenbau', 'Vorserie', 'Nullserie', 'AF_BL', 'BF_BL', 'PT0', 'PT1', 'PT2' -> Vehicle Build Phases",
  "",
  "Return exactly one valid JSON object and no markdown or prose outside it.",
  "Schema:",
  '{',
  '  "carline": "string or null (e.g. X192, BR254, BR214)",',
  '  "projectTitle": "string or null",',
  '  "detectedBuilds": [',
  '    {',
  '      "name": "string (full descriptive milestone/task name)",',
  '      "label": "string",',
  '      "start": "YYYY-MM-DD",',
  '      "end": "YYYY-MM-DD",',
  '      "duration": "string or null (e.g. 20 days, 50 days, 0 days, 2 wks)",',
  '      "isMilestone": true|false,',
  '      "category": "string (e.g. Key Internal Milestones, Design validation, Tooling / Fixture, Validation, Industrialization)",',
  '      "type": "proto|series|pro|sop|milestone|tooling|validation|custom",',
  '      "confidence": "high|medium|low"',
  '    }',
  '  ],',
  '  "unparsedRows": ["string"],',
  '  "notes": "string"',
  '}',
  "",
  "Extraction & Normalization Rules:",
  "1. Dates: Normalize all date formats to YYYY-MM-DD. Handle German/European dates (e.g. 28.09.2026, 15. März 2026, KW 37 2026), Chinese dates (2026年9月28日), and ISO dates.",
  "1a. If a row provides a calendar week range (e.g. CW34-CW36 / 2026), compute exact dates as: start = Monday of first CW, end = Sunday of last CW.",
  "1b. If explicit Start Date and End Date columns are visible, those values take precedence over inferred dates.",
  "1c. Never use document metadata/header dates (e.g. 'Datum', 'Data as of') as milestone row dates.",
  "2. Start & End Dates: Milestone Name, Start Date, and End Date are mandatory fields. For duration activities, capture exact start and finish dates. For point-in-time milestones, set start date equal to end date.",
  "3. Role/Type classification:",
  "   - Prototype vehicle builds (Proto Build 1 BL1, Proto Build 2 BL2, PVV, E-Vehicles, Prototypenfahrzeuge) -> 'proto'",
  "   - Series vehicle builds (AF_BL, BF_BL, series, Vorserie) -> 'series'",
  "   - Production/Trial builds & Approvals (PT0, PT1, PT2, Pro1, Pro2, PPAP, Erstbemusterung, Nullserie) -> 'pro'",
  "   - SOP / Serienanlauf / Start of Production -> 'sop'",
  "   - Tooling activities (Werkzeugbau, Tooling) -> 'tooling'",
  "   - Validation / Testing activities (Erprobung, Validierung, Testing) -> 'validation'",
  "   - Milestones / Gate releases (Freigabe, Freeze) -> 'milestone'",
  "   - Use 'custom' only when no specific type applies.",
  "4. Maintain proper chronological order.",
  "",
  "Calendar-week Gantt tables (mandatory rules when the source has CW/KW/Week columns):",
  "- Treat the calendar-week band spanning consecutive columns as the exact duration of that row's activity.",
  "- Compute Start Date = Monday of the FIRST calendar week in the band (using ISO week and the year label above that column).",
  "- Compute End Date = Sunday of the LAST calendar week in the band.",
  "- Yellow, orange, green or otherwise highlighted cells define the milestone span for that row — treat the highlighted cell range as the authoritative date range for that row.",
  "- If a row's activity name column shows 'Nomination', 'Design Release', 'Tool Nomination', 'Production Serial Tool', 'FOT', 'Shipment', 'Inspection', 'PPAP', 'SOP' etc., use that exact name; do not merge into a single generic label.",
  "- Never share dates across rows: each row's dates come from its own highlighted band, not from the row above or below.",
  "- If a row's highlighted band starts in year N and ends in year N+1, roll the year forward at the CW1 wraparound.",
  "- Set confidence = 'high' when the band is clearly visible in a color-coded PDF page; use 'medium' only when the CW range is inferred purely from text with no visible band."
].join("\n");

app.post("/import-plan-from-pdf", (req, res) => {
  pdfUpload.single("file")(req, res, async (uploadError) => {
    if (uploadError) {
      const isTooLarge = uploadError.code === "LIMIT_FILE_SIZE";
      return res.status(isTooLarge ? 413 : 400).json({
        error: isTooLarge ? "file_too_large" : "invalid_pdf",
        message: isTooLarge ? "PDF files must be 25 MB or smaller." : uploadError.message || "Please upload a PDF file."
      });
    }
    if (!req.file) {
      return res.status(400).json({ error: "missing_file", message: "Please select a PDF file to import." });
    }

    let parser;
    try {
      parser = new PDFParse({ data: req.file.buffer });
      const result = await parser.getText();
      const text = String(result.text || "").trim();
      if (text.replace(/\s/g, "").length < 20) {
        return res.status(422).json({
          error: "no_text_layer",
          message: "This PDF appears to be scanned or image-based. Text extraction is not supported yet."
        });
      }
      return res.json({ ok: true, text, pageCount: result.total || result.pages?.length || 0 });
    } catch (error) {
      console.error("PDF extraction error:", error);
      return res.status(422).json({ error: "pdf_extraction_failed", message: "This PDF could not be read. Please try a text-based PDF or use manual entry." });
    } finally {
      parser?.destroy?.();
    }
  });
});

app.post("/ai-parse-plan-pdf", async (req, res) => {
  try {
    const {
      text,
      carline = "",
      commodity = "",
      templateSummary = "",
      userGuidance = "",
      referenceImages = []
    } = req.body || {};
    if (typeof text !== "string" || text.trim().length < 20) {
      return res.status(400).json({ error: "missing_text", message: "Extracted PDF text is required." });
    }

    const userPrompt = () => [
      userGuidance
        ? `PRIORITY USER GUIDANCE (must take precedence over any default assumption):\n${String(userGuidance).slice(0, 4000)}`
        : "No user extraction guidance was provided.",
      "Today's date is " + new Date().toISOString().slice(0, 10) + ".",
      carline ? `User-entered carline: ${carline}` : "No carline was entered by the user.",
      commodity ? `Selected commodity: ${commodity}` : "No commodity was selected.",
      templateSummary ? `Commodity template context: ${templateSummary}` : "No commodity template context is available.",
      Array.isArray(referenceImages) && referenceImages.length ? `Reference images attached: ${Math.min(referenceImages.length, 4)} (use them to disambiguate columns and colors).` : "No reference images were attached.",
      "Use the extracted supplier document text below as the source of truth.",
      "Return exactly one valid JSON object matching the schema. No prose, no markdown.",
      "Extracted PDF text (lossy plain-text dump):",
      text.slice(0, 250000)
    ].join("\n\n");

    async function requestStructuredPlan(reminder = "") {
      const promptText = userPrompt() + (reminder ? `\n\n${reminder}` : "");
      const raw = await requestModel([
        { role: "system", content: PDF_PLAN_SYSTEM_PROMPT },
        { role: "user", content: buildUserContent(promptText, referenceImages) }
      ]);
      return raw;
    }

    function parseQualityScore(parsedPlan) {
      if (!parsedPlan || !Array.isArray(parsedPlan.detectedBuilds)) return -1;
      const rows = parsedPlan.detectedBuilds;
      const validDates = rows.filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.start) && /^\d{4}-\d{2}-\d{2}$/.test(r.end)).length;
      const nonZeroSpans = rows.filter((r) => r.start && r.end && r.start !== r.end).length;
      const highOrMedium = rows.filter((r) => r.confidence === "high" || r.confidence === "medium").length;
      return (validDates * 3) + (highOrMedium * 2) + nonZeroSpans;
    }

    const firstRaw = await requestStructuredPlan();
    let parsed = safeParsePDFPlanResponse(firstRaw);
    let lastRaw = firstRaw;
    if (!parsed) {
      const secondRaw = await requestStructuredPlan("Reminder: your previous response was invalid. Return valid JSON only, matching the exact schema.");
      lastRaw = secondRaw;
      parsed = safeParsePDFPlanResponse(secondRaw);
    }
    if (!parsed) {
      const snippet = String(lastRaw || "").slice(0, 400).replace(/\s+/g, " ");
      console.error("[ai-parse-plan-pdf] AI response could not be parsed. Snippet:", snippet);
      return res.status(502).json({
        error: "invalid_ai_response",
        message: "The PDF was read, but the AI could not structure it. You can continue with manual plan creation.",
        debug: { modelSnippet: snippet, provider: LLM_PROVIDER, model: LLM_MODEL }
      });
    }

    // Second (and if needed third) targeted pass: re-read the source text specifically for any
    // rows the first pass could not date, instead of leaving the user to hunt for them manually.
    for (let attempt = 0; attempt < 2; attempt++) {
      const missingDateNames = parsed.detectedBuilds
        .filter((b) => b.confidence === "low" || !/^\d{4}-\d{2}-\d{2}$/.test(b.start))
        .map((b) => b.name);
      if (!missingDateNames.length) break;
      const reminder = [
        "Look again, very carefully, specifically for the start and end dates of these items — they were missed on the previous pass:",
        missingDateNames.map((n) => `- ${n}`).join("\n"),
        "Re-scan the extracted text for any date, calendar week, or duration near these names and return the FULL corrected list of all items (not just these)."
      ].join("\n");
      const retryParsed = safeParsePDFPlanResponse(await requestStructuredPlan(reminder));
      if (!retryParsed) break;
      const retryByName = new Map(retryParsed.detectedBuilds.map((b) => [b.name.toLowerCase().trim(), b]));
      let improved = false;
      parsed.detectedBuilds = parsed.detectedBuilds.map((b) => {
        if (/^\d{4}-\d{2}-\d{2}$/.test(b.start) && b.confidence !== "low") return b;
        const match = retryByName.get(b.name.toLowerCase().trim());
        if (match && /^\d{4}-\d{2}-\d{2}$/.test(match.start)) { improved = true; return match; }
        return b;
      });
      if (!improved) break;
    }

    // Verification pass for week-based schedules: improves cases where models return plausible
    // but row-shifted dates by forcing a second extraction anchored to CW/KW logic.
    if (/\b(?:kw|cw|wk)\b/i.test(text) || userGuidance) {
      const verificationReminder = [
        "Critical verification pass:",
        "- Re-extract all rows and align each milestone/task date to its own row.",
        "- Never use report metadata dates such as 'Datum', 'Data as of', or header dates as milestone dates.",
        "- If calendar week ranges are present (e.g. CW34-CW36 / 2026), compute exact dates: start=Monday of first CW, end=Sunday of last CW.",
        "- If explicit Start Date / End Date columns are present, they override inferred dates.",
        "- Keep the same schema and return the full corrected list."
      ].join("\n");
      const verified = safeParsePDFPlanResponse(await requestStructuredPlan(verificationReminder));
      if (verified && parseQualityScore(verified) >= parseQualityScore(parsed)) parsed = verified;
    }

    return res.json({ ok: true, ...parsed });
  } catch (error) {
    console.error("AI PDF parsing error:", error);
    const cause = String(error?.message || "Unknown provider error").slice(0, 500);
    return res.status(500).json({
      error: "ai_parse_failed",
      message: `The PDF could not be converted into a plan: ${cause}`,
      debug: { provider: LLM_PROVIDER, model: LLM_MODEL }
    });
  }
});

app.post("/ai-parse-plan-screenshot", async (req, res) => {
  try {
    const { image, carline = "", commodity = "", userGuidance = "", referenceImages = [] } = req.body || {};
    if (typeof image !== "string" || !image.startsWith("data:image/")) {
      return res.status(400).json({ error: "missing_image", message: "A screenshot image is required." });
    }

    const baseText = `Today's date is ${new Date().toISOString().slice(0, 10)}. Extract the visible table or milestone data from this screenshot. User carline: ${carline || "unknown"}. Commodity: ${commodity || "unknown"}. ${userGuidance ? `User extraction guidance (highest priority): ${String(userGuidance).slice(0, 4000)}.` : "No user extraction guidance was provided."} Return only the required JSON object.`;

    async function requestScreenshotParse(extraReminder = "") {
      const allImages = [image, ...(Array.isArray(referenceImages) ? referenceImages : [])];
      const raw = await requestModel([
        { role: "system", content: PDF_PLAN_SYSTEM_PROMPT },
        {
          role: "user",
          content: buildUserContent(`${baseText}${extraReminder ? `\n\n${extraReminder}` : ""}`, allImages)
        }
      ]);
      return safeParsePDFPlanResponse(raw);
    }

    let parsed = await requestScreenshotParse();
    if (parsed) {
      const rows = parsed.detectedBuilds || [];
      const lowCount = rows.filter((r) => r.confidence === "low").length;
      if (rows.length && lowCount / rows.length >= 0.35) {
        parsed = await requestScreenshotParse(
          "Verification pass: align each milestone row to its own date cells; if CW/KW ranges are visible, compute Monday-Sunday boundaries; never use header metadata dates as row dates."
        ) || parsed;
      }
    }
    if (!parsed) {
      return res.status(502).json({ error: "invalid_ai_response", message: "The screenshot was read, but the AI could not structure it. You can continue with manual entry." });
    }
    return res.json({ ok: true, ...parsed });
  } catch (error) {
    console.error("AI screenshot parsing error:", error);
    return res.status(500).json({ error: "screenshot_parse_failed", message: "The screenshot could not be converted into rows. You can continue with manual entry." });
  }
});

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
    const last = text.lastIndexOf("}");
    if (first !== -1 && last !== -1 && last > first) {
      try { parsed = JSON.parse(text.slice(first, last + 1)); } catch { return null; }
    }
  }
  if (!parsed || typeof parsed !== "object") return null;
  if (!parsed.aiMilestones || typeof parsed.aiMilestones !== "object") return null;
  const requiredKeys = [
    "supplierNomination","pRelease","protoToolStart","protoParts",
    "wRelease","seriesToolStart","eswft","blankRelease","swft","ppap"
  ];
  for (const key of requiredKeys) {
    const m = parsed.aiMilestones[key];
    if (!m || typeof m !== "object" || typeof m.plannedDate !== "string") return null;
  }

  const ms = parsed.aiMilestones;

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

  const protoPartsDate = ms.protoParts?.plannedDate;
  const wReleaseDate = ms.wRelease?.plannedDate;
  if (protoPartsDate && wReleaseDate) {
    const gapWeeks = (new Date(wReleaseDate) - new Date(protoPartsDate)) / (1000 * 60 * 60 * 24 * 7);
    if (gapWeeks < 8) {
      const corrected = new Date(new Date(protoPartsDate).getTime() + 8 * 7 * 24 * 60 * 60 * 1000);
      ms.wRelease.plannedDate = corrected.toISOString().slice(0, 10);
      if (ms.wDesignFreeze) ms.wDesignFreeze.plannedDate = twoWeeksBefore(ms.wRelease.plannedDate);
    }
  }

  return {
    aiMilestones: ms,
    overallCommentary: typeof parsed.overallCommentary === "string" ? parsed.overallCommentary.trim() : ""
  };
}

app.get("/", (req, res) => {
  res.json({ status: "CTP AI Backend is running" });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.post("/ai-advice", async (req, res) => {
  try {
    const plan = req.body;

    if (!plan || !plan.carline) {
      return res.status(400).json({ error: "Invalid plan payload" });
    }

    const vl = plan._visibleLanes || {};
    const visibleLaneNames = [
      vl.buildPlan && "Build Plan",
      vl.btvRule && "BTV Milestones (Rule)",
      vl.btvMyPlan && "My Plan (custom milestones)",
      vl.aiOptimized && "AI Optimized Plan",
      vl.subActivities && "Sub-Activities"
    ].filter(Boolean);

    const laneScope = visibleLaneNames.length > 0
      ? `You must only analyse the data from the following visible timeline lanes: ${visibleLaneNames.join(", ")}. ` +
        `Ignore any data in the payload that belongs to hidden lanes. ` +
        `If a lane is listed as visible but its data is empty, state that it contains no data rather than flagging it as a risk.`
      : "No timeline lanes are currently visible. Advise the engineer to select at least one lane to get meaningful feedback.";

    const readinessSummary = getReadinessSummary(plan);

    const { _visibleLanes, ...planForAI } = plan;

    const rawContent = await requestModel([
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content:
          "Today's date is " + new Date().toISOString().slice(0, 10) + ".\n\n" +
          "Deterministic build-readiness status is " + JSON.stringify(readinessSummary) + ". Milestones dated before createdDate are completed history, not feasible future work. " +
          laneScope + "\n\n" +
          "Analyze the following component timing plan and return only the JSON object " +
          "in the required schema. No prose, no markdown, no code fences.\n\n" +
          "Plan JSON:\n" +
          JSON.stringify(planForAI)
      }
    ]);
    const parsed = safeParseAIResponse(rawContent);

    if (!parsed) {
      console.warn("Unparseable advisory output:", rawContent);
      return res.status(200).json({ ok: false, error: "AI returned unstructured content. Try again." });
    }

    const advisory = {
      overallRisk: readinessSummary.allCompletedOrIrrelevant ? "Green" : (parsed.overallRisk || "Yellow"),
      summary: readinessSummary.allCompletedOrIrrelevant
        ? "Plan Fully Complete — all relevant milestones are completed or not applicable."
        : (parsed.summary || ""),
      sequencingAndToolingRisk: Array.isArray(parsed.sequencingAndToolingRisk) ? parsed.sequencingAndToolingRisk : [],
      ppapAndSamplingDeviationRisk: Array.isArray(parsed.ppapAndSamplingDeviationRisk) ? parsed.ppapAndSamplingDeviationRisk : [],
      recommendation: Array.isArray(parsed.recommendation) ? parsed.recommendation : []
    };

    return res.json({ ok: true, advisory });
  } catch (err) {
    console.error("AI advice error:", err);
    return res.status(500).json({ ok: false, error: err.message || "AI request failed" });
  }
});

app.post("/ai-chat", async (req, res) => {
  try {
    const { messages, currentPlan, allPlans, referenceImages = [] } = req.body || {};

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "messages array is required" });
    }

    const safeAllPlans = Array.isArray(allPlans) ? allPlans : [];
    const knownCarlines = safeAllPlans
      .map((p) => (p && p.carline ? String(p.carline) : ""))
      .filter(Boolean);

    const contextMessages = [{ role: "system", content: CHAT_SYSTEM_PROMPT }];

    contextMessages.push({
      role: "system",
      content: "Today's date is " + new Date().toISOString().slice(0, 10) + ". Use this as the authoritative current date whenever you reason about time."
    });

    contextMessages.push({
      role: "system",
      content: "Here is the full list of plans currently in the tool (allPlans). Use it as the authoritative source of which carlines exist and their commodities. Do not fabricate any plan not in this list.\n\nKnown carlines: " + JSON.stringify(knownCarlines) + "\n\nallPlans JSON:\n" + JSON.stringify(safeAllPlans)
    });

    if (currentPlan && typeof currentPlan === "object") {
      contextMessages.push({
        role: "system",
        content: "This is the currently selected plan the engineer is looking at (currentPlan). Prefer this plan when the question does not clearly reference another carline.\n\n" + JSON.stringify(currentPlan)
      });
    } else {
      contextMessages.push({
        role: "system",
        content: "No specific plan is currently selected. If the engineer asks about a specific carline, use allPlans to answer."
      });
    }

    const latestUserIndex = (() => {
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i] && messages[i].role === "user") return i;
      }
      return -1;
    })();

    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (!m || typeof m !== "object") continue;
      if (m.role === "user" || m.role === "assistant") {
        if (m.role === "user" && i === latestUserIndex) {
          contextMessages.push({ role: "user", content: buildUserContent(String(m.content || ""), referenceImages) });
        } else {
          contextMessages.push({ role: m.role, content: String(m.content || "") });
        }
      }
    }

    let raw;
    try {
      raw = await requestModel(contextMessages);
    } catch (err) {
      const msg = String(err?.message || "").toLowerCase();
      const imageLikelyUnsupported = msg.includes("image") || msg.includes("vision") || msg.includes("content") || msg.includes("multimodal");
      if (!referenceImages.length || !imageLikelyUnsupported) throw err;
      const textOnlyMessages = contextMessages.map((m) => {
        if (m.role !== "user" || typeof m.content === "string") return m;
        const textPart = Array.isArray(m.content) ? m.content.find((p) => p?.type === "text") : null;
        return { ...m, content: textPart?.text || "" };
      });
      raw = await requestModel(textOnlyMessages);
    }
    const parsed = safeParseAIResponse(raw);

    if (!parsed) {
      console.warn("Unparseable chat output:", raw);
      return res.status(200).json({
        ok: true,
        reply: raw && raw.trim().length ? raw : "I could not generate a structured response. Please try again.",
        intent: { type: "none", targetCarline: "", targetCommodity: "" }
      });
    }

    const reply = typeof parsed.reply === "string" && parsed.reply.trim() ? parsed.reply.trim() : "I could not generate a response. Please try again.";

    let intent = { type: "none", targetCarline: "", targetCommodity: "" };
    if (parsed.intent && typeof parsed.intent === "object") {
      const t = parsed.intent.type;
      if (t === "open_plan" || t === "switch_plan_no_open" || t === "save_chat_to_plan" || t === "none") {
        intent = {
          type: t,
          targetCarline: typeof parsed.intent.targetCarline === "string" ? parsed.intent.targetCarline.trim() : "",
          targetCommodity: typeof parsed.intent.targetCommodity === "string" ? parsed.intent.targetCommodity.trim() : ""
        };
      }
    }

    if (intent.type !== "none") {
      const exists = knownCarlines.some((c) => c.toLowerCase() === intent.targetCarline.toLowerCase());
      if (!exists) {
        intent = { type: "none", targetCarline: "", targetCommodity: "" };
      }
    }

    return res.json({ ok: true, reply, intent });
  } catch (err) {
    console.error("AI chat error:", err);
    return res.status(500).json({ ok: false, error: err.message || "AI chat request failed" });
  }
});

app.post("/ai-milestones", async (req, res) => {
  try {
    const { plan } = req.body || {};
    if (!plan || !plan.carline) {
      return res.status(400).json({ error: "Invalid plan payload" });
    }

    const raw = await requestModel([
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
          "Return only the JSON object in the required schema. No prose, no markdown.\n\n" +
          "Plan JSON:\n" + JSON.stringify(plan)
      }
    ]);
    const parsed = safeParseAIMilestones(raw);
    if (!parsed) {
      console.warn("Unparseable AI milestones output:", raw);
      return res.status(200).json({ ok: false, error: "AI failed to generate valid milestone plan. Try again." });
    }

    return res.json({ ok: true, aiMilestones: parsed.aiMilestones, overallCommentary: parsed.overallCommentary });
  } catch (err) {
    console.error("AI milestones error:", err);
    return res.status(500).json({ ok: false, error: err.message || "AI milestones request failed" });
  }
});

process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err);
});

app.listen(PORT, () => {
  console.log("CTP AI Backend running on http://localhost:" + PORT);
  console.log(`[LLM] Provider: ${LLM_PROVIDER}, Model: ${LLM_MODEL}`);
  const hasKey = LLM_PROVIDER === "openai" ? !!process.env.OPENAI_API_KEY : !!process.env.MB_GENAI_API_KEY;
  console.log(`[LLM] API key configured: ${hasKey ? "yes" : "NO — extraction will fail!"}`);
});