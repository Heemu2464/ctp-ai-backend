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
import { canPerform, createActionToolDefinitions, createReadOnlyToolDefinitions, getPlanItemDates, updateItemDates } from "../../timing-planner/src/plannerActions.js";
import { createPlanResolverContext, resolveItem, resolveLane, resolvePlan } from "../../timing-planner/src/plannerResolvers.js";
import { analyzeCriticalPathImpact, analyzeDownstreamImpact, analyzeScheduleConflicts, buildCascadeProposal, calculateCriticalPath, getAllAncestors, getAllDescendants, getItemById, getItemDependencyMetrics, getPredecessors, getSuccessors } from "../../timing-planner/src/dependencyService.js";
import { generateRecoveryScenarios, getRecoveryReferences, validateRecoveryScenario } from "../../timing-planner/src/recoveryService.js";
import { buildReadLanes, queryOpenAndOverduePlanItems, queryReadItems } from "./read-lanes.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const allowedOrigins = (process.env.FRONTEND_URL || "http://localhost:5005,http://localhost:5173")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const allowedOriginPorts = new Set(["5005", "5173", "5296"]);

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
  if (options.tools) payload.tools = options.tools;
  if (options.toolChoice) payload.tool_choice = options.toolChoice;
  const completion = await client.chat.completions.create(payload);
  return options.returnMessage ? (completion.choices?.[0]?.message || {}) : (completion.choices?.[0]?.message?.content || "");
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

function resolveCurrentUser(req) {
  const sessionUser = normalizeUserName(req.session?.user);
  if (sessionUser) return sessionUser;

  // Tests use this explicit opt-in because a browser-controlled header must never identify a
  // real user. Production identity always comes from the signed-in session below.
  if (process.env.ALLOW_TEST_USER_HEADER === "true") {
    return normalizeUserName(req.headers["x-user"]);
  }

  return "";
}

function requireCurrentUser(req, res, next) {
  const currentUser = resolveCurrentUser(req);
  if (!currentUser) {
    return res.status(401).json({
      ok: false,
      code: "AUTHENTICATION_REQUIRED",
      error: "Enter your short ID before accessing plans."
    });
  }
  req.currentUser = currentUser;
  return next();
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

function isStoredPlan(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    String(value.carline || "").trim() &&
    String(value.commodity || "").trim()
  );
}

function deduplicatePlansByStableId(plans, scope) {
  const unique = new Map();
  for (const plan of plans) {
    const planId = String(plan.planId || plan.id || "").trim();
    if (!planId) {
      unique.set(`file:${plan._filePath}`, plan);
      continue;
    }
    const existing = unique.get(planId);
    if (existing) {
      console.warn(`Duplicate plan ID ${planId} in ${scope}; keeping ${existing._filePath} and ignoring ${plan._filePath}.`);
      continue;
    }
    unique.set(planId, plan);
  }
  return [...unique.values()];
}

function logLoadedPlans(scope, plans) {
  console.info(`[Plan load] ${scope}: ${plans.length} plan(s).`);
  for (const plan of plans) {
    const stableId = String(plan.planId || plan.id || "");
    const storageKey = `${plan.owner || "unknown"}:${stableId}`;
    console.info("[Plan load]", JSON.stringify({ id: plan.id || "", planId: plan.planId || "", storageKey, filePath: plan._filePath || "", carline: plan.carline || "", commodity: plan.commodity || "" }));
  }
}

async function getAllPlansForUser(owner) {
  const userDir = path.join(STORAGE_ROOT, "users", owner || "");
  const files = await listJsonFiles(userDir);
  const plans = [];

  for (const filePath of files) {
    const plan = await readPlanFileData(filePath);
    if (isStoredPlan(plan)) plans.push({ ...plan, _filePath: filePath });
  }

  const uniquePlans = deduplicatePlansByStableId(plans
    .map((plan) => ({ ...ensureMetadata({ ...plan, owner }, owner), owner }))
    .sort((a, b) => (b.lastModifiedDate || "").localeCompare(a.lastModifiedDate || "")), `user ${owner}`);
  logLoadedPlans(`user ${owner}`, uniquePlans);
  return uniquePlans;
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

  return deduplicatePlansByStableId(
    plans.sort((a, b) => (b.lastModifiedDate || "").localeCompare(a.lastModifiedDate || "")),
    "all user plans"
  );
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
      if (!isStoredPlan(plan)) continue;
      plans.push({
        ...ensureMetadata(plan, owner),
        owner,
        readOnly: true,
        _filePath: file
      });
    }
  }

  const uniquePlans = deduplicatePlansByStableId(
      plans.sort((a, b) => (b.lastModifiedDate || "").localeCompare(a.lastModifiedDate || "")),
      "shared plans"
    );
  logLoadedPlans(`shared plans for ${excludedOwner}`, uniquePlans);
  return {
    plans: uniquePlans,
    invalidCount
  };
}

function buildPlanPath(owner, plan) {
  const safeOwner = normalizeUserName(owner || "");
  const safePlanId = sanitizeFileName(plan?.planId || plan?.id || `${plan?.carline || "plan"}_${Date.now()}`);
  return path.join(STORAGE_ROOT, "users", safeOwner || "unknown", `${safePlanId}.json`);
}

function buildJournalRowPath(owner, planId, rowId) {
  return path.join(
    STORAGE_ROOT,
    "users",
    normalizeUserName(owner || "unknown") || "unknown",
    "journals",
    sanitizeFileName(planId),
    sanitizeFileName(rowId)
  );
}

async function writeJsonAtomically(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const serialized = JSON.stringify(value, null, 2);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    const handle = await fs.open(temporaryPath, "w");
    try {
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

function isDateOnly(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCFullYear() === Number(match[1]) && date.getUTCMonth() === Number(match[2]) - 1 && date.getUTCDate() === Number(match[3]);
}

function createJournalEntryId() {
  return `journal_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

class JournalRepository {
  constructor() {
    this.writeQueues = new Map();
  }

  async withRowWrite(owner, planId, rowId, operation) {
    const key = `${owner}:${planId}:${rowId}`;
    const previous = this.writeQueues.get(key) || Promise.resolve();
    let release;
    const next = new Promise((resolve) => { release = resolve; });
    this.writeQueues.set(key, next);
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async getIndex(owner, planId, rowId) {
    const rowPath = buildJournalRowPath(owner, planId, rowId);
    const indexPath = path.join(rowPath, "index.json");
    try {
      const parsed = JSON.parse(await fs.readFile(indexPath, "utf8"));
      return { rowPath, entries: Array.isArray(parsed.entries) ? parsed.entries : [] };
    } catch (error) {
      if (error?.code === "ENOENT") return { rowPath, entries: [] };
      throw error;
    }
  }

  async writeIndex(rowPath, entries) {
    await writeJsonAtomically(path.join(rowPath, "index.json"), { version: 1, entries });
  }

  sortEntries(entries, sort) {
    const direction = sort === "asc" ? 1 : -1;
    return [...entries].sort((left, right) => {
      const dateCompare = String(left.entryDate || "").localeCompare(String(right.entryDate || ""));
      if (dateCompare) return dateCompare * direction;
      return String(left.createdAt || "").localeCompare(String(right.createdAt || "")) * direction;
    });
  }

  async list({ owner, planId, rowId, page = 1, pageSize = 50, sort = "desc", fromDate = "", toDate = "", search = "" }) {
    const { rowPath, entries } = await this.getIndex(owner, planId, rowId);
    const normalizedSearch = String(search || "").trim().toLocaleLowerCase();
    const filtered = this.sortEntries(entries.filter((entry) => {
      if (fromDate && String(entry.entryDate || "") < fromDate) return false;
      if (toDate && String(entry.entryDate || "") > toDate) return false;
      return true;
    }), sort);
    const candidateEntries = normalizedSearch
      ? await Promise.all(filtered.map(async (entry) => {
        const fullEntry = await this.getEntry(rowPath, entry.id);
        return fullEntry && fullEntry.text.toLocaleLowerCase().includes(normalizedSearch) ? entry : null;
      })).then((result) => result.filter(Boolean))
      : filtered;
    const start = (page - 1) * pageSize;
    const pageMetadata = candidateEntries.slice(start, start + pageSize);
    const items = (await Promise.all(pageMetadata.map((entry) => this.getEntry(rowPath, entry.id)))).filter(Boolean);
    return { items, total: candidateEntries.length, page, pageSize, hasMore: start + items.length < candidateEntries.length };
  }

  async getEntry(rowPath, entryId) {
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(rowPath, "entries", `${sanitizeFileName(entryId)}.json`), "utf8"));
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async create({ owner, planId, rowId, entryDate, text, attachments, user }) {
    return this.withRowWrite(owner, planId, rowId, async () => {
      const { rowPath, entries } = await this.getIndex(owner, planId, rowId);
      const now = new Date().toISOString();
      const entry = { id: createJournalEntryId(), rowId, entryDate, text, attachments, createdAt: now, updatedAt: now, createdBy: user, updatedBy: user, version: 1 };
      await writeJsonAtomically(path.join(rowPath, "entries", `${entry.id}.json`), entry);
      await this.writeIndex(rowPath, [...entries, { id: entry.id, entryDate, createdAt: now, updatedAt: now }]);
      return entry;
    });
  }

  async update({ owner, planId, rowId, entryId, entryDate, text, attachments, user }) {
    return this.withRowWrite(owner, planId, rowId, async () => {
      const { rowPath, entries } = await this.getIndex(owner, planId, rowId);
      const existing = await this.getEntry(rowPath, entryId);
      if (!existing) return null;
      const updated = { ...existing, entryDate, text, attachments, updatedAt: new Date().toISOString(), updatedBy: user, version: Number(existing.version || 1) + 1 };
      await writeJsonAtomically(path.join(rowPath, "entries", `${sanitizeFileName(entryId)}.json`), updated);
      await this.writeIndex(rowPath, entries.map((entry) => entry.id === entryId ? { ...entry, entryDate, updatedAt: updated.updatedAt } : entry));
      return updated;
    });
  }

  async delete({ owner, planId, rowId, entryId }) {
    return this.withRowWrite(owner, planId, rowId, async () => {
      const { rowPath, entries } = await this.getIndex(owner, planId, rowId);
      if (!entries.some((entry) => entry.id === entryId)) return false;
      await fs.unlink(path.join(rowPath, "entries", `${sanitizeFileName(entryId)}.json`)).catch((error) => { if (error?.code !== "ENOENT") throw error; });
      await this.writeIndex(rowPath, entries.filter((entry) => entry.id !== entryId));
      return true;
    });
  }
}

const journalRepository = new JournalRepository();

function buildActualsPath(owner, planId) {
  return path.join(
    STORAGE_ROOT,
    "users",
    normalizeUserName(owner || "unknown") || "unknown",
    "actuals",
    sanitizeFileName(planId),
    "index.json"
  );
}

class ActualsRepository {
  constructor() {
    this.writeQueues = new Map();
  }

  async withPlanWrite(owner, planId, operation) {
    const key = `${owner}:${planId}`;
    const previous = this.writeQueues.get(key) || Promise.resolve();
    let release;
    const next = new Promise((resolve) => { release = resolve; });
    this.writeQueues.set(key, next);
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async list(owner, planId) {
    try {
      const stored = JSON.parse(await fs.readFile(buildActualsPath(owner, planId), "utf8"));
      return Array.isArray(stored.records) ? stored.records : [];
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
  }

  async save(owner, planId, records) {
    return this.withPlanWrite(owner, planId, async () => {
      await writeJsonAtomically(buildActualsPath(owner, planId), { version: 1, records });
      return records;
    });
  }
}

const actualsRepository = new ActualsRepository();

function validateActualRecord(value, user) {
  const record = value && typeof value === "object" ? value : {};
  const itemType = record.itemType === "duration" ? "duration" : "milestone";
  const status = ["not_started", "in_progress", "completed", "cancelled"].includes(record.status) ? record.status : "not_started";
  const dates = ["actualStartDate", "actualEndDate"];
  for (const key of dates) {
    if (record[key] && !isDateOnly(record[key])) return { error: `${key} must be a valid date.` };
  }
  if (!String(record.plannedItemId || "").trim()) return { error: "plannedItemId is required." };
  if (itemType === "milestone" && record.actualStartDate && record.actualEndDate && record.actualStartDate !== record.actualEndDate) return { error: "Milestone actual start and end dates must match." };
  if (record.actualStartDate && record.actualEndDate && record.actualEndDate < record.actualStartDate) return { error: "Actual end date cannot be before actual start date." };
  if (status === "completed" && !(record.actualEndDate || record.actualStartDate)) return { error: "Completed actuals require an actual date." };
  const now = new Date().toISOString();
  return {
    record: {
      id: sanitizeFileName(record.id || `actual_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`),
      planId: String(record.planId || ""),
      laneId: String(record.laneId || ""),
      plannedItemId: String(record.plannedItemId),
      baselinePlanId: String(record.baselinePlanId || "rule"),
      itemType,
      actualStartDate: record.actualStartDate || null,
      actualEndDate: record.actualEndDate || record.actualStartDate || null,
      status,
      reason: String(record.reason || "").slice(0, 30000),
      recordedBy: String(record.recordedBy || user || ""),
      createdAt: record.createdAt || now,
      updatedAt: now,
      journalEntryId: record.journalEntryId || null
    }
  };
}

async function requireOwnedJournalPlan(req, res) {
  const plan = await findPlanByIdOrFileId(req.params.planId, req.currentUser);
  if (!plan) {
    res.status(404).json({ ok: false, error: "Plan not found." });
    return null;
  }
  if (normalizeUserName(plan.owner) !== normalizeUserName(req.currentUser)) {
    res.status(403).json(readOnlyError());
    return null;
  }
  return plan;
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
  res.json({ ok: true, authenticated: Boolean(currentUser), user: currentUser || null });
});

app.post("/api/session", async (req, res) => {
  const currentUser = normalizeUserName(req.body?.shortId);
  if (!/^[a-z]{7}$/.test(currentUser)) {
    return res.status(400).json({ ok: false, error: "Please enter a correct short ID: 7 letters only." });
  }

  try {
    await fs.mkdir(path.join(STORAGE_ROOT, "users", currentUser), { recursive: true });
    req.session.user = currentUser;
    return res.json({ ok: true, authenticated: true, user: currentUser });
  } catch (error) {
    return res.status(500).json({ ok: false, error: describeStorageError(error) });
  }
});

app.use(["/api/plans", "/api/storage"], requireCurrentUser);

app.get("/api/plans/my", async (req, res) => {
  const currentUser = req.currentUser;
  const plans = await getAllPlansForUser(currentUser);
  res.json({ ok: true, plans, planCount: plans.length });
});

app.get("/api/plans/team", async (req, res) => {
  const plans = await getAllPlansAcrossUsers();
  res.json({ ok: true, plans: plans.map(readOnlyPlanResponse) });
});

app.get("/api/plans/shared", async (req, res) => {
  try {
    const currentUser = req.currentUser;
    const result = await getSharedPlans(currentUser);
    res.json({
      ok: true,
      plans: result.plans.map(readOnlyPlanResponse),
      planCount: result.plans.length,
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
  const currentUser = req.currentUser;
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

function validateJournalInput(body) {
  const entryDate = String(body?.entryDate || "").trim();
  const text = String(body?.text || "").trim();
  const attachments = Array.isArray(body?.attachments) ? body.attachments : [];
  if (!isDateOnly(entryDate)) return { error: "A valid journal date is required." };
  if (!text) return { error: "Journal text cannot be empty." };
  if (text.length > 30000) return { error: "A journal entry cannot exceed 30,000 characters." };
  if (attachments.length > 5) return { error: "A journal entry can have up to five attachments." };
  const supportedAttachmentTypes = "image/(png|jpeg|gif|webp)|application/pdf|application/msword|application/vnd\\.openxmlformats-officedocument\\.wordprocessingml\\.document|application/vnd\\.ms-powerpoint|application/vnd\\.openxmlformats-officedocument\\.presentationml\\.presentation";
  const normalizedAttachments = [];
  for (const attachment of attachments) {
    const dataUrl = String(attachment?.dataUrl || "");
    if (!(new RegExp(`^data:(${supportedAttachmentTypes});base64,[a-z0-9+/=]+$`, "i")).test(dataUrl)) return { error: "Attachments must be images, PDF, Word, or PowerPoint files." };
    if (dataUrl.length > 4 * 1024 * 1024) return { error: "Each attachment must be 3 MB or smaller." };
    normalizedAttachments.push({ id: sanitizeFileName(attachment?.id || createJournalEntryId()), name: String(attachment?.name || "attachment").slice(0, 160), type: String(attachment?.type || "application/octet-stream").slice(0, 120), dataUrl });
  }
  return { entryDate, text, attachments: normalizedAttachments };
}

function journalRequestOptions(query) {
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const pageSize = Math.max(1, Math.min(100, Number.parseInt(query.pageSize, 10) || 50));
  const fromDate = String(query.fromDate || "");
  const toDate = String(query.toDate || "");
  return {
    page,
    pageSize,
    sort: query.sort === "asc" ? "asc" : "desc",
    fromDate: isDateOnly(fromDate) ? fromDate : "",
    toDate: isDateOnly(toDate) ? toDate : "",
    search: String(query.search || "").slice(0, 300)
  };
}

function addJournalServerTiming(res, startedAt) {
  res.set("Server-Timing", `journal;dur=${(performance.now() - startedAt).toFixed(1)}`);
}

app.get("/api/plans/:planId/rows/:rowId/journal", async (req, res) => {
  try {
    const plan = await requireOwnedJournalPlan(req, res);
    if (!plan) return;
    const result = await journalRepository.list({
      owner: req.currentUser,
      planId: plan.planId || plan.id,
      rowId: req.params.rowId,
      ...journalRequestOptions(req.query)
    });
    // Legacy textarea data is preserved as a non-editable adapter entry. Its original date is
    // unknown, so it is explicitly labeled rather than fabricating history.
    const legacyText = String(plan.trackerRowComments?.[req.params.rowId] || "").trim();
    const hasLegacy = Boolean(legacyText);
    const legacyEntry = hasLegacy ? {
      id: `legacy-${sanitizeFileName(req.params.rowId)}`,
      rowId: req.params.rowId,
      entryDate: null,
      text: legacyText,
      createdAt: plan.lastModifiedDate || "",
      updatedAt: plan.lastModifiedDate || "",
      legacy: true,
      version: 1
    } : null;
    const includeLegacy = hasLegacy && !req.query.search && !req.query.fromDate && !req.query.toDate && result.page === 1;
    res.json({ ok: true, ...result, items: includeLegacy ? [...result.items, legacyEntry] : result.items, total: result.total + (hasLegacy ? 1 : 0) });
  } catch (error) {
    console.error("Get journal error:", error);
    res.status(500).json({ ok: false, error: describeStorageError(error) });
  }
});

app.get("/api/plans/:planId/rows/:rowId/journal/count", async (req, res) => {
  try {
    const plan = await requireOwnedJournalPlan(req, res);
    if (!plan) return;
    const result = await journalRepository.list({ owner: req.currentUser, planId: plan.planId || plan.id, rowId: req.params.rowId, page: 1, pageSize: 1 });
    const legacyCount = String(plan.trackerRowComments?.[req.params.rowId] || "").trim() ? 1 : 0;
    res.json({ ok: true, count: result.total + legacyCount });
  } catch (error) {
    res.status(500).json({ ok: false, error: describeStorageError(error) });
  }
});

app.post("/api/plans/:planId/rows/:rowId/journal", async (req, res) => {
  const startedAt = performance.now();
  try {
    const plan = await requireOwnedJournalPlan(req, res);
    if (!plan) return;
    const input = validateJournalInput(req.body);
    if (input.error) return res.status(400).json({ ok: false, error: input.error });
    const entry = await journalRepository.create({ owner: req.currentUser, planId: plan.planId || plan.id, rowId: req.params.rowId, ...input, user: req.currentUser });
    addJournalServerTiming(res, startedAt);
    res.status(201).json({ ok: true, entry });
  } catch (error) {
    console.error("Create journal error:", error);
    res.status(500).json({ ok: false, error: describeStorageError(error) });
  }
});

app.put("/api/plans/:planId/rows/:rowId/journal/:entryId", async (req, res) => {
  try {
    const plan = await requireOwnedJournalPlan(req, res);
    if (!plan) return;
    const input = validateJournalInput(req.body);
    if (input.error) return res.status(400).json({ ok: false, error: input.error });
    const entry = await journalRepository.update({ owner: req.currentUser, planId: plan.planId || plan.id, rowId: req.params.rowId, entryId: req.params.entryId, ...input, user: req.currentUser });
    if (!entry) return res.status(404).json({ ok: false, error: "Journal entry not found." });
    res.json({ ok: true, entry });
  } catch (error) {
    console.error("Update journal error:", error);
    res.status(500).json({ ok: false, error: describeStorageError(error) });
  }
});

app.delete("/api/plans/:planId/rows/:rowId/journal/:entryId", async (req, res) => {
  try {
    const plan = await requireOwnedJournalPlan(req, res);
    if (!plan) return;
    const deleted = await journalRepository.delete({ owner: req.currentUser, planId: plan.planId || plan.id, rowId: req.params.rowId, entryId: req.params.entryId });
    if (!deleted) return res.status(404).json({ ok: false, error: "Journal entry not found." });
    res.json({ ok: true, deleted: true, id: req.params.entryId });
  } catch (error) {
    console.error("Delete journal error:", error);
    res.status(500).json({ ok: false, error: describeStorageError(error) });
  }
});

app.get("/api/plans/:planId/actuals", async (req, res) => {
  try {
    const plan = await requireOwnedJournalPlan(req, res);
    if (!plan) return;
    const records = await actualsRepository.list(req.currentUser, plan.planId || plan.id);
    res.json({ ok: true, records });
  } catch (error) {
    console.error("Get actuals error:", error);
    res.status(500).json({ ok: false, error: describeStorageError(error) });
  }
});

app.put("/api/plans/:planId/actuals", async (req, res) => {
  try {
    const plan = await requireOwnedJournalPlan(req, res);
    if (!plan) return;
    const values = Array.isArray(req.body?.records) ? req.body.records : [];
    const validated = values.map((record) => validateActualRecord({ ...record, planId: plan.planId || plan.id }, req.currentUser));
    const invalid = validated.find((result) => result.error);
    if (invalid) return res.status(400).json({ ok: false, error: invalid.error });
    const seen = new Set();
    const records = validated.map((result) => result.record).filter((record) => {
      const key = `${record.baselinePlanId}:${record.plannedItemId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    await actualsRepository.save(req.currentUser, plan.planId || plan.id, records);
    res.json({ ok: true, records });
  } catch (error) {
    console.error("Save actuals error:", error);
    res.status(500).json({ ok: false, error: describeStorageError(error) });
  }
});

app.get("/api/plans/:id", async (req, res) => {
  const currentUser = req.currentUser;
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
    const currentUser = req.currentUser;
    const incomingPlan = req.body || {};
    const validationError = validatePlanPayload(incomingPlan);
    if (validationError) return res.status(400).json({ ok: false, error: validationError });
    const plan = ensureMetadata(incomingPlan, currentUser);

    const owner = normalizeUserName(currentUser);
    if (plan.owner && normalizeUserName(plan.owner) !== owner) {
      return res.status(403).json(readOnlyError());
    }
    // A plan ID identifies its owner across the workspace. Do not let another user create a
    // same-ID copy through the save endpoint; they must use the explicit copy endpoint instead.
    const existingPlan = await findPlanByIdOrFileId(plan.planId);
    if (existingPlan && normalizeUserName(existingPlan.owner) !== owner) {
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
    const currentUser = req.currentUser;
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
    const currentUser = req.currentUser;
    const plan = await findPlanByIdOrFileId(req.params.id);
    if (!plan) {
      return res.status(404).json({ ok: false, error: "Plan not found" });
    }

    if (normalizeUserName(plan.owner || "") !== normalizeUserName(currentUser)) {
      return res.status(403).json(readOnlyError());
    }

    const filePath = plan._filePath || buildPlanPath(plan.owner, plan);
    await fs.unlink(filePath);
    return res.json({ ok: true, deleted: true, id: req.params.id });
  } catch (error) {
    console.error("Delete plan error:", error);
    return res.status(500).json({ ok: false, error: describeStorageError(error) });
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

function publicPlanName(plan) {
  return [plan?.carline, plan?.commodity].filter(Boolean).join(" - ") || "Plan";
}

function safeTimeZone(value) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return value;
  } catch {
    return "UTC";
  }
}

function localDateOnly(timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function addCalendarDays(dateOnly, days) {
  const [year, month, day] = String(dateOnly || "").split("-").map(Number);
  if (!year || !month || !day) return "";
  return new Date(Date.UTC(year, month - 1, day + Number(days))).toISOString().slice(0, 10);
}

function normalizeItemQueryFilter(filter, timeZone) {
  const normalized = { ...(filter || {}) };
  const defaultsApplied = [];
  const hasFromDate = isDateOnly(normalized.fromDate);
  const hasToDate = isDateOnly(normalized.toDate);
  if (!hasFromDate && !hasToDate) {
    normalized.fromDate = localDateOnly(timeZone);
    normalized.toDate = addCalendarDays(normalized.fromDate, 30);
    defaultsApplied.push("next 30 days", "all visible lanes");
  } else if (hasFromDate && !hasToDate) {
    normalized.toDate = addCalendarDays(normalized.fromDate, 30);
    defaultsApplied.push("30-day window from the requested start date");
  } else if (!hasFromDate && hasToDate) {
    normalized.fromDate = addCalendarDays(normalized.toDate, -30);
    defaultsApplied.push("30-day window ending on the requested end date");
  }
  return { filter: normalized, defaultsApplied };
}

function createReadContext(plan, visibleLanes, timeZone, delaySummary, journalCounts) {
  const lanes = buildReadLanes(plan);
  return {
    plan: { name: publicPlanName(plan), carline: plan.carline || "", commodity: plan.commodity || "", finalizedPlan: plan.finalPlanSource || "rule" },
    lanes: lanes.map((lane) => ({ id: lane.name, name: lane.name })),
    items: lanes.flatMap((lane) => lane.items.map((item) => ({ ...item, lane: lane.name }))),
    visibleLanes: visibleLanes || {},
    today: localDateOnly(timeZone),
    timeZone,
    journalCounts,
    delaySummary
  };
}

async function getJournalCounts(owner, planId, lanes) {
  const counts = {};
  await Promise.all(lanes.map(async (lane) => {
    const result = await journalRepository.list({ owner, planId, rowId: lane.rowId, page: 1, pageSize: 1 });
    counts[lane.name] = result.total;
  }));
  return counts;
}

async function getDelaySummaryForPlan(owner, plan, lanes, timeZone) {
  const today = localDateOnly(timeZone);
  const records = await actualsRepository.list(owner, plan.planId || plan.id);
  const itemByName = new Map(lanes.flatMap((lane) => lane.items.map((item) => [item.name.toLowerCase(), item])));
  return records.reduce((summary, record) => {
    const item = itemByName.get(String(record.plannedItemId || "").toLowerCase());
    const planned = item?.endDate || item?.startDate || "";
    const actual = record.actualEndDate || record.actualStartDate || "";
    if (record.status === "completed") summary[actual > planned ? "late" : "onTime"] += 1;
    else if (planned && planned < today) summary.overdue += 1;
    else summary.open += 1;
    return summary;
  }, { onTime: 0, late: 0, overdue: 0, open: 0 });
}

async function queryOpenAndOverdueAcrossPlans(owner, plans, filter, timeZone) {
  const today = localDateOnly(timeZone);
  const planEntries = await Promise.all(plans.map(async (plan) => {
    const records = await actualsRepository.list(plan.owner || owner, plan.planId || plan.id);
    const closedNames = new Set(records
      .filter((record) => record.status === "completed" || record.status === "cancelled")
      .map((record) => String(record.plannedItemId || "").toLowerCase()));
    return { plan: publicPlanName(plan), lanes: buildReadLanes(plan), closedNames };
  }));
  return { ok: true, ...queryOpenAndOverduePlanItems(planEntries, filter, today) };
}

async function auditReadToolCall(owner, tool, argumentsValue, result) {
  const auditPath = path.join(STORAGE_ROOT, "users", owner, "agent-audit", "read-tools.jsonl");
  await fs.mkdir(path.dirname(auditPath), { recursive: true });
  await fs.appendFile(auditPath, `${JSON.stringify({ user: owner, timestamp: new Date().toISOString(), tool, arguments: argumentsValue, result })}\n`, "utf8");
}

async function auditChatContext(owner, payload, selection) {
  const auditPath = path.join(STORAGE_ROOT, "users", owner, "agent-audit", "chat-context.jsonl");
  await fs.mkdir(path.dirname(auditPath), { recursive: true });
  await fs.appendFile(auditPath, `${JSON.stringify({
    user: owner,
    timestamp: new Date().toISOString(),
    request: {
      messageCount: Array.isArray(payload.messages) ? payload.messages.length : 0,
      messageRoles: (payload.messages || []).map((message) => message?.role || ""),
      selectedPlanRef: String(payload.selectedPlanRef || ""),
      selectedPlanName: String(payload.selectedPlanName || payload.selectedPlan || ""),
      visibleLanes: payload.visibleLanes || {},
      timeZone: String(payload.timeZone || ""),
      referenceImageCount: Array.isArray(payload.referenceImages) ? payload.referenceImages.length : 0
    },
    planCount: selection.planCount,
    selection: {
      status: selection.status,
      resolvedPlanRef: selection.plan ? String(selection.plan.planId || selection.plan.id || "") : "",
      publicPlanName: selection.plan ? publicPlanName(selection.plan) : "",
      candidates: selection.candidates || []
    }
  })}\n`, "utf8");
}

function normalizePublicPlanReference(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

function equivalentPublicPlanReference(left, right) {
  const normalizedLeft = normalizePublicPlanReference(left);
  const normalizedRight = normalizePublicPlanReference(right);
  return normalizedLeft === normalizedRight || normalizedLeft.replace(/\s/g, "") === normalizedRight.replace(/\s/g, "");
}

function resolveSelectedPlan({ selectedPlanRef, selectedPlanName, selectedPlan }, plans) {
  const stableRef = String(selectedPlanRef || "").trim();
  if (stableRef) {
    const matches = plans.filter((plan) => [plan.planId, plan.id].some((value) => String(value || "") === stableRef));
    if (matches.length === 1) return { status: "resolved", plan: matches[0], planCount: plans.length };
    if (matches.length > 1) return { status: "error", planCount: plans.length, message: `Selected plan reference ${stableRef} resolves to multiple stored plans.` };
    return { status: "error", planCount: plans.length, message: `Selected plan reference ${stableRef} could not be resolved.` };
  }

  const publicReference = String(selectedPlanName || selectedPlan || "").trim();
  if (!publicReference) return { status: "none", planCount: plans.length };
  const normalized = normalizePublicPlanReference(publicReference);
  const exactMatches = plans.filter((plan) => equivalentPublicPlanReference(publicPlanName(plan), normalized));
  if (exactMatches.length === 1) return { status: "resolved", plan: exactMatches[0], planCount: plans.length };
  if (exactMatches.length > 1) return { status: "ambiguous", planCount: plans.length, candidates: exactMatches.map((plan) => ({ name: publicPlanName(plan) })) };
  const fallback = resolvePlan(publicReference, plans);
  if (fallback.status === "resolved") {
    const plan = plans.find((candidate) => String(candidate.planId || candidate.id) === String(fallback.value));
    return plan ? { status: "resolved", plan, planCount: plans.length } : { status: "not_found", planCount: plans.length, candidates: plans.map((candidate) => ({ name: publicPlanName(candidate) })) };
  }
  return { status: fallback.status, planCount: plans.length, candidates: fallback.candidates || fallback.options || plans.map((plan) => ({ name: publicPlanName(plan) })) };
}

function resolverFailure(resolution) {
  if (resolution.status === "ambiguous") return { ok: false, status: "ambiguous", message: "Please clarify which option you mean.", candidates: resolution.candidates };
  if (resolution.status === "not_found") return { ok: false, status: "not_found", message: "I could not find that reference.", options: resolution.options || [] };
  return { ok: false, status: "rejected", message: resolution.error || "Use a public name rather than an internal identifier." };
}

async function executeReadTool({ owner, tool, args, plans, timeZone }) {
  const finish = async (result) => {
    await auditReadToolCall(owner, tool || "unknown", args, result);
    return result;
  };
  if (tool === "queryAcrossPlans") return finish(await queryOpenAndOverdueAcrossPlans(owner, plans, args.filter || {}, timeZone));
  const planResolution = resolvePlan(args.planId, plans);
  if (planResolution.status !== "resolved") return finish(resolverFailure(planResolution));
  const plan = plans.find((candidate) => String(candidate.planId || candidate.id) === String(planResolution.value));
  if (!plan) return finish({ ok: false, status: "not_found", message: "I could not find that plan." });
  const lanes = buildReadLanes(plan);
  const laneContext = { lanes: lanes.map((lane) => ({ id: lane.rowId, name: lane.name })) };
  const filter = args.filter || {};
  let result;
  if (tool === "queryItems") {
    const normalized = normalizeItemQueryFilter(filter, timeZone);
    const itemFilter = normalized.filter;
    let selectedLanes = lanes;
    if (itemFilter.lane) {
      const laneResolution = resolveLane(itemFilter.lane, laneContext);
      if (laneResolution.status !== "resolved") return finish(resolverFailure(laneResolution));
      selectedLanes = lanes.filter((lane) => lane.rowId === laneResolution.value);
    }
    const query = queryReadItems(selectedLanes, { ...itemFilter, laneId: "" });
    result = { ok: true, ...query, returnedCount: query.items.length, defaultsApplied: normalized.defaultsApplied };
  } else if (tool === "queryJournal") {
    const laneResolution = resolveLane(args.rowId, laneContext);
    if (laneResolution.status !== "resolved") return finish(resolverFailure(laneResolution));
    const row = lanes.find((lane) => lane.rowId === laneResolution.value);
    const journal = await journalRepository.list({ owner: plan.owner || owner, planId: plan.planId || plan.id, rowId: row.rowId, page: 1, pageSize: Math.min(Number(filter.limit) || 20, 50), search: filter.search || "", fromDate: filter.fromDate || "", toDate: filter.toDate || "" });
    result = { ok: true, lane: row.name, total: journal.total, entries: journal.items.map((entry) => ({ entryDate: entry.entryDate, text: entry.text, attachments: (entry.attachments || []).map((attachment) => ({ name: attachment.name, type: attachment.type })) })) };
  } else if (tool === "getDelaySummary") {
    result = { ok: true, summary: await getDelaySummaryForPlan(plan.owner || owner, plan, lanes, timeZone) };
  } else result = { ok: false, status: "rejected", message: "Unsupported read-only tool." };
  return finish(result);
}

const AGENT_SCOPE_CONFIRMATION_THRESHOLD = 20;

function addDays(value, days) {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? "" : new Date(date.getTime() + Number(days) * 86400000).toISOString().slice(0, 10);
}

function describeResolvedItem(plan, item) {
  if (item.kind === "readOnlyItem") return item;
  if (item.kind === "customMilestone") {
    const milestone = plan?.[item.customPlanField]?.milestones?.[item.milestoneKey];
    if (!milestone?.plannedDate) return null;
    const dates = getPlanItemDates(plan, item);
    return dates ? { ...item, name: milestone.name || item.name, ...dates, native: milestone } : null;
  }
  const activity = (plan.subActivities || []).find((candidate) => String(candidate.id) === String(item.activityId));
  const step = activity?.steps?.find((candidate) => String(candidate.id) === String(item.stepId));
  if (!step?.weekDate) return null;
  const dates = getPlanItemDates(plan, item);
  return dates ? { ...item, name: step.name || item.name, ...dates, native: step } : null;
}

function resolveOperationItems(text, context, plan) {
  const direct = resolveItem(text, context);
  if (direct.status === "resolved") return { status: "resolved", items: [direct.candidate] };
  const lane = resolveLane(text, context);
  if (lane.status === "resolved") return { status: "resolved", items: context.items.filter((item) => item.laneId === lane.value) };
  const query = String(text || "").toLowerCase();
  const namedLane = context.lanes.find((candidate) => query.includes(String(candidate.name || "").toLowerCase()));
  if (namedLane) return { status: "resolved", items: context.items.filter((item) => item.laneId === namedLane.id) };
  const monthNames = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
  const month = monthNames.findIndex((name) => query.includes(name));
  if (month >= 0 && /\b(?:all|everything)\b/.test(query)) {
    const prefix = `-${String(month + 1).padStart(2, "0")}-`;
    return { status: "resolved", items: context.items.filter((item) => describeResolvedItem(plan, item)?.startDate.includes(prefix)) };
  }
  return direct;
}

function diffFields(current, next) {
  return [
    ...(current.name === next.name ? [] : [{ field: "Name", before: current.name, after: next.name }]),
    ...(current.startDate === next.startDate ? [] : [{ field: "Start", before: current.startDate, after: next.startDate }]),
    ...(current.endDate === next.endDate ? [] : [{ field: "End", before: current.endDate, after: next.endDate }]),
    ...(current.durationWeeks === next.durationWeeks ? [] : [{ field: "Duration (weeks)", before: current.durationWeeks, after: next.durationWeeks }])
  ];
}

function parseConversationDate(value, timeZone) {
  const input = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) return input;
  const match = /^(\d{1,2})\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:\s+(\d{4}))?$/i.exec(input);
  if (!match) return "";
  const months = { jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3, may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11 };
  const year = Number(match[3] || localDateOnly(timeZone).slice(0, 4));
  const date = new Date(Date.UTC(year, months[match[2].toLowerCase()], Number(match[1])));
  return date.getUTCFullYear() === year && date.getUTCMonth() === months[match[2].toLowerCase()] && date.getUTCDate() === Number(match[1])
    ? date.toISOString().slice(0, 10)
    : "";
}

function parseTimelineEditIntent(text, timeZone) {
  const input = String(text || "").trim();
  let match = /^rename\s+(.+?)\s+to\s+(.+)$/i.exec(input);
  if (match) return { action: "updateItem", intentType: "RENAME_ITEM", args: { item: match[1].trim(), name: match[2].trim() } };

  match = /^(?:delete|remove)\s+(.+)$/i.exec(input);
  if (match) return { action: "deleteItem", intentType: "DELETE_ITEM", args: { item: match[1].trim() } };

  match = /^(?:mark|set)\s+(.+?)\s+(?:as\s+)?complete(?:d)?$/i.exec(input);
  if (match) return { action: "markComplete", intentType: "MARK_COMPLETE", args: { item: match[1].trim(), actualCompletionDate: localDateOnly(timeZone) } };

  match = /^(?:move|shift)\s+(.+?)\s+by\s+(-?\d+)\s+(day|days|week|weeks)$/i.exec(input);
  if (match) return { action: "shiftItems", intentType: "EDIT_DATE", args: { items: match[1].trim(), deltaDays: Number(match[2]) * (/^week/i.test(match[3]) ? 7 : 1) } };

  match = /^(?:move|shift)\s+(.+?)\s+(?:to|on)\s+(\d{4}-\d{2}-\d{2}|\d{1,2}\s+[a-z]+(?:\s+\d{4})?)$/i.exec(input);
  if (match) {
    const startDate = parseConversationDate(match[2], timeZone);
    if (startDate) return { action: "updateItem", intentType: "EDIT_DATE", args: { item: match[1].trim(), startDate } };
  }
  return null;
}

function parseDependencyIntent(text, timeZone) {
  const input = String(text || "").trim();
  let match = /^(?:make\s+)?(.+?)\s+(?:dependent on|should start after)\s+(.+)$/i.exec(input);
  if (match) return { type: "add", predecessor: match[2].trim(), successor: match[1].trim() };
  match = /^add\s+(.+?)\s+as\s+predecessor\s+of\s+(.+)$/i.exec(input);
  if (match) return { type: "add", predecessor: match[1].trim(), successor: match[2].trim() };
  match = /^link\s+(.+?)\s+to\s+(.+)$/i.exec(input);
  if (match) return { type: "add", predecessor: match[1].trim(), successor: match[2].trim() };
  match = /^remove\s+(?:the\s+)?dependency\s+between\s+(.+?)\s+and\s+(.+)$/i.exec(input);
  if (match) return { type: "remove", predecessor: match[1].trim(), successor: match[2].trim() };
  match = /^(?:what depends on|what comes after)\s+(.+)\??$/i.exec(input);
  if (match) return { type: "successors", item: match[1].trim() };
  match = /^(?:what comes before|show the dependency chain for|show dependency chain for)\s+(.+)\??$/i.exec(input);
  if (match) return { type: /^show/i.test(input) ? "chain" : "predecessors", item: match[1].trim() };
  match = /^what happens to the critical path if\s+(.+?)\s+moves?\s+by\s+(-?\d+)\s+(?:day|days|week|weeks).*$/i.exec(input);
  if (match) return { type: "critical-impact", item: match[1].trim(), deltaDays: Number(match[2]) * (/week/i.test(input) ? 7 : 1) };
  if (/^(?:what is|show) the critical path|^which milestones are critical|^which activities are near critical/i.test(input)) return { type: "critical" };
  match = /^how much (total|free) float does\s+(.+?)\s+have\??$/i.exec(input);
  if (match) return { type: "float", floatType: match[1].toLowerCase(), item: match[2].trim() };
  match = /^(?:what is driving|which predecessor controls|when is the earliest|what is the latest)\s+(.+?)(?:\s+can start|\s+without delaying the plan)?\??$/i.exec(input);
  if (match) return { type: "driver", item: match[1].trim() };
  match = /^if\s+(.+?)\s+moves?\s+by\s+(-?\d+)\s+(?:day|days|week|weeks).*$/i.exec(input);
  if (match) return { type: "impact", item: match[1].trim(), deltaDays: Number(match[2]) * (/week/i.test(input) ? 7 : 1) };
  match = /^(?:how much slack is there before|does)\s+(.+?)(?:\s+have enough buffer)?\??$/i.exec(input);
  if (match) return { type: "slack", item: match[1].trim() };
  match = /^what is the gap between\s+.+?\s+and\s+(.+)\??$/i.exec(input);
  if (match) return { type: "slack", item: match[1].trim() };
  if (/^(?:show dependency conflicts|which milestones have no slack|show dependency health)/i.test(input)) return { type: "health" };
  return null;
}

function parseRecoveryIntent(text) {
  const input = String(text || "").trim();
  const match = /^(.+?)\s+is\s+delayed\s+by\s+(-?\d+)\s+(day|days|week|weeks).*?(?:recover|recovery|options|plan)/i.exec(input);
  if (!match) return null;
  const objective = /protect(?: the)? (?:final|finish|plan) date/i.test(input) ? "protect-finish" : /fewest changes|minimize.*changes/i.test(input) ? "minimum-change" : /lowest risk/i.test(input) ? "lowest-risk" : "";
  const protectedMatch = /(?:protect|without moving|keep unchanged)\s+(.+?)(?:[?.]|$)/i.exec(input);
  const gapMatch = /keep\s+(.+?)\s+(?:at least\s+)?(\d+)\s+(day|days|week|weeks)\s+before\s+(.+?)(?:[?.]|$)/i.exec(input);
  return { item: match[1].trim(), delayDays: Number(match[2]) * (/week/i.test(match[3]) ? 7 : 1), objective, protectedTarget: protectedMatch?.[1]?.trim() || "", gap: gapMatch ? { sourceName: gapMatch[1].trim(), gapDays: Number(gapMatch[2]) * (/week/i.test(gapMatch[3]) ? 7 : 1), targetName: gapMatch[4].trim() } : null };
}

function parseRecoveryFollowUpIntent(text) {
  const input = String(text || "").trim();
  const normalized = normalizeAgentText(input);
  if (/^(cancel|never mind|do not apply)/.test(normalized)) return { type: "CANCEL_RECOVERY" };
  if (/show another|another (recovery|option|possibility)|next option|less aggressive/.test(normalized)) return { type: "SHOW_ANOTHER_RECOVERY_OPTION" };
  if (/show (it|me|the affected|these changes).*timeline|where are these changes/.test(normalized)) return { type: "SHOW_RECOVERY_ON_TIMELINE" };
  if (/remove .*constraint|do not protect|allow the build to move/.test(normalized)) return { type: "REMOVE_RECOVERY_CONSTRAINT", target: input.replace(/^(?:remove|do not protect)\s+/i, "").replace(/\s+constraint$/i, "").trim() };
  const gap = /(?:change (?:the )?gap to|keep\s+.+?\s+)(\d+)\s+(day|days|week|weeks)\s+before/i.exec(input);
  if (gap) return { type: "UPDATE_RECOVERY_CONSTRAINT", gapDays: Number(gap[1]) * (/week/i.test(gap[2]) ? 7 : 1) };
  const lane = /(?:use|apply (?:this|it) to|copy (?:this|it) to|put .* in)\s+(?:the )?(my plan 2|second plan|my plan)/i.exec(input);
  if (lane) return { type: /copy|another scenario|keep my plan unchanged/i.test(input) ? "COPY_RECOVERY" : "CHANGE_RECOVERY_TARGET_LANE", targetLaneId: /2|second/i.test(lane[1]) ? "my-plan-2" : "my-plan" };
  if (/^(apply it|use this option|confirm this recovery|update my plan with this)$/i.test(input)) return { type: "APPLY_RECOVERY" };
  if (/^(copy it|create this as another scenario)$/i.test(input)) return { type: "COPY_RECOVERY" };
  if (/^(protect|keep unchanged|do not move)\s+/i.test(input)) return { type: "ADD_RECOVERY_CONSTRAINT", target: input.replace(/^(?:protect|keep unchanged|do not move)\s+/i, "").replace(/\s+too[?.]?$/i, "").trim() };
  return null;
}

function normalizeAgentText(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function publicEditCandidate(plan, item, lane) {
  return {
    planRef: String(plan.planId || plan.id || ""),
    planName: publicPlanName(plan),
    carline: plan.carline || "",
    laneId: item.laneId,
    laneName: lane?.name || item.lane || "Timeline",
    itemId: item.id,
    itemName: item.name,
    itemType: item.kind === "subActivityStep" ? "Sub-activity" : "Milestone",
    isHidden: Boolean(item.isHidden),
    isCollapsed: Boolean(item.isCollapsed),
    editable: Boolean(lane?.editable),
    source: item.source || "timeline"
  };
}

function findEditCandidates(plans, targetText, visibleLanes) {
  const query = normalizeAgentText(targetText);
  if (!query) return [];
  return plans.flatMap((plan) => {
    const context = createPlanResolverContext(plan, { visibleLanes });
    const protectedItems = [
      ...Object.values(plan.milestones || {}).filter((milestone) => milestone?.plannedDate || milestone?.overrideDate).map((milestone) => ({
        id: `rule:${milestone.key}`,
        name: milestone.name || "Rule milestone",
        laneId: "rule-plan",
        kind: "readOnlyItem",
        lane: "Rule-Based Plan",
        isHidden: false,
        isCollapsed: false,
        source: "rule-plan"
      })),
      ...(plan.builds || []).filter((build) => build?.start || build?.date).map((build, index) => ({
        id: `build:${build.id ?? index}`,
        name: build.name || build.label || "Build",
        laneId: "build-plan",
        kind: "readOnlyItem",
        lane: "Build Plan",
        isHidden: false,
        isCollapsed: false,
        source: "build-plan"
      }))
    ];
    const lanes = [...context.lanes, { id: "rule-plan", name: "Rule-Based Plan", editable: false }, { id: "build-plan", name: "Build Plan", editable: false }];
    return [...context.items, ...protectedItems]
      .filter((item) => {
        const name = normalizeAgentText(item.name);
        return name === query || name.includes(query) || query.includes(name);
      })
      .map((item) => publicEditCandidate(plan, item, lanes.find((lane) => lane.id === item.laneId)));
  });
}

function selectPendingCandidate(text, candidates) {
  const answer = normalizeAgentText(text);
  const numbered = /(?:option|number)?\s*(\d+)\b/.exec(answer);
  if (numbered) return candidates[Number(numbered[1]) - 1] || null;
  const ordinal = /\b(first|second|third|fourth|fifth)\b/.exec(answer);
  if (ordinal) {
    const position = ["first", "second", "third", "fourth", "fifth"].indexOf(ordinal[1]);
    if (position >= 0) return candidates[position] || null;
  }
  const matching = candidates.filter((candidate) => {
    const fields = [candidate.carline, candidate.planName, candidate.laneName, candidate.itemName];
    if (answer === "the hidden one" || answer === "hidden") return candidate.isHidden;
    if (answer === "the editable one" || answer === "editable") return candidate.editable;
    const combined = normalizeAgentText(`${candidate.carline} ${candidate.planName} ${candidate.laneName} ${candidate.itemName}`);
    return fields.some((field) => normalizeAgentText(field) === answer || normalizeAgentText(field).includes(answer)) || combined.includes(answer);
  });
  return matching.length === 1 ? matching[0] : null;
}

function pendingActionResponse({ originalMessage, edit, candidates, selectedCandidate = null }) {
  const differentCarlines = new Set(candidates.map((candidate) => candidate.carline)).size > 1;
  const field = differentCarlines ? "carline" : new Set(candidates.map((candidate) => candidate.planRef)).size > 1 ? "plan" : "lane";
  return {
    id: `pending_${Date.now().toString(36)}`,
    intent: edit.intentType,
    status: "needs_clarification",
    originalMessage,
    targetText: edit.args.item || edit.args.items || "",
    requestedChanges: edit.args,
    candidateItems: candidates,
    selectedCarline: selectedCandidate?.carline || "",
    selectedPlanId: selectedCandidate?.planRef || "",
    selectedPlanName: selectedCandidate?.planName || "",
    selectedLaneId: selectedCandidate?.laneId || "",
    selectedLaneName: selectedCandidate?.laneName || "",
    selectedItemId: selectedCandidate?.itemId || "",
    selectedItemName: selectedCandidate?.itemName || "",
    missingFields: [field],
    currentClarificationField: field,
    confirmationRequired: true,
    confirmationStatus: "pending",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

async function createProposal(tool, args, plan, options = {}) {
  if (!["createPlanLane", "createSubActivityLane", "createSubActivity", "createMilestone", "updateItem", "shiftItems", "deleteItem", "markComplete", "addDependency", "removeDependency"].includes(tool)) return null;
  const context = createPlanResolverContext(plan, { visibleLanes: options.visibleLanes });
  const allLanes = [
    { id: "build-plan", name: "Build Plan", kind: "readOnly" },
    { id: "rule-plan", name: "BTV Rule Plan", kind: "readOnly" },
    ...context.lanes.map((candidate) => ({ ...candidate, kind: candidate.id.startsWith("sub-activity-") ? "subActivity" : "customPlan" }))
  ];
  const operationContext = {
    ...context,
    items: [
      ...context.items,
      ...Object.values(plan.milestones || {}).filter((milestone) => milestone?.plannedDate || milestone?.overrideDate).map((milestone) => ({ id: `rule:${milestone.key}`, name: milestone.name || "Rule milestone", laneId: "rule-plan", kind: "readOnlyItem", startDate: milestone.overrideDate || milestone.plannedDate, endDate: milestone.overrideDate || milestone.plannedDate })),
      ...(plan.builds || []).filter((build) => build?.start || build?.date).map((build, index) => ({ id: `build:${build.id ?? index}`, name: build.name || build.label || "Build", laneId: "build-plan", kind: "readOnlyItem", startDate: build.start || build.date, endDate: build.end || build.endDate || build.start || build.date }))
    ]
  };
  const planState = { owned: !plan.readOnly && !plan.sharedFolder, readOnly: Boolean(plan.readOnly || plan.sharedFolder), lanes: allLanes };
  if (tool === "createPlanLane") {
    const permission = canPerform(tool, null, {
      ...planState,
      hasRulePlan: Object.keys(plan.milestones || {}).length > 0,
      myPlanActive: Boolean(plan.customPlan?.active)
    });
    if (!permission.allowed) return { error: { ok: false, status: "rejected", message: permission.reason } };
    return {
      action: tool,
      planRef: String(plan.planId || plan.id),
      input: {},
      planName: `${plan.carline || ""} - ${plan.commodity || ""}`.trim(),
      sourceName: "Rule-Based Plan",
      copiedCount: Object.keys(plan.milestones || {}).length,
      targetName: "My Plan"
    };
  }
  if (tool === "createSubActivityLane") {
    const permission = canPerform(tool, null, planState);
    if (!permission.allowed) return { error: { ok: false, status: "rejected", message: permission.reason } };
    return { action: tool, planRef: String(plan.planId || plan.id), input: { name: args.name, color: args.color || "#2563eb" }, laneName: "" };
  }
  if (["addDependency", "removeDependency"].includes(tool)) {
    const predecessor = resolveItem(args.predecessor || "", context);
    const successor = resolveItem(args.successor || "", context);
    if (predecessor.status !== "resolved" || successor.status !== "resolved") return { error: resolverFailure(predecessor.status !== "resolved" ? predecessor : successor) };
    const predecessorLane = allLanes.find((lane) => lane.id === predecessor.candidate.laneId);
    const successorLane = allLanes.find((lane) => lane.id === successor.candidate.laneId);
    const denied = [predecessorLane, successorLane].map((lane) => canPerform(tool, lane, planState)).find((permission) => !permission.allowed);
    if (denied) return { error: { ok: false, status: "rejected", message: denied.reason } };
    return {
      action: tool,
      intentType: tool === "addDependency" ? "ADD_DEPENDENCY" : "REMOVE_DEPENDENCY",
      planRef: String(plan.planId || plan.id),
      input: { predecessorId: predecessor.candidate.id, successorId: successor.candidate.id },
      laneName: `${predecessorLane.name} -> ${successorLane.name}`,
      preview: { kind: "dependency", operation: tool === "addDependency" ? "add" : "remove", predecessor: predecessor.candidate, successor: successor.candidate }
    };
  }
  if (["updateItem", "shiftItems", "deleteItem", "markComplete"].includes(tool)) {
    const rawTarget = tool === "shiftItems" ? args.items : args.item;
    const resolvedItems = options.targetItemId
      ? { status: "resolved", items: operationContext.items.filter((item) => String(item.id) === String(options.targetItemId)) }
      : resolveOperationItems(rawTarget, operationContext, plan);
    if (resolvedItems.status !== "resolved") return { error: resolverFailure(resolvedItems) };
    const items = resolvedItems.items.map((item) => describeResolvedItem(plan, item)).filter(Boolean);
    if (!items.length) return { error: { ok: false, status: "not_found", message: "No editable dated items matched." } };
    const targetLane = allLanes.find((lane) => lane.id === items[0].laneId);
    const denied = items.map((item) => canPerform(tool, allLanes.find((lane) => lane.id === item.laneId), planState)).find((permission) => !permission.allowed);
    if (denied) return { error: { ok: false, status: "rejected", message: denied.reason } };
    if (tool === "updateItem") {
      if (items.length !== 1) return { error: { ok: false, status: "ambiguous", message: "Choose one item to update." } };
      const name = args.name ?? args.patch?.name ?? items[0].name;
      const dates = updateItemDates(plan, items[0], { startDate: args.startDate ?? args.patch?.startDate, endDate: args.endDate ?? args.patch?.endDate, durationWeeks: args.durationWeeks ?? args.patch?.durationWeeks });
      if (dates.error) return { error: { ok: false, status: "rejected", message: dates.error } };
      const next = { name, ...dates.dates };
      const changes = diffFields(items[0], next);
      if (!changes.length) return { error: { ok: false, status: "rejected", message: "No fields would change." } };
      console.info("[Agent update proposal]", JSON.stringify({ item: { type: items[0].kind, weekDate: items[0].native?.weekDate, plannedDate: items[0].native?.plannedDate, endDate: items[0].native?.endDate, durationWeeks: items[0].native?.durationWeeks, overrideDate: items[0].native?.overrideDate }, preview: next, patch: dates.patch }));
      return { action: tool, intentType: args.intentType || (args.name !== undefined ? "RENAME_ITEM" : "EDIT_DATE"), planRef: String(plan.planId || plan.id), input: { item: (({ native, name: itemName, laneId, startDate, endDate, durationDays, durationWeeks, ...target }) => target)(items[0]), name, startDate: dates.dates.startDate, endDate: dates.dates.endDate, durationWeeks: dates.dates.durationWeeks }, laneName: targetLane.name, preview: { kind: "update", item: items[0], changes, result: next } };
    }
    if (tool === "shiftItems") {
      const deltaDays = Number(args.deltaDays);
      if (!Number.isFinite(deltaDays) || !deltaDays) return { error: { ok: false, status: "rejected", message: "Specify a non-zero number of days to shift." } };
      const changes = items.map((item) => ({ item, before: item.startDate, after: addDays(item.startDate, deltaDays) }));
      return { action: tool, intentType: args.intentType || "EDIT_DATE", planRef: String(plan.planId || plan.id), input: { items: items.map(({ native, name, laneId, startDate, endDate, ...item }) => item), deltaDays }, laneName: [...new Set(items.map((item) => allLanes.find((lane) => lane.id === item.laneId)?.name || "Editable lane"))].join(", "), preview: { kind: "shift", changes, deltaDays }, scopeConfirmationRequired: items.length > AGENT_SCOPE_CONFIRMATION_THRESHOLD };
    }
    const item = items[0];
    if (tool === "markComplete") {
      const actualCompletionDate = args.actualCompletionDate || localDateOnly("UTC");
      return { action: tool, intentType: args.intentType || "MARK_COMPLETE", planRef: String(plan.planId || plan.id), input: { item: (({ native, name, laneId, startDate, endDate, ...target }) => target)(item), actualCompletionDate }, laneName: targetLane.name, preview: { kind: "complete", item, actualCompletionDate } };
    }
    const records = await actualsRepository.list(plan.owner || "", plan.planId || plan.id);
    const actual = records.find((record) => String(record.plannedItemId) === String(item.kind === "customMilestone" ? item.milestoneKey : item.stepId));
    return { action: tool, intentType: args.intentType || "DELETE_ITEM", planRef: String(plan.planId || plan.id), input: { item: (({ native, name, laneId, startDate, endDate, ...target }) => target)(item) }, laneName: targetLane.name, preview: { kind: "delete", item, actual: actual ? { date: actual.actualEndDate || actual.actualStartDate || "", delayDays: actual.delayDays ?? null } : null } };
  }
  const lane = resolveLane(args.lane, { lanes: allLanes });
  if (lane.status !== "resolved") return { error: resolverFailure(lane) };
  const targetLane = lane.candidate;
  const permission = canPerform(tool, targetLane, planState);
  if (!permission.allowed) return { error: { ok: false, status: "rejected", message: permission.reason } };
  const endDate = args.endDate || args.startDate;
  return { action: tool, planRef: String(plan.planId || plan.id), input: { ...args, lane: lane.value, endDate, type: endDate === args.startDate ? "milestone" : "duration" }, laneName: lane.candidate.name };
}

const READ_ONLY_CHAT_SYSTEM_PROMPT = [
  "You are the BTV Planner assistant.",
  "Return exactly JSON: {\"reply\":string,\"intent\":{\"type\":\"none\",\"targetCarline\":\"\",\"targetCommodity\":\"\"}}.",
  "You can answer plan facts, activity status, delays, and MOM history only from tool results returned in this conversation.",
  "Compact context is only for resolving public names. It is not evidence and must not be used to answer factual questions.",
  "Ask a clarifying question only when two or more distinct stable plan identities match and choosing one could make the answer wrong. Never ask about a time range, lanes, or intent category when a grounded default exists.",
  "For upcoming activities, milestones, next steps, or what is next, call queryItems with an empty date range when none is specified; the tool applies the next-30-days and all-lanes defaults. State that default in the reply. For recently or lately, query the preceding 30 days. For todos or open items across carlines, call queryAcrossPlans.",
  "Answer the most likely reading first, then briefly offer alternatives. Do not mention source-item counts, filtered counts, or truncation unless results are truncated or the engineer asks how the answer was derived. If queryItems returns no items and a nearestItem, name that item and its date.",
  "Only createPlanLane, createSubActivityLane, createSubActivity, createMilestone, updateItem, shiftItems, deleteItem, and markComplete are available writes. createPlanLane copies the Rule-Based Plan into My Plan; never substitute a sub-activity lane named My Plan. When the user explicitly asks to create My Plan, call createPlanLane immediately. Do not say it is unavailable, do not describe a hypothetical preview, and do not ask the user to approve in prose: the tool result makes the UI render the confirmation controls. createSubActivityLane creates a new named, color-tagged lane. createSubActivity adds a dated step and createMilestone adds a marker; both may target any editable My Plan or sub-activity lane, never Build Plan or Rule-Based Plan. updateItem, shiftItems, deleteItem, and markComplete must always be proposed first: never claim they executed, and use public item or lane names only. markComplete stores the completion date on the timeline item. If a requested item has no lane, ask which editable lane to use and offer creating a new sub-activity lane without asking again for its name or dates. Use them only after all schema-required fields are known. Their tool result is a proposal, not a write; present the resolved values and wait for explicit frontend confirmation. Journal and actual-store writes are unavailable.",
  "Use only public plan and lane names in tools. Never emit internal IDs."
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

app.post("/ai-chat", requireCurrentUser, async (req, res) => {
  try {
    const payload = req.body || {};
    const { messages, selectedPlanRef, selectedPlanName, selectedPlan, visibleLanes = {}, agentContext = {}, pendingAgentAction = null, recoverySession = null, timeZone: requestedTimeZone, referenceImages = [], planCount: clientPlanCount } = payload;

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "messages array is required" });
    }

    const timeZone = safeTimeZone(requestedTimeZone);
    const latestUserIndex = (() => {
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i] && messages[i].role === "user") return i;
      }
      return -1;
    })();
    const latestUserText = latestUserIndex >= 0 ? String(messages[latestUserIndex]?.content || "") : "";
    const ownedPlans = await getAllPlansForUser(req.currentUser);
    const sharedPlans = (await getSharedPlans(req.currentUser)).plans;
    const availablePlans = deduplicatePlansByStableId([...ownedPlans, ...sharedPlans], `chat context for ${req.currentUser}`);
    logLoadedPlans(`chat context for ${req.currentUser}`, availablePlans);
    if (Number.isInteger(clientPlanCount) && clientPlanCount !== availablePlans.length) {
      console.warn(`Chat plan-count drift: UI reported ${clientPlanCount}, context contains ${availablePlans.length}.`);
    }
    const selection = resolveSelectedPlan({ selectedPlanRef, selectedPlanName, selectedPlan }, availablePlans);
    await auditChatContext(req.currentUser, payload, selection);
    if (!availablePlans.length) {
      return res.json({ ok: true, reply: "I could not find any plans in your workspace yet.", intent: { type: "none", targetCarline: "", targetCommodity: "" } });
    }
    if (selection.status === "not_found") {
      return res.json({ ok: true, reply: `I found ${selection.planCount} plans but couldn't identify the selected one. Available plans: ${selection.candidates.map((candidate) => candidate.name).join("; ")}.`, intent: { type: "none", targetCarline: "", targetCommodity: "" } });
    }
    if (selection.status === "error") {
      return res.status(409).json({ ok: false, error: selection.message });
    }
    if (selection.status === "ambiguous") {
      return res.json({ ok: true, reply: `I found ${selection.planCount} plans, but the selected plan is ambiguous. Which one do you mean: ${selection.candidates.map((candidate) => candidate.name).join("; ")}?`, intent: { type: "none", targetCarline: "", targetCommodity: "" } });
    }
    const directEdit = parseTimelineEditIntent(latestUserText, timeZone);
    const dependencyIntent = parseDependencyIntent(latestUserText, timeZone);
    const recoveryIntent = parseRecoveryIntent(latestUserText);
    if (selection.status === "none" && !pendingAgentAction && !directEdit && !dependencyIntent && !recoveryIntent) {
      return res.json({ ok: true, reply: `I found ${selection.planCount} plans. Select one to ask timeline or MOM questions: ${availablePlans.map((plan) => publicPlanName(plan)).join("; ")}.`, intent: { type: "none", targetCarline: "", targetCommodity: "" } });
    }
    const selectedStoredPlan = selection.plan || null;

    if (recoverySession && selectedStoredPlan && /^(?:cancel(?:\s+it|\s+recovery)?|clear recovery)$/i.test(String(latestUserText || "").trim())) {
      return res.json({ ok: true, reply: "Recovery cancelled. No planning data changed.", intent: { type: "none", targetCarline: "", targetCommodity: "" }, recoveryAction: { type: "cancel" } });
    }
    if (recoverySession && selectedStoredPlan) {
      const recoveryFollowUp = parseRecoveryFollowUpIntent(latestUserText);
      if (recoveryFollowUp && Date.parse(recoverySession.expiresAt || "") <= Date.now()) return res.json({ ok: true, reply: "This recovery session expired. Please regenerate recovery options before applying or copying.", intent: { type: "none", targetCarline: "", targetCommodity: "" }, recoveryAction: { type: "expired" } });
      const activeScenario = recoverySession.scenarios?.find((scenario) => scenario.scenarioId === recoverySession.selectedScenarioId) || recoverySession.scenarios?.[0];
      if (recoveryFollowUp && activeScenario && !validateRecoveryScenario(selectedStoredPlan, activeScenario).ok) return res.json({ ok: true, reply: "The recovery baseline changed. Please regenerate recovery options before continuing.", intent: { type: "none", targetCarline: "", targetCommodity: "" }, recoveryAction: { type: "stale" } });
      if (recoveryFollowUp?.type === "SHOW_ANOTHER_RECOVERY_OPTION") {
        const feasible = (recoverySession.scenarios || []).filter((scenario) => scenario.feasible);
        const index = feasible.findIndex((scenario) => scenario.scenarioId === activeScenario?.scenarioId);
        const next = feasible[(index + 1) % feasible.length];
        if (!next || next.scenarioId === activeScenario?.scenarioId) return res.json({ ok: true, reply: "No further feasible recovery option is available for this validated baseline.", intent: { type: "none", targetCarline: "", targetCommodity: "" } });
        return res.json({ ok: true, reply: `Previewing alternative: ${next.title}. No planning data changed.`, intent: { type: "none", targetCarline: "", targetCommodity: "" }, recoveryAction: { type: "select-option", scenarioId: next.scenarioId }, structuredResponse: { type: "recovery_follow_up", intent: recoveryFollowUp.type, recoverySessionId: recoverySession.sessionId, optionId: next.scenarioId, result: "preview_ready" } });
      }
      if (recoveryFollowUp?.type === "CHANGE_RECOVERY_TARGET_LANE") return res.json({ ok: true, reply: `Recovery target set to ${recoveryFollowUp.targetLaneId === "my-plan-2" ? "My Plan 2" : "My Plan"}. Review and confirm before any change.`, intent: { type: "none", targetCarline: "", targetCommodity: "" }, recoveryAction: { type: "set-target-lane", targetLaneId: recoveryFollowUp.targetLaneId }, structuredResponse: { type: "recovery_follow_up", intent: recoveryFollowUp.type, recoverySessionId: recoverySession.sessionId, result: "target_selected" } });
      if (recoveryFollowUp?.type === "SHOW_RECOVERY_ON_TIMELINE" && activeScenario) return res.json({ ok: true, reply: `Showing ${activeScenario.changedItemCount} proposed recovery change${activeScenario.changedItemCount === 1 ? "" : "s"} on the timeline.`, intent: { type: "none", targetCarline: "", targetCommodity: "" }, recoveryAction: { type: "show-timeline", scenarioId: activeScenario.scenarioId } });
      if (["REMOVE_RECOVERY_CONSTRAINT", "UPDATE_RECOVERY_CONSTRAINT"].includes(recoveryFollowUp?.type) && activeScenario?.sourceItem) {
        const existingConstraints = activeScenario.protectedConstraints || [];
        const constraints = recoveryFollowUp.type === "REMOVE_RECOVERY_CONSTRAINT"
          ? existingConstraints.filter((constraint) => !normalizeAgentText(constraint.targetItemName).includes(normalizeAgentText(recoveryFollowUp.target || "")))
          : existingConstraints.map((constraint) => constraint.type === "MIN_GAP_BEFORE" ? { ...constraint, gapDays: recoveryFollowUp.gapDays } : constraint);
        if (recoveryFollowUp.type === "REMOVE_RECOVERY_CONSTRAINT" && constraints.length === existingConstraints.length) return res.json({ ok: true, reply: "I could not identify a unique protected constraint to remove.", intent: { type: "none", targetCarline: "", targetCommodity: "" } });
        if (recoveryFollowUp.type === "UPDATE_RECOVERY_CONSTRAINT" && !existingConstraints.some((constraint) => constraint.type === "MIN_GAP_BEFORE")) return res.json({ ok: true, reply: "There is no minimum-gap constraint in this recovery session to update.", intent: { type: "none", targetCarline: "", targetCommodity: "" } });
        const recovery = generateRecoveryScenarios(selectedStoredPlan, { laneId: recoverySession.sourceLane, sourceItemId: activeScenario.sourceItem.itemId, delayDays: activeScenario.sourceItem.shiftDays, objective: activeScenario.objective, constraints });
        return res.json({ ok: true, reply: recoveryFollowUp.type === "REMOVE_RECOVERY_CONSTRAINT" ? "Removed the protected constraint and regenerated recovery options. No planning data changed." : `Updated the recovery gap to ${recoveryFollowUp.gapDays} days and regenerated options. No planning data changed.`, intent: { type: "none", targetCarline: "", targetCommodity: "" }, recoveryScenarios: recovery, structuredResponse: { type: "recovery_follow_up", intent: recoveryFollowUp.type, recoverySessionId: recoverySession.sessionId, result: "preview_ready" } });
      }
      if (["APPLY_RECOVERY", "COPY_RECOVERY"].includes(recoveryFollowUp?.type)) {
        const targetLaneId = recoveryFollowUp.targetLaneId || recoverySession.targetLaneId;
        if (!targetLaneId || !activeScenario) return res.json({ ok: true, reply: "Which editable lane should receive this recovery? Choose My Plan or My Plan 2.", intent: { type: "none", targetCarline: "", targetCommodity: "" } });
        if (targetLaneId !== "my-plan" && targetLaneId !== "my-plan-2") return res.json({ ok: true, reply: "Recovery targets must be My Plan or My Plan 2.", intent: { type: "none", targetCarline: "", targetCommodity: "" } });
        const operation = recoveryFollowUp.type === "APPLY_RECOVERY" && targetLaneId === recoverySession.sourceLane ? "apply" : "copy";
        return res.json({ ok: true, reply: `${operation === "apply" ? "Apply" : "Copy"} ${activeScenario.title} to ${targetLaneId === "my-plan-2" ? "My Plan 2" : "My Plan"}? Please confirm.`, intent: { type: "none", targetCarline: "", targetCommodity: "" }, recoveryAction: { type: "request-confirmation", operation, scenarioId: activeScenario.scenarioId, targetLaneId }, structuredResponse: { type: "recovery_confirmation", operation, recoverySessionId: recoverySession.sessionId, optionId: activeScenario.scenarioId, targetLaneId, requiresConfirmation: true } });
      }
      const followUp = /^(?:protect|keep unchanged|do not move)\s+(.+?)(?:\s+too)?[?.]?$/i.exec(String(latestUserText || "").trim());
      if (followUp) {
        const activeScenario = recoverySession.scenarios?.find((scenario) => scenario.scenarioId === recoverySession.selectedScenarioId) || recoverySession.scenarios?.[0];
        const protectedMatches = getRecoveryReferences(selectedStoredPlan).filter((item) => item.protected && (normalizeAgentText(item.itemName) === normalizeAgentText(followUp[1]) || normalizeAgentText(item.itemName).includes(normalizeAgentText(followUp[1]))));
        if (protectedMatches.length !== 1 || !activeScenario?.sourceItem) return res.json({ ok: true, reply: protectedMatches.length > 1 ? `I found ${followUp[1]} in multiple sources. Please name the Build Plan or Rule-Based Plan target.` : `I could not resolve a unique protected target named ${followUp[1]}.`, intent: { type: "none", targetCarline: "", targetCommodity: "" } });
        const target = protectedMatches[0];
        const constraints = [...(activeScenario.protectedConstraints || []), { constraintId: `protected_${target.itemId}`, type: "NOT_AFTER", sourceItemId: activeScenario.sourceItem.itemId, targetItemId: target.itemId, targetItemName: target.itemName, targetLaneId: target.laneId, targetDate: target.endDate, source: target.laneName, protected: true }];
        const recovery = generateRecoveryScenarios(selectedStoredPlan, { laneId: recoverySession.sourceLane, sourceItemId: activeScenario.sourceItem.itemId, delayDays: activeScenario.sourceItem.shiftDays, objective: activeScenario.objective, constraints });
        return res.json({ ok: true, reply: recovery.ok ? `Regenerated recovery options with ${target.itemName} protected at ${target.endDate}.` : recovery.error, intent: { type: "none", targetCarline: "", targetCommodity: "" }, recoveryScenarios: recovery });
      }
    }

    if (pendingAgentAction?.intent === "RECOVERY" && pendingAgentAction.currentClarificationField === "recoveryConstraintTarget") {
      const answer = normalizeAgentText(latestUserText);
      const candidates = pendingAgentAction.constraintCandidates || [];
      const option = /(?:option\s*)?(\d+)/.exec(answer);
      const selected = option ? candidates[Number(option[1]) - 1] : candidates.find((candidate) => normalizeAgentText(candidate.laneName).includes(answer) || answer.includes(normalizeAgentText(candidate.laneName)));
      if (!selected) return res.json({ ok: true, reply: `Choose a protected target: ${candidates.map((candidate, index) => `${index + 1}. ${candidate.laneName} | ${candidate.itemName} | ${candidate.endDate}`).join("; ")}.`, intent: { type: "none", targetCarline: "", targetCommodity: "" }, pendingAgentAction });
      const request = { ...pendingAgentAction.requestedChanges, constraints: [{ constraintId: `protected_${selected.itemId}`, type: "NOT_AFTER", targetItemId: selected.itemId, targetItemName: selected.itemName, targetLaneId: selected.laneId, targetDate: selected.endDate, source: selected.laneName, protected: true }] };
      return res.json({ ok: true, reply: "Which recovery objective should this protected constraint prioritize?", intent: { type: "none", targetCarline: "", targetCommodity: "" }, pendingAgentAction: { ...pendingAgentAction, requestedChanges: request, status: "needs_clarification", currentClarificationField: "recoveryObjective", missingFields: ["recoveryObjective"], updatedAt: new Date().toISOString() } });
    }

    if (pendingAgentAction?.intent === "RECOVERY" && pendingAgentAction.currentClarificationField === "recoveryObjective") {
      const answer = normalizeAgentText(latestUserText);
      const objective = /final|option 1|first/.test(answer) ? "protect-finish" : /specific|option 2|second/.test(answer) ? "protect-finish" : /finish delay|option 3|third/.test(answer) ? "protect-finish" : /number.*changes|option 4|fourth/.test(answer) ? "minimum-change" : /movement|option 5|fifth/.test(answer) ? "lowest-risk" : "";
      if (!objective) return res.json({ ok: true, reply: "Choose: protect final date, protect a specific milestone, minimize finish delay, minimize changes, or minimize total date movement.", intent: { type: "none", targetCarline: "", targetCommodity: "" }, pendingAgentAction });
      const targetPlan = availablePlans.find((plan) => String(plan.planId || plan.id) === String(pendingAgentAction.selectedPlanId));
      const recovery = targetPlan ? generateRecoveryScenarios(targetPlan, { ...pendingAgentAction.requestedChanges, objective }) : null;
      return res.json({ ok: true, reply: recovery?.ok ? `Generated ${recovery.scenarios.length} deterministic recovery scenarios. Review the comparison before applying any option.` : recovery?.error || "Recovery scenarios could not be generated.", intent: { type: "none", targetCarline: "", targetCommodity: "" }, recoveryScenarios: recovery, pendingAgentAction: recovery?.ok ? { ...pendingAgentAction, status: "completed", currentClarificationField: "", missingFields: [] } : { ...pendingAgentAction, status: "failed" } });
    }

    if (recoveryIntent && selectedStoredPlan) {
      const context = createPlanResolverContext(selectedStoredPlan, { visibleLanes });
      const resolved = resolveItem(recoveryIntent.item, context);
      if (resolved.status !== "resolved") return res.json({ ok: true, reply: resolverFailure(resolved).message || "I could not resolve the delayed item.", intent: { type: "none", targetCarline: "", targetCommodity: "" } });
      const request = { laneId: agentContext.selectedLane || resolved.candidate.laneId, sourceItemId: resolved.candidate.id, delayDays: recoveryIntent.delayDays };
      const protectedName = recoveryIntent.gap?.targetName || recoveryIntent.protectedTarget;
      if (protectedName) {
        const protectedMatches = getRecoveryReferences(selectedStoredPlan).filter((item) => item.protected && (normalizeAgentText(item.itemName) === normalizeAgentText(protectedName) || normalizeAgentText(item.itemName).includes(normalizeAgentText(protectedName))));
        if (protectedMatches.length > 1) return res.json({ ok: true, reply: `I found ${protectedName} in multiple sources. Which one should be used as the recovery constraint? ${protectedMatches.map((item, index) => `${index + 1}. ${item.laneName} | ${item.itemName} | ${item.endDate} | Protected`).join("; ")}`, intent: { type: "none", targetCarline: "", targetCommodity: "" }, pendingAgentAction: { id: `recovery_${Date.now().toString(36)}`, intent: "RECOVERY", status: "needs_clarification", requestedChanges: request, selectedPlanId: String(selectedStoredPlan.planId || selectedStoredPlan.id), selectedItemId: resolved.candidate.id, selectedItemName: resolved.candidate.name, constraintCandidates: protectedMatches, missingFields: ["protectedTarget"], currentClarificationField: "recoveryConstraintTarget", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } });
        const target = protectedMatches[0];
        if (!target) return res.json({ ok: true, reply: `I could not find a protected milestone named ${protectedName}.`, intent: { type: "none", targetCarline: "", targetCommodity: "" } });
        request.constraints = [{ constraintId: `protected_${target.itemId}`, type: recoveryIntent.gap ? "MIN_GAP_BEFORE" : "NOT_AFTER", sourceItemId: recoveryIntent.gap ? resolved.candidate.id : "", targetItemId: target.itemId, targetItemName: target.itemName, targetLaneId: target.laneId, targetDate: target.endDate, gapDays: recoveryIntent.gap?.gapDays || 0, source: target.laneName, protected: true }];
      }
      if (!recoveryIntent.objective) return res.json({ ok: true, reply: "What should the recovery plan prioritize?", intent: { type: "none", targetCarline: "", targetCommodity: "" }, pendingAgentAction: { id: `recovery_${Date.now().toString(36)}`, intent: "RECOVERY", status: "needs_clarification", originalMessage: latestUserText, requestedChanges: request, selectedPlanId: String(selectedStoredPlan.planId || selectedStoredPlan.id), selectedItemId: resolved.candidate.id, selectedItemName: resolved.candidate.name, missingFields: ["recoveryObjective"], currentClarificationField: "recoveryObjective", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } });
      const recovery = generateRecoveryScenarios(selectedStoredPlan, { ...request, objective: recoveryIntent.objective });
      return res.json({ ok: true, reply: recovery.ok ? `Generated ${recovery.scenarios.length} deterministic recovery scenarios. Review the comparison before applying any option.` : recovery.error, intent: { type: "none", targetCarline: "", targetCommodity: "" }, recoveryScenarios: recovery });
    }

    if (pendingAgentAction?.intent === "CASCADE_SHIFT" && pendingAgentAction.currentClarificationField === "cascadeMode") {
      const answer = normalizeAgentText(latestUserText);
      if (/move only|option 1|first/.test(answer)) {
        return res.json({ ok: true, reply: "Move only source remains selected. Please confirm the original move proposal.", intent: { type: "none", targetCarline: "", targetCommodity: "" }, pendingAgentAction: { ...pendingAgentAction, status: "ready_for_confirmation", currentClarificationField: "", missingFields: [] } });
      }
      const mode = /minimum|option 2|second/.test(answer) ? "minimum-required" : /same|complete|option 3|third/.test(answer) ? "same-delta" : "";
      if (!mode) return res.json({ ok: true, reply: "Choose Move only source, Move the minimum required dependent items, Shift the complete downstream chain, or Cancel.", intent: { type: "none", targetCarline: "", targetCommodity: "" }, pendingAgentAction });
      const targetPlan = availablePlans.find((plan) => String(plan.planId || plan.id) === String(pendingAgentAction.selectedPlanId));
      const cascade = targetPlan ? buildCascadeProposal(targetPlan, pendingAgentAction.requestedChanges.sourceItemId, pendingAgentAction.requestedChanges.proposedStartDate, pendingAgentAction.requestedChanges.proposedEndDate, { mode }) : null;
      if (!cascade?.ok) return res.json({ ok: true, reply: cascade?.error || "I could not build a safe cascade preview.", intent: { type: "none", targetCarline: "", targetCommodity: "" }, pendingAgentAction: { ...pendingAgentAction, status: "failed" } });
      const proposal = { action: "applyCascadeShift", intentType: "CASCADE_SHIFT", planRef: String(targetPlan.planId || targetPlan.id), input: { proposal: cascade.proposal }, laneName: "Dependency cascade", preview: { kind: "cascade", cascade: cascade.proposal } };
      return res.json({ ok: true, reply: `Cascade preview ready. ${cascade.proposal.affectedItems.length} item${cascade.proposal.affectedItems.length === 1 ? "" : "s"} will change as one operation.`, intent: { type: "none", targetCarline: "", targetCommodity: "" }, writeProposal: proposal, pendingAgentAction: { ...pendingAgentAction, status: "ready_for_confirmation", currentClarificationField: "", missingFields: [], selectedItemId: pendingAgentAction.requestedChanges.sourceItemId } });
    }

    if (dependencyIntent && selectedStoredPlan) {
      const context = createPlanResolverContext(selectedStoredPlan, { visibleLanes });
      const analysisOptions = { laneId: agentContext.selectedLane || (selectedStoredPlan.customPlan?.active ? "my-plan" : selectedStoredPlan.customPlan2?.active ? "my-plan-2" : "") };
      if (dependencyIntent.type === "health") {
        const analysis = analyzeScheduleConflicts(selectedStoredPlan);
        return res.json({ ok: true, reply: `Dependency health: ${analysis.summary.healthy} healthy, ${analysis.summary.zeroSlack} with no buffer, ${analysis.summary.conflicts} conflicts, and ${analysis.summary.missingDates} missing dates.`, intent: { type: "none", targetCarline: "", targetCommodity: "" }, dependencyAnalysis: analysis });
      }
      if (dependencyIntent.type === "critical") {
        const analysis = calculateCriticalPath(selectedStoredPlan, analysisOptions);
        const primary = analysis.networks.find((network) => network.projectFinish === analysis.projectFinish);
        const names = (primary?.criticalPaths?.[0] || []).map((id) => analysis.items.find((item) => item.itemId === id)?.itemName).filter(Boolean);
        return res.json({ ok: true, reply: names.length ? `Critical path finishes ${analysis.projectFinish}: ${names.join(" → ")}.` : "No critical path could be calculated from the selected dated dependency network.", intent: { type: "none", targetCarline: "", targetCommodity: "" }, criticalPathAnalysis: analysis });
      }
      if (["add", "remove"].includes(dependencyIntent.type)) {
        const proposal = await createProposal(dependencyIntent.type === "add" ? "addDependency" : "removeDependency", dependencyIntent, selectedStoredPlan, { visibleLanes });
        if (proposal?.error) return res.json({ ok: true, reply: proposal.error.message || "I could not resolve both dependency items.", intent: { type: "none", targetCarline: "", targetCommodity: "" } });
        return res.json({ ok: true, reply: `${dependencyIntent.type === "add" ? "Dependency to add" : "Dependency to remove"}: ${proposal.preview.successor.name} ${dependencyIntent.type === "add" ? "depends on" : "no longer depends on"} ${proposal.preview.predecessor.name}. Please confirm.`, intent: { type: "none", targetCarline: "", targetCommodity: "" }, writeProposal: proposal });
      }
      const resolved = resolveItem(dependencyIntent.item, context);
      if (resolved.status !== "resolved") return res.json({ ok: true, reply: resolverFailure(resolved).message || "I could not resolve that item.", intent: { type: "none", targetCarline: "", targetCommodity: "" } });
      const item = getItemById(selectedStoredPlan, resolved.candidate.id);
      if (!item) return res.json({ ok: true, reply: "I could not find that dependency item.", intent: { type: "none", targetCarline: "", targetCommodity: "" } });
      if (dependencyIntent.type === "critical-impact") {
        const proposedStart = addDays(item.startDate, dependencyIntent.deltaDays);
        const proposedEnd = addDays(item.endDate, dependencyIntent.deltaDays);
        const analysis = analyzeCriticalPathImpact(selectedStoredPlan, item.id, proposedStart, proposedEnd, analysisOptions);
        return res.json({ ok: true, reply: analysis ? `The projected plan finish shifts by ${analysis.finishShiftDays} day${Math.abs(analysis.finishShiftDays) === 1 ? "" : "s"}. No dates were changed.` : "I could not calculate a critical-path impact for that move.", intent: { type: "none", targetCarline: "", targetCommodity: "" }, criticalPathAnalysis: analysis });
      }
      if (["float", "driver"].includes(dependencyIntent.type)) {
        const analysis = calculateCriticalPath(selectedStoredPlan, analysisOptions);
        const metrics = analysis.items.find((entry) => entry.itemId === item.id);
        if (!metrics) return res.json({ ok: true, reply: `${item.name} has no critical-path metrics in the selected analysis lane.`, intent: { type: "none", targetCarline: "", targetCommodity: "" }, criticalPathAnalysis: analysis });
        const drivers = metrics.drivingPredecessorIds.map((id) => getItemById(selectedStoredPlan, id)?.name || id);
        const reply = dependencyIntent.type === "float"
          ? `${item.name} has ${dependencyIntent.floatType === "free" ? metrics.freeFloatDays : metrics.totalFloatDays} days of ${dependencyIntent.floatType} float.`
          : `${item.name} is ${metrics.isCritical ? "critical" : "not critical"}. Earliest start: ${metrics.earliestStart}; latest start: ${metrics.latestStart}; driving predecessor: ${drivers.join(", ") || "none"}.`;
        return res.json({ ok: true, reply, intent: { type: "none", targetCarline: "", targetCommodity: "" }, criticalPathAnalysis: { ...analysis, targetItem: metrics } });
      }
      if (dependencyIntent.type === "slack") {
        const relationships = getItemDependencyMetrics(selectedStoredPlan, item.id);
        const conflicts = relationships.filter((relationship) => relationship.status === "conflict").length;
        const minimumSlack = relationships.filter((relationship) => Number.isFinite(relationship.slackDays)).reduce((minimum, relationship) => minimum === null || relationship.slackDays < minimum ? relationship.slackDays : minimum, null);
        return res.json({ ok: true, reply: relationships.length ? `${item.name} has ${minimumSlack ?? "unknown"} days of minimum dependency slack${conflicts ? ` and ${conflicts} conflict${conflicts === 1 ? "" : "s"}` : ""}.` : `${item.name} has no dependency relationships.`, intent: { type: "none", targetCarline: "", targetCommodity: "" }, dependencyAnalysis: { action: "ANALYZE_SLACK", planId: String(selectedStoredPlan.planId || selectedStoredPlan.id), carline: selectedStoredPlan.carline || "", targetItem: { itemId: item.id, itemName: item.name }, relationships, summary: analyzeScheduleConflicts(selectedStoredPlan).summary, result: "read-only" } });
      }
      if (dependencyIntent.type === "impact") {
        const end = item.endDate && Number.isFinite(dependencyIntent.deltaDays) ? addDays(item.endDate, dependencyIntent.deltaDays) : item.endDate;
        const impact = analyzeDownstreamImpact(selectedStoredPlan, item.id, item.startDate, end);
        const affected = impact.directSuccessors.length + impact.indirectDescendants.length;
        return res.json({ ok: true, reply: `${item.name} has ${affected} downstream dependent item${affected === 1 ? "" : "s"}. This is a preview only; no dates were changed.`, intent: { type: "none", targetCarline: "", targetCommodity: "" }, dependencyAnalysis: impact });
      }
      const related = dependencyIntent.type === "successors" ? getSuccessors(selectedStoredPlan, item.id) : dependencyIntent.type === "predecessors" ? getPredecessors(selectedStoredPlan, item.id) : [...getAllAncestors(selectedStoredPlan, item.id), ...getAllDescendants(selectedStoredPlan, item.id)];
      const label = dependencyIntent.type === "successors" ? "depends on" : dependencyIntent.type === "predecessors" ? "comes before" : "is in the dependency chain for";
      return res.json({ ok: true, reply: related.length ? `${related.map((entry) => entry.name).join(", ")} ${label} ${item.name}.` : `No items ${label} ${item.name}.`, intent: { type: "none", targetCarline: "", targetCommodity: "" }, dependencyAnalysis: { action: "SHOW_DEPENDENCY_CHAIN", sourceItem: { itemId: item.id, itemName: item.name, planId: String(selectedStoredPlan.planId || selectedStoredPlan.id), carline: selectedStoredPlan.carline || "", lane: item.laneName }, directSuccessors: getSuccessors(selectedStoredPlan, item.id).map((entry) => ({ itemId: entry.id, itemName: entry.name, laneId: entry.laneId })), indirectDescendants: getAllDescendants(selectedStoredPlan, item.id).map((entry) => ({ itemId: entry.id, itemName: entry.name, laneId: entry.laneId })), predecessors: getPredecessors(selectedStoredPlan, item.id).map((entry) => ({ itemId: entry.id, itemName: entry.name, laneId: entry.laneId })), result: "preview" }, navigation: { itemId: item.id, planId: String(selectedStoredPlan.planId || selectedStoredPlan.id), laneId: item.laneId, action: "SHOW_ME" } });
    }

    if (pendingAgentAction?.status === "needs_clarification" && Array.isArray(pendingAgentAction.candidateItems)) {
      const candidate = selectPendingCandidate(latestUserText, pendingAgentAction.candidateItems);
      if (!candidate) {
        const field = pendingAgentAction.currentClarificationField || "item";
        return res.json({
          ok: true,
          reply: `Please choose one ${field} option, for example \"option 1\" or its displayed name.`,
          intent: { type: "none", targetCarline: "", targetCommodity: "" },
          pendingAgentAction: { ...pendingAgentAction, updatedAt: new Date().toISOString() }
        });
      }
      const targetPlan = availablePlans.find((plan) => String(plan.planId || plan.id) === String(candidate.planRef));
      if (!candidate.editable) {
        return res.json({ ok: true, reply: `I found ${candidate.itemName} in the ${candidate.laneName}, but this lane is read-only. Copy it to My Plan before editing.`, intent: { type: "none", targetCarline: "", targetCommodity: "" }, pendingAgentAction: { ...pendingAgentAction, status: "failed", selectedItemId: candidate.itemId, selectedItemName: candidate.itemName, updatedAt: new Date().toISOString() }, navigation: { itemId: candidate.itemId, planId: candidate.planRef, laneId: candidate.laneId, isHidden: candidate.isHidden, wasCollapsed: candidate.isCollapsed, action: "SHOW_ME" } });
      }
      const edit = { action: pendingAgentAction.requestedChanges?.deltaDays !== undefined ? "shiftItems" : pendingAgentAction.intent === "DELETE_ITEM" ? "deleteItem" : pendingAgentAction.intent === "MARK_COMPLETE" ? "markComplete" : "updateItem", intentType: pendingAgentAction.intent, args: pendingAgentAction.requestedChanges || {} };
      const proposal = targetPlan ? await createProposal(edit.action, { ...edit.args, intentType: edit.intentType }, targetPlan, { visibleLanes, targetItemId: candidate.itemId }) : null;
      if (!proposal || proposal.error) {
        return res.json({ ok: true, reply: proposal?.error?.message || "That item is no longer available for editing.", intent: { type: "none", targetCarline: "", targetCommodity: "" }, pendingAgentAction: { ...pendingAgentAction, status: "failed", updatedAt: new Date().toISOString() } });
      }
      const readyAction = { ...pendingAgentAction, ...pendingActionResponse({ originalMessage: pendingAgentAction.originalMessage, edit, candidates: [candidate], selectedCandidate: candidate }), status: "ready_for_confirmation", candidateItems: [candidate], missingFields: [], currentClarificationField: "", confirmationStatus: "pending", updatedAt: new Date().toISOString() };
      return res.json({
        ok: true,
        reply: `I found ${candidate.itemName} in ${candidate.carline}, ${candidate.laneName}. Please confirm the proposed change.`,
        intent: { type: "none", targetCarline: "", targetCommodity: "" },
        writeProposal: proposal,
        pendingAgentAction: readyAction,
        navigation: { itemId: candidate.itemId, planId: candidate.planRef, laneId: candidate.laneId, isHidden: candidate.isHidden, wasCollapsed: candidate.isCollapsed, action: "SHOW_ME" }
      });
    }

    if (directEdit) {
      const rawTarget = directEdit.args.item || directEdit.args.items || "";
      const currentCandidates = selectedStoredPlan ? findEditCandidates([selectedStoredPlan], rawTarget, visibleLanes) : [];
      const candidates = currentCandidates.length ? currentCandidates : findEditCandidates(availablePlans, rawTarget, visibleLanes);
      if (candidates.length > 1) {
        const pending = pendingActionResponse({ originalMessage: latestUserText, edit: directEdit, candidates });
        const question = pending.currentClarificationField === "carline"
          ? `I found ${rawTarget} in multiple carlines. Which carline would you like to update?`
          : pending.currentClarificationField === "plan"
            ? `I found ${rawTarget} in multiple plans. Which plan should I use?`
            : `I found multiple ${rawTarget} items. Which lane should I update?`;
        return res.json({ ok: true, reply: question, intent: { type: "none", targetCarline: "", targetCommodity: "" }, pendingAgentAction: pending });
      }
      if (candidates.length === 1) {
        const candidate = candidates[0];
        if (!candidate.editable) {
          return res.json({ ok: true, reply: `I found ${candidate.itemName} in the ${candidate.laneName}, but this lane is read-only. Copy it to My Plan before editing.`, intent: { type: "none", targetCarline: "", targetCommodity: "" }, pendingAgentAction: { ...pendingActionResponse({ originalMessage: latestUserText, edit: directEdit, candidates: [candidate], selectedCandidate: candidate }), status: "failed" }, navigation: { itemId: candidate.itemId, planId: candidate.planRef, laneId: candidate.laneId, isHidden: candidate.isHidden, wasCollapsed: candidate.isCollapsed, action: "SHOW_ME" } });
        }
        const targetPlan = availablePlans.find((plan) => String(plan.planId || plan.id) === String(candidate.planRef));
        const proposal = targetPlan ? await createProposal(directEdit.action, { ...directEdit.args, intentType: directEdit.intentType }, targetPlan, { visibleLanes, targetItemId: candidate.itemId }) : null;
        if (proposal && !proposal.error) {
          const resolvedItem = getItemById(targetPlan, candidate.itemId);
          const proposedEnd = proposal.preview?.kind === "shift" ? addDays(resolvedItem?.endDate || "", Number(directEdit.args.deltaDays || 0)) : proposal.preview?.result?.endDate;
          const dependencyAnalysis = resolvedItem && proposedEnd ? analyzeDownstreamImpact(targetPlan, candidate.itemId, proposal.preview?.result?.startDate || resolvedItem.startDate, proposedEnd) : null;
          const affected = (dependencyAnalysis?.directSuccessors?.length || 0) + (dependencyAnalysis?.indirectDescendants?.length || 0);
          const hasConflict = (dependencyAnalysis?.conflicts?.length || 0) > 0;
          const impactMessage = hasConflict ? ` ${candidate.itemName} has ${affected} downstream dependent item${affected === 1 ? "" : "s"}; this is preview-only and no successor dates will move.` : "";
          const pendingAction = hasConflict ? {
            id: `cascade_${Date.now().toString(36)}`,
            intent: "CASCADE_SHIFT",
            status: "needs_clarification",
            originalMessage: latestUserText,
            requestedChanges: { sourceItemId: candidate.itemId, proposedStartDate: proposal.preview?.result?.startDate || resolvedItem.startDate, proposedEndDate: proposedEnd },
            selectedPlanId: String(targetPlan.planId || targetPlan.id),
            selectedItemId: candidate.itemId,
            selectedItemName: candidate.itemName,
            missingFields: ["cascadeMode"],
            currentClarificationField: "cascadeMode",
            confirmationRequired: true,
            confirmationStatus: "pending",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          } : { ...pendingActionResponse({ originalMessage: latestUserText, edit: directEdit, candidates: [candidate], selectedCandidate: candidate }), status: "ready_for_confirmation", missingFields: [], currentClarificationField: "" };
          return res.json({ ok: true, reply: `I found ${candidate.itemName} in the ${candidate.carline} plan, ${candidate.laneName}.${impactMessage} ${hasConflict ? "Choose how to handle the downstream items." : "Please confirm the proposed change."}`, intent: { type: "none", targetCarline: "", targetCommodity: "" }, writeProposal: proposal, dependencyAnalysis, pendingAgentAction: pendingAction });
        }
      }
    }
    const compactContext = selectedStoredPlan
      ? await (async () => {
          const lanes = buildReadLanes(selectedStoredPlan);
          const planOwner = selectedStoredPlan.owner || req.currentUser;
          const delaySummary = await getDelaySummaryForPlan(planOwner, selectedStoredPlan, lanes, timeZone);
          const journalCounts = await getJournalCounts(planOwner, selectedStoredPlan.planId || selectedStoredPlan.id, lanes);
          return createReadContext(selectedStoredPlan, visibleLanes, timeZone, delaySummary, journalCounts);
        })()
      : null;

    const contextMessages = [{ role: "system", content: READ_ONLY_CHAT_SYSTEM_PROMPT }];

    contextMessages.push({
      role: "system",
      content: [
        "Never claim a create succeeded until the frontend confirms it. All other writes remain unavailable.",
        "Grounding rule: answer factual plan, activity, delay, and MOM questions ONLY from tool results returned in this conversation.",
        "The compact context is for public-name resolution only, not evidence. If tool results cannot answer, say so plainly. Never infer or fabricate.",
        "Answer first with grounded defaults: missing time range means the next 30 days, missing lane means all visible lanes, next steps means upcoming activities and milestones, and recently means the prior 30 days. State the default in the answer; do not ask permission for it.",
        "Use public plan and lane names in tool arguments. Never use or request internal IDs.",
        "For ambiguous or unknown tool results, ask a concise clarifying question. updateItem, shiftItems, deleteItem, and markComplete may be proposed for editable items; they require frontend confirmation before execution.",
        "Return the existing JSON reply/intent object after tools finish. Keep intent.type as none for read-only chat.",
        "Compact selected-plan context: " + JSON.stringify(compactContext || { selectedPlan: null, availablePlans: availablePlans.map((plan) => publicPlanName(plan)), today: localDateOnly(timeZone), timeZone })
      ].join("\n")
    });

    if (/\b(?:create|copy|make)\s+(?:an?\s+)?my\s+plan\b/i.test(latestUserText)) {
      const proposal = await createProposal("createPlanLane", {}, selectedStoredPlan, { visibleLanes });
      if (proposal?.error) {
        return res.json({ ok: true, reply: proposal.error.message || "My Plan cannot be created.", intent: { type: "none", targetCarline: "", targetCommodity: "" } });
      }
      return res.json({
        ok: true,
        reply: `Ready to create My Plan from the Rule-Based Plan. ${proposal.copiedCount} milestones will be copied.`,
        intent: { type: "none", targetCarline: "", targetCommodity: "" },
        writeProposal: proposal
      });
    }

    const conversationalEdit = parseTimelineEditIntent(latestUserText, timeZone);
    if (conversationalEdit && /^(?:it|this|that)$/i.test(String(conversationalEdit.args.item || conversationalEdit.args.items || "").trim()) && agentContext.selectedItemName) {
      if (conversationalEdit.action === "shiftItems") conversationalEdit.args.items = agentContext.selectedItemName;
      else conversationalEdit.args.item = agentContext.selectedItemName;
    }
    if (conversationalEdit) {
      const proposal = await createProposal(conversationalEdit.action, { ...conversationalEdit.args, intentType: conversationalEdit.intentType }, selectedStoredPlan, { visibleLanes });
      if (proposal?.error) {
        return res.json({ ok: true, reply: proposal.error.message || "I could not find an editable timeline item for that request.", intent: { type: "none", targetCarline: "", targetCommodity: "" } });
      }
      const target = proposal.preview?.item?.name || proposal.preview?.changes?.[0]?.item?.name || "the selected item";
      const resolvedItem = proposal.preview?.item || proposal.preview?.changes?.[0]?.item;
      const visibilityNotice = resolvedItem?.isHidden
        ? " The item is currently hidden in the timeline."
        : resolvedItem?.isCollapsed
          ? " The item is currently in a collapsed timeline group."
          : "";
      const reply = conversationalEdit.intentType === "DELETE_ITEM"
        ? `I found ${target} in ${resolvedItem?.carline || selectedStoredPlan.carline}.${visibilityNotice} Are you sure you want to delete it?`
        : `I found ${target} in ${resolvedItem?.carline || selectedStoredPlan.carline}.${visibilityNotice} Please confirm the proposed change.`;
      return res.json({ ok: true, reply, intent: { type: "none", targetCarline: "", targetCommodity: "" }, writeProposal: proposal });
    }

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
    let writeProposal = null;
    try {
      const tools = [...createReadOnlyToolDefinitions(), ...createActionToolDefinitions()];
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const message = await requestModel(contextMessages, { tools, toolChoice: "auto", returnMessage: true });
        if (!Array.isArray(message.tool_calls) || !message.tool_calls.length) {
          raw = message.content || "";
          break;
        }
        contextMessages.push({ role: "assistant", content: message.content || "", tool_calls: message.tool_calls });
        for (const call of message.tool_calls) {
          const tool = call.function?.name;
          let args;
          try { args = JSON.parse(call.function?.arguments || "{}"); } catch { args = {}; }
          let result;
          if (tool === "createPlanLane" || tool === "createSubActivityLane" || tool === "createSubActivity" || tool === "createMilestone" || tool === "updateItem" || tool === "shiftItems" || tool === "deleteItem" || tool === "markComplete") {
            const proposal = selectedStoredPlan ? await createProposal(tool, args, selectedStoredPlan, { visibleLanes }) : null;
            if (!proposal) result = { ok: false, status: "not_found", message: "Select a plan before creating an item." };
            else if (proposal.error) result = proposal.error;
            else {
              writeProposal = proposal;
              result = { ok: true, requiresConfirmation: true, proposal };
            }
          } else result = await executeReadTool({ owner: req.currentUser, tool, args, plans: availablePlans, timeZone });
          if (result.ok === false && !["ambiguous", "not_found", "rejected"].includes(result.status)) await auditReadToolCall(req.currentUser, tool || "unknown", args, result);
          contextMessages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
        }
      }
      raw ||= "I could not complete a grounded read-only lookup.";
    } catch (err) { throw err; }
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
      const exists = ownedPlans.some((plan) => String(plan.carline || "").toLowerCase() === intent.targetCarline.toLowerCase());
      if (!exists) {
        intent = { type: "none", targetCarline: "", targetCommodity: "" };
      }
    }

    return res.json({ ok: true, reply, intent, writeProposal });
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