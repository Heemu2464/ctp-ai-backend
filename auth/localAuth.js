import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { hashPassword, verifyPassword, isStrongPassword, PASSWORD_POLICY_MESSAGE } from "./passwordService.js";

export const LOCAL_IDENTITY_SOURCE = "local-pilot-auth";
const STATUS_VALUES = new Set(["pending", "approved", "rejected", "disabled"]);
const ROLE_VALUES = new Set(["user", "admin"]);
const SHORT_ID_PATTERN = /^[a-z]{7}$/;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
const MAX_FAILED_ATTEMPTS = 5;
const runFile = promisify(execFile);

function nowIso() {
  return new Date().toISOString();
}

function sanitizeFileName(value) {
  return String(value || "")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "") || "untitled";
}

export function normalizeShortId(value) {
  const normalized = String(value || "").trim().toLowerCase().replace(/[^a-z]/g, "");
  return SHORT_ID_PATTERN.test(normalized) ? normalized : "";
}

export function normalizeEmail(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized || !normalized.includes("@")) return "";
  return normalized;
}

function normalizeDisplayName(value, fallback = "") {
  return String(value || fallback || "").trim().slice(0, 120);
}

function normalizeRole(value) {
  const role = String(value || "").trim().toLowerCase();
  return ROLE_VALUES.has(role) ? role : "user";
}

function normalizeStatus(value) {
  const status = String(value || "").trim().toLowerCase();
  return STATUS_VALUES.has(status) ? status : "pending";
}

export function toPublicUser(user) {
  return {
    id: String(user.id || ""),
    shortId: normalizeShortId(user.shortId),
    displayName: normalizeDisplayName(user.displayName, user.shortId),
    email: normalizeEmail(user.email),
    status: normalizeStatus(user.status),
    role: normalizeRole(user.role),
    failedLoginAttempts: Number(user.failedLoginAttempts || 0),
    lockedUntil: Number(user.lockedUntil || 0),
    createdAt: user.createdAt || "",
    approvedAt: user.approvedAt || "",
    approvedBy: user.approvedBy || "",
    rejectedAt: user.rejectedAt || "",
    rejectedBy: user.rejectedBy || "",
    disabledAt: user.disabledAt || "",
    disabledBy: user.disabledBy || "",
    lastLoginAt: user.lastLoginAt || "",
    updatedAt: user.updatedAt || "",
    passwordUpdatedAt: user.passwordUpdatedAt || "",
    passwordResetRequired: Boolean(user.passwordResetRequired),
    credentialVersion: Number(user.credentialVersion || 0)
  };
}


export function validateRegistrationPayload(payload) {
  const shortId = normalizeShortId(payload?.shortId);
  const email = normalizeEmail(payload?.email);
  const displayName = normalizeDisplayName(payload?.displayName, shortId);
  const password = payload?.password;
  if (!shortId) return { error: "Short ID must be exactly 7 letters." };
  if (!email) return { error: "A valid email address is required." };
  if (!displayName) return { error: "Display name is required." };
  if (!isStrongPassword(password)) {
    return { error: PASSWORD_POLICY_MESSAGE };
  }
  return { value: { shortId, email, displayName, password } };
}

export function validatePasswordForReset(password) {
  return isStrongPassword(password);
}


function makeUserId(shortId) {
  const token = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  return `usr_${sanitizeFileName(shortId)}_${token}`;
}

export function createUserRepository({ storageRoot }) {
  const authDir = path.join(storageRoot, "auth");
  const usersFile = path.join(authDir, "users.json");
  let writeQueue = Promise.resolve();
  let initialization;

  async function initialize() {
    await fs.mkdir(authDir, { recursive: true, mode: 0o700 });
    if (process.platform === "win32") {
      const script = `
        $ErrorActionPreference = 'Stop'
        $owner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
        $principals = @($owner, [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'), [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
        $directoryAcl = [System.Security.AccessControl.DirectorySecurity]::new()
        $directoryAcl.SetOwner($owner)
        $directoryAcl.SetAccessRuleProtection($true, $false)
        $allowedIds = @($principals | ForEach-Object { $_.Value })
        foreach ($principal in $principals) {
          $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($principal, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')
          $directoryAcl.AddAccessRule($rule)
        }
        $existingDirectoryAcl = Get-Acl -LiteralPath $env:BTV_PRIVATE_DIRECTORY
        $unsafeDirectoryRules = @($existingDirectoryAcl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | Where-Object { $_.IdentityReference.Value -notin $allowedIds })
        if (-not $existingDirectoryAcl.AreAccessRulesProtected -or $unsafeDirectoryRules.Count -gt 0 -or $existingDirectoryAcl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $owner.Value) {
          Set-Acl -LiteralPath $env:BTV_PRIVATE_DIRECTORY -AclObject $directoryAcl
        }
        if (Test-Path -LiteralPath $env:BTV_PRIVATE_FILE) {
          $fileAcl = [System.Security.AccessControl.FileSecurity]::new()
          $fileAcl.SetOwner($owner)
          $fileAcl.SetAccessRuleProtection($true, $false)
          foreach ($principal in $principals) {
            $fileAcl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($principal, 'FullControl', 'Allow'))
          }
          $existingFileAcl = Get-Acl -LiteralPath $env:BTV_PRIVATE_FILE
          $unsafeFileRules = @($existingFileAcl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | Where-Object { $_.IdentityReference.Value -notin $allowedIds })
          if ($unsafeFileRules.Count -gt 0 -or $existingFileAcl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $owner.Value) {
            Set-Acl -LiteralPath $env:BTV_PRIVATE_FILE -AclObject $fileAcl
          }
        }
      `;
      try {
        await runFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
          env: { ...process.env, BTV_PRIVATE_DIRECTORY: authDir, BTV_PRIVATE_FILE: usersFile },
          windowsHide: true
        });
      } catch {
        throw new Error("Owner-restricted user storage permissions could not be applied.");
      }
    } else {
      await fs.chmod(authDir, 0o700);
    }
    try {
      await fs.writeFile(usersFile, JSON.stringify({ version: 1, users: [] }, null, 2), { encoding: "utf8", flag: "wx", mode: 0o600 });
    } catch (error) {
      if (error.code !== "EEXIST") throw new Error("User storage is unavailable.");
    }
    if (process.platform !== "win32") await fs.chmod(usersFile, 0o600);
  }

  async function ensureFile() {
    initialization ||= initialize();
    return initialization;
  }

  async function readStore() {
    await ensureFile();
    try {
      const parsed = JSON.parse(await fs.readFile(usersFile, "utf8"));
      if (!Array.isArray(parsed?.users)) throw new Error("Invalid user store.");
      return { version: 1, users: parsed.users };
    } catch {
      throw new Error("User storage could not be read safely.");
    }
  }

  async function writeStore(store) {
    const temp = `${usersFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
    const data = JSON.stringify({ version: 1, users: Array.isArray(store?.users) ? store.users : [] }, null, 2);
    try {
      const handle = await fs.open(temp, "wx", 0o600);
      try {
        await handle.writeFile(data, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temp, usersFile);
      if (process.platform !== "win32") await fs.chmod(usersFile, 0o600);
    } catch {
      await fs.unlink(temp).catch(() => {});
      throw new Error("User storage could not be written safely.");
    }
  }

  async function withWrite(mutator) {
    const next = writeQueue.then(async () => {
      const store = await readStore();
      const result = await mutator(store);
      await writeStore(store);
      return result;
    });
    writeQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  function findByShortId(store, shortId) {
    return store.users.find((user) => normalizeShortId(user.shortId) === shortId) || null;
  }

  function findByEmail(store, email) {
    return store.users.find((user) => normalizeEmail(user.email) === email) || null;
  }

  return {
    usersFile,
    async migrateLegacyCredentials() {
      return withWrite(async (store) => {
        let affected = 0;
        for (const user of store.users) {
          const unsafeFields = Object.keys(user).filter((field) => /password|passphrase|secret/i.test(field)
            && !["passwordHash", "passwordUpdatedAt", "passwordResetRequired"].includes(field));
          const validHash = /^\$2[aby]\$(0[4-9]|1[0-5])\$[./A-Za-z0-9]{53}$/.test(user.passwordHash || "");
          if (!unsafeFields.length && (validHash || user.passwordResetRequired)) continue;
          const legacyPassword = user.password || user.plainPassword;
          if (!validHash && isStrongPassword(legacyPassword)) {
            user.passwordHash = await hashPassword(legacyPassword);
            user.passwordResetRequired = false;
          } else if (!validHash) {
            delete user.passwordHash;
            user.passwordResetRequired = true;
          }
          for (const field of unsafeFields) delete user[field];
          user.credentialVersion = Number(user.credentialVersion || 0) + 1;
          affected += 1;
        }
        return { affected };
      });
    },
    async listPublicUsers() {
      const store = await readStore();
      return store.users.map(toPublicUser).sort((a, b) => String(a.shortId).localeCompare(String(b.shortId)));
    },
    async findById(id) {
      const store = await readStore();
      const user = store.users.find((entry) => String(entry.id) === String(id || ""));
      return user ? toPublicUser(user) : null;
    },
    async findByShortId(shortIdValue) {
      const shortId = normalizeShortId(shortIdValue);
      if (!shortId) return null;
      const store = await readStore();
      const user = findByShortId(store, shortId);
      return user ? toPublicUser(user) : null;
    },
    async register(payload) {
      const checked = validateRegistrationPayload(payload);
      if (!checked.value) return { ok: false, code: "INVALID_INPUT", error: checked.error };
      return withWrite(async (store) => {
        const { shortId, email, displayName, password } = checked.value;
        if (findByShortId(store, shortId)) return { ok: false, code: "SHORT_ID_EXISTS", error: "A user with this short ID already exists." };
        if (findByEmail(store, email)) return { ok: false, code: "EMAIL_EXISTS", error: "A user with this email already exists." };
        const time = nowIso();
        const user = {
          id: makeUserId(shortId),
          shortId,
          displayName,
          email,
          passwordHash: await hashPassword(password),
          status: "pending",
          role: "user",
          failedLoginAttempts: 0,
          lockedUntil: 0,
          createdAt: time,
          updatedAt: time,
          approvedAt: "",
          approvedBy: "",
          rejectedAt: "",
          rejectedBy: "",
          disabledAt: "",
          disabledBy: "",
          lastLoginAt: "",
          passwordUpdatedAt: time
        };
        store.users.push(user);
        return { ok: true, user: toPublicUser(user) };
      });
    },
    async authenticate({ identifier, password }) {
      const normalizedIdentifier = String(identifier || "").trim().toLowerCase();
      const shortId = normalizeShortId(normalizedIdentifier);
      const email = normalizeEmail(normalizedIdentifier);
      const plainPassword = typeof password === "string" ? password : "";
      if (!plainPassword || (!shortId && !email)) {
        return { ok: false, code: "INVALID_CREDENTIALS", error: "Invalid credentials." };
      }
      return withWrite(async (store) => {
        const user = shortId ? findByShortId(store, shortId) : findByEmail(store, email);
        if (!user) return { ok: false, code: "INVALID_CREDENTIALS", error: "Invalid credentials." };

        const now = Date.now();
        if (Number(user.lockedUntil || 0) > now) {
          return { ok: false, code: "LOCKED", error: "Account locked due to failed attempts.", retryAfterSeconds: Math.ceil((Number(user.lockedUntil) - now) / 1000) };
        }

        const verified = await verifyPassword(plainPassword, user.passwordHash);
        if (!verified) {
          const attempts = Number(user.failedLoginAttempts || 0) + 1;
          user.failedLoginAttempts = attempts;
          if (attempts >= MAX_FAILED_ATTEMPTS) {
            user.lockedUntil = now + LOGIN_LOCK_MS;
            user.failedLoginAttempts = 0;
          }
          user.updatedAt = nowIso();
          return { ok: false, code: Number(user.lockedUntil || 0) > now ? "LOCKED" : "INVALID_CREDENTIALS", error: "Invalid credentials.", retryAfterSeconds: Number(user.lockedUntil || 0) > now ? Math.ceil((Number(user.lockedUntil) - now) / 1000) : 0 };
        }

        if (user.passwordResetRequired) {
          return { ok: false, code: "RESET_REQUIRED", error: "Contact the pilot administrator for a manually verified password reset." };
        }

        if (normalizeStatus(user.status) !== "approved") {
          return {
            ok: false,
            code: "NOT_APPROVED",
            error: user.status === "pending" ? "Your account is awaiting admin approval." : user.status === "rejected" ? "Your account registration was rejected." : "Your account is disabled."
          };
        }

        user.failedLoginAttempts = 0;
        user.lockedUntil = 0;
        user.lastLoginAt = nowIso();
        user.updatedAt = nowIso();
        return { ok: true, user: toPublicUser(user) };
      });
    },
    async setStatus({ userId, status, actorUserId }) {
      const nextStatus = normalizeStatus(status);
      if (!STATUS_VALUES.has(nextStatus)) return { ok: false, code: "INVALID_STATUS", error: "Invalid status." };
      return withWrite(async (store) => {
        const user = store.users.find((entry) => String(entry.id) === String(userId || ""));
        if (!user) return { ok: false, code: "NOT_FOUND", error: "User not found." };
        user.status = nextStatus;
        const ts = nowIso();
        user.updatedAt = ts;
        if (nextStatus === "approved") {
          user.approvedAt = ts;
          user.approvedBy = actorUserId || "";
          user.rejectedAt = "";
          user.rejectedBy = "";
          user.disabledAt = "";
          user.disabledBy = "";
        } else if (nextStatus === "rejected") {
          user.rejectedAt = ts;
          user.rejectedBy = actorUserId || "";
        } else if (nextStatus === "disabled") {
          user.disabledAt = ts;
          user.disabledBy = actorUserId || "";
        }
        return { ok: true, user: toPublicUser(user) };
      });
    },
    async setRole({ userId, role }) {
      const nextRole = normalizeRole(role);
      return withWrite(async (store) => {
        const user = store.users.find((entry) => String(entry.id) === String(userId || ""));
        if (!user) return { ok: false, code: "NOT_FOUND", error: "User not found." };
        if (user.role === "admin" && nextRole !== "admin") {
          const activeAdmins = store.users.filter((entry) => entry.role === "admin" && entry.status === "approved");
          if (activeAdmins.length <= 1) {
            return { ok: false, code: "LAST_ADMIN", error: "At least one approved admin must remain." };
          }
        }
        user.role = nextRole;
        user.updatedAt = nowIso();
        return { ok: true, user: toPublicUser(user) };
      });
    },
    async unlock({ userId }) {
      return withWrite(async (store) => {
        const user = store.users.find((entry) => String(entry.id) === String(userId || ""));
        if (!user) return { ok: false, code: "NOT_FOUND", error: "User not found." };
        user.failedLoginAttempts = 0;
        user.lockedUntil = 0;
        user.updatedAt = nowIso();
        return { ok: true, user: toPublicUser(user) };
      });
    },
    async resetPassword({ userId, password }) {
      if (!validatePasswordForReset(password)) {
        return { ok: false, code: "WEAK_PASSWORD", error: PASSWORD_POLICY_MESSAGE };
      }
      return withWrite(async (store) => {
        const user = store.users.find((entry) => String(entry.id) === String(userId || ""));
        if (!user) return { ok: false, code: "NOT_FOUND", error: "User not found." };
        user.passwordHash = await hashPassword(password);
        user.passwordResetRequired = false;
        user.credentialVersion = Number(user.credentialVersion || 0) + 1;
        user.passwordUpdatedAt = nowIso();
        user.failedLoginAttempts = 0;
        user.lockedUntil = 0;
        user.updatedAt = nowIso();
        return { ok: true, user: toPublicUser(user) };
      });
    },
    async requirePasswordReset({ userId }) {
      return withWrite(async (store) => {
        const user = store.users.find((entry) => String(entry.id) === String(userId || ""));
        if (!user) return { ok: false, code: "NOT_FOUND", error: "User not found." };
        user.passwordResetRequired = true;
        user.credentialVersion = Number(user.credentialVersion || 0) + 1;
        user.updatedAt = nowIso();
        return { ok: true, user: toPublicUser(user) };
      });
    },
    async bootstrapAdmin({ shortId, displayName, email, password }) {
      const checked = validateRegistrationPayload({ shortId, displayName, email, password });
      if (!checked.value) return { ok: false, code: "INVALID_INPUT", error: checked.error };
      return withWrite(async (store) => {
        const existing = findByShortId(store, checked.value.shortId) || findByEmail(store, checked.value.email);
        if (existing) {
          return { ok: false, code: "USER_EXISTS", error: "Short ID or email already exists. Admin creation never overwrites accounts." };
        }

        const ts = nowIso();
        const user = {
          id: makeUserId(checked.value.shortId),
          shortId: checked.value.shortId,
          displayName: checked.value.displayName,
          email: checked.value.email,
          passwordHash: await hashPassword(checked.value.password),
          status: "approved",
          role: "admin",
          failedLoginAttempts: 0,
          lockedUntil: 0,
          createdAt: ts,
          updatedAt: ts,
          approvedAt: ts,
          approvedBy: "bootstrap",
          rejectedAt: "",
          rejectedBy: "",
          disabledAt: "",
          disabledBy: "",
          lastLoginAt: "",
          passwordUpdatedAt: ts
        };
        store.users.push(user);
        return { ok: true, created: true, user: toPublicUser(user) };
      });
    }
  };
}

export function sanitizeAuthUser(user) {
  return {
    id: String(user?.id || ""),
    shortId: normalizeShortId(user?.shortId),
    displayName: normalizeDisplayName(user?.displayName, user?.shortId),
    email: normalizeEmail(user?.email),
    status: normalizeStatus(user?.status),
    role: normalizeRole(user?.role)
  };
}
