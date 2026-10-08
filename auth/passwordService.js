import bcrypt from "bcryptjs";

export const PASSWORD_POLICY_MESSAGE = "Password must contain at least 10 characters, uppercase, lowercase, a number and a symbol, and be at most 72 UTF-8 bytes.";

export function passwordCost() {
  const cost = Number(process.env.BCRYPT_COST || 12);
  if (!Number.isInteger(cost) || cost < 12 || cost > 15) {
    throw new Error("BCRYPT_COST must be an integer between 12 and 15.");
  }
  return cost;
}

export function isStrongPassword(password) {
  return typeof password === "string" && password.length >= 10
    && Buffer.byteLength(password, "utf8") <= 72
    && /[A-Z]/.test(password) && /[a-z]/.test(password)
    && /[0-9]/.test(password) && /[^A-Za-z0-9]/.test(password);
}

export async function hashPassword(plainPassword) {
  if (!isStrongPassword(plainPassword)) throw new Error(PASSWORD_POLICY_MESSAGE);
  return bcrypt.hash(plainPassword, passwordCost());
}

export async function verifyPassword(plainPassword, storedHash) {
  if (typeof plainPassword !== "string" || !plainPassword
    || Buffer.byteLength(plainPassword, "utf8") > 72
    || typeof storedHash !== "string" || !/^\$2[aby]\$(0[4-9]|1[0-5])\$[./A-Za-z0-9]{53}$/.test(storedHash)) return false;
  try {
    return await bcrypt.compare(plainPassword, storedHash);
  } catch {
    return false;
  }
}