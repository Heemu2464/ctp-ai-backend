import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { LOCAL_IDENTITY_SOURCE, sanitizeAuthUser } from "./localAuth.js";

function authResponse(user) {
  const safe = sanitizeAuthUser(user);
  return {
    ok: true,
    authenticated: true,
    user: safe.shortId,
    userId: safe.id,
    displayName: safe.displayName,
    email: safe.email,
    role: safe.role,
    identitySource: LOCAL_IDENTITY_SOURCE
  };
}

export function createLocalAuthRouter({ users, cookieName, storageRoot }) {
  const router = express.Router();

  router.post("/register", async (req, res) => {
    const result = await users.register(req.body || {});
    if (!result.ok) return res.status(result.code === "INVALID_INPUT" ? 400 : 409).json({ ok: false, code: result.code, error: result.error });
    return res.status(201).json({ ok: true, message: "Registration submitted. Await admin approval.", user: result.user });
  });

  router.post("/login", async (req, res) => {
    const { identifier = "", password = "", rememberMe = false } = req.body || {};
    const result = await users.authenticate({ identifier, password });
    if (!result.ok) {
      const status = result.code === "LOCKED" ? 429 : result.code === "NOT_APPROVED" ? 403 : 401;
      return res.status(status).json({ ok: false, code: result.code, error: result.error, retryAfterSeconds: result.retryAfterSeconds || 0 });
    }

    const safe = sanitizeAuthUser(result.user);
    await fs.mkdir(path.join(storageRoot, "users", safe.shortId), { recursive: true });
    return req.session.regenerate((error) => {
      if (error) return res.status(500).json({ ok: false, code: "SESSION_ERROR", error: "Could not initialize session." });
      req.session.auth = {
        identitySource: LOCAL_IDENTITY_SOURCE,
        userId: safe.id,
        shortId: safe.shortId,
        displayName: safe.displayName,
        email: safe.email,
        role: safe.role,
        credentialVersion: result.user.credentialVersion,
        rememberMe: Boolean(rememberMe),
        loginAt: Date.now(),
        lastSeenAt: Date.now()
      };
      if (req.session.cookie) {
        if (Boolean(rememberMe)) {
          req.session.cookie.maxAge = req.app.locals.rememberMeMaxAgeMs;
        } else {
          req.session.cookie.expires = false;
          req.session.cookie.maxAge = null;
        }
      }
      return res.json(authResponse(safe));
    });
  });

  router.get("/me", async (req, res) => {
    const auth = req.session?.auth;
    if (!auth || auth.identitySource !== LOCAL_IDENTITY_SOURCE || !auth.userId) {
      return res.status(401).json({ ok: false, authenticated: false, user: null });
    }
    const user = await users.findById(auth.userId);
    if (!user || user.status !== "approved" || user.passwordResetRequired
      || Number(auth.credentialVersion || 0) !== user.credentialVersion) {
      return req.session.destroy(() => {
        res.clearCookie(cookieName, { path: "/" });
        return res.status(401).json({ ok: false, authenticated: false, user: null });
      });
    }
    return res.json(authResponse(user));
  });

  router.post("/logout", (req, res) => {
    req.session.destroy(() => {
      res.clearCookie(cookieName, { path: "/" });
      return res.json({ ok: true });
    });
  });

  return router;
}
