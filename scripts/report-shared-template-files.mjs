import { readdir, stat } from "node:fs/promises";
import path from "node:path";

const storageRoot = path.resolve(process.env.BTV_STORAGE_ROOT || path.join(process.cwd(), "..", "BTV_PLANNER"));
const sharedRoot = path.join(storageRoot, "shared_templates");

async function walk(directory) {
  const results = [];
  let entries = [];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) results.push(...await walk(fullPath));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".json")) results.push(fullPath);
  }
  return results;
}

const files = await walk(sharedRoot);
console.log(`Shared template files found: ${files.length}`);
for (const file of files) {
  const details = await stat(file);
  console.log(`${file}\t${details.size} bytes`);
}
console.log("No files were changed or deleted.");
