import { LOCAL_IDENTITY_SOURCE } from "./localAuth.js";

export async function resolveAuthenticatedUser(req, usersRepository) {
  const auth = req.session?.auth;
  if (!auth || auth.identitySource !== LOCAL_IDENTITY_SOURCE || !auth.userId) return null;
  const user = await usersRepository.findById(auth.userId);
  if (!user || user.status !== "approved" || user.passwordResetRequired
    || Number(auth.credentialVersion || 0) !== user.credentialVersion) return null;
  return user;
}

export function createRequireAuth(usersRepository) {
  return async function requireAuth(req, res, next) {
    try {
      const user = await resolveAuthenticatedUser(req, usersRepository);
      if (!user) {
        return res.status(401).json({
          ok: false,
          code: "AUTHENTICATION_REQUIRED",
          error: "Please sign in before accessing plans."
        });
      }
      req.currentUser = user.shortId;
      req.currentUserId = user.id;
      req.currentUserRole = user.role;
      req.authUser = user;
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

export function requireAdmin(req, res, next) {
  if (req.currentUserRole !== "admin") {
    return res.status(403).json({ ok: false, code: "ADMIN_ONLY", error: "Admin access required." });
  }
  return next();
}
