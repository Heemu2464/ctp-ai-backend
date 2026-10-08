import path from "node:path";
import { fileURLToPath } from "node:url";
import { emitKeypressEvents } from "node:readline";
import { createInterface } from "node:readline/promises";
import dotenv from "dotenv";
import { createUserRepository } from "../auth/localAuth.js";

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function readPrivatePassword(prompt) {
  if (!process.stdin.isTTY) throw new Error("Password entry requires an interactive terminal.");
  process.stdout.write(prompt);
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = (error) => {
      process.stdin.off("keypress", onKey);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(value);
      value = "";
    };
    const onKey = (text, key = {}) => {
      if (key.ctrl && key.name === "c") return finish(new Error("Cancelled."));
      if (key.name === "return" || key.name === "enter") return finish();
      if (key.name === "backspace") value = Array.from(value).slice(0, -1).join("");
      else if (!key.ctrl && !key.meta && text && !/[\x00-\x1f\x7f]/.test(text) && value.length < 200) value += text;
    };
    process.stdin.on("keypress", onKey);
  });
}

export async function runAdminCommand({ users, values, readPassword = readPrivatePassword }) {
  if (Object.hasOwn(values, "password")) throw new Error("Do not pass passwords as command-line arguments.");
  let password = await readPassword("New private password (hidden): ");
  let confirmation = await readPassword("Confirm private password (hidden): ");
  try {
    if (password !== confirmation) throw new Error("Passwords do not match.");
    const result = values["reset-user-id"]
      ? await users.resetPassword({ userId: values["reset-user-id"], password })
      : await users.bootstrapAdmin({ shortId: values.shortId, displayName: values.displayName, email: values.email, password });
    if (!result.ok) throw new Error(result.error);
    return { ok: true, created: Boolean(result.created) };
  } finally {
    password = "";
    confirmation = "";
  }
}

async function main() {
  dotenv.config({ path: path.join(backendDir, ".env"), quiet: true });
  const args = process.argv.slice(2);
  const values = {};
  for (let index = 0; index < args.length; index += 2) values[args[index].replace(/^--/, "")] = args[index + 1];
  if (Object.hasOwn(values, "password")) throw new Error("Do not pass passwords as command-line arguments.");
  if (!values["reset-user-id"] && (!values.shortId || !values.displayName || !values.email)) {
    throw new Error("Usage: npm run auth:create-admin -- --shortId abcdefg --displayName \"Admin User\" --email admin@example.com; or --reset-user-id <id> after manual identity verification.");
  }
  if (values["reset-user-id"]) {
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    const verified = await prompt.question("After independently verifying the account holder, type VERIFIED: ");
    prompt.close();
    if (verified !== "VERIFIED") throw new Error("Manual identity verification required.");
  }
  const users = createUserRepository({ storageRoot: path.resolve(process.env.BTV_AUTH_STORAGE_ROOT || process.env.BTV_STORAGE_ROOT || path.join(backendDir, "..", "BTV_PLANNER")) });
  await users.migrateLegacyCredentials();
  await runAdminCommand({ users, values });
  console.log(values["reset-user-id"] ? "Password changed. Previous sessions are invalid." : "Approved admin created.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error("Admin operation failed. Check inputs, password policy, duplicate accounts and storage permissions.");
    process.exitCode = 1;
  });
}
