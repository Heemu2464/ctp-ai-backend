import zlib from "node:zlib";

const MAX_ENTRY_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_BYTES = 60 * 1024 * 1024;

// Minimal ZIP reader for Office files; only returns entries accepted by `wanted`, with size limits against zip bombs.
export function readZipEntries(buffer, wanted) {
  const searchStart = Math.max(0, buffer.length - 65557);
  let end = -1;
  for (let offset = buffer.length - 22; offset >= searchStart; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) { end = offset; break; }
  }
  if (end < 0) throw new Error("This file is not a valid Office document.");
  const count = buffer.readUInt16LE(end + 10);
  let pointer = buffer.readUInt32LE(end + 16);
  const entries = new Map();
  let total = 0;
  for (let index = 0; index < count && pointer + 46 <= buffer.length; index += 1) {
    if (buffer.readUInt32LE(pointer) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(pointer + 10);
    const compressedSize = buffer.readUInt32LE(pointer + 20);
    const size = buffer.readUInt32LE(pointer + 24);
    const nameLength = buffer.readUInt16LE(pointer + 28);
    const extraLength = buffer.readUInt16LE(pointer + 30);
    const commentLength = buffer.readUInt16LE(pointer + 32);
    const localOffset = buffer.readUInt32LE(pointer + 42);
    const name = buffer.toString("utf8", pointer + 46, pointer + 46 + nameLength);
    pointer += 46 + nameLength + extraLength + commentLength;
    if (!wanted(name)) continue;
    if (size > MAX_ENTRY_BYTES || (total += size) > MAX_TOTAL_BYTES) throw new Error("The document is too large to read.");
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) continue;
    const dataStart = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    const data = buffer.subarray(dataStart, dataStart + compressedSize);
    if (method === 0) entries.set(name, data);
    else if (method === 8) entries.set(name, zlib.inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES }));
  }
  return entries;
}

function decodeXmlText(value) {
  return value
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (match, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (match, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, "&");
}

function paragraphsFromXml(xml, paragraphTag, textTag) {
  return xml.split(new RegExp(`</${paragraphTag}>`)).map((paragraph) => {
    const runs = [...paragraph.matchAll(new RegExp(`<${textTag}(?:\\s[^>]*)?>([^<]*)</${textTag}>|<(?:w:tab|a:tab)\\s*/>|<(?:w:br|a:br)\\b[^>]*/?>`, "g"))]
      .map((match) => match[1] !== undefined ? decodeXmlText(match[1]) : match[0].includes("tab") ? "\t" : "\n");
    return runs.join("").replace(/[ \t]+/g, " ").trim();
  }).filter(Boolean);
}

const slideNumber = (name) => Number(/(\d+)\.xml(?:\.rels)?$/.exec(name)?.[1] || 0);

const IMAGE_TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", bmp: "image/bmp", webp: "image/webp" };

// Pixel size from PNG/GIF/BMP/JPEG headers; null when unknown.
export function imageSize(buffer) {
  if (buffer.length > 24 && buffer.readUInt32BE(0) === 0x89504e47) return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  if (buffer.length > 10 && buffer.toString("ascii", 0, 3) === "GIF") return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  if (buffer.length > 26 && buffer.toString("ascii", 0, 2) === "BM") return { width: buffer.readInt32LE(18), height: Math.abs(buffer.readInt32LE(22)) };
  if (buffer.length > 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    for (let offset = 2; offset + 9 < buffer.length;) {
      if (buffer[offset] !== 0xff) { offset += 1; continue; }
      const marker = buffer[offset + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
      offset += 2 + buffer.readUInt16BE(offset + 2);
    }
  }
  return null;
}

// Images placed on slides (PPTX) or in the document body (DOCX), in reading order; layout logos and header/footer images are not referenced there.
export function extractOfficeImages(buffer, kind, { baseName = "document", max = 12, minSide = 120, minBytes = 4096 } = {}) {
  const relsPattern = kind === "pptx" ? /^ppt\/slides\/_rels\/slide\d+\.xml\.rels$/ : /^word\/_rels\/document\.xml\.rels$/;
  const mediaPrefix = kind === "pptx" ? "ppt/media/" : "word/media/";
  const entries = readZipEntries(buffer, (name) => relsPattern.test(name) || name.startsWith(mediaPrefix));
  const images = [];
  const seen = new Set();
  for (const relsName of [...entries.keys()].filter((name) => relsPattern.test(name)).sort((left, right) => slideNumber(left) - slideNumber(right))) {
    const targets = [...entries.get(relsName).toString("utf8").matchAll(/<Relationship\b[^>]*>/g)]
      .map((match) => match[0])
      .filter((tag) => /\bType="[^"]*\/image"/.test(tag) && !/\bTargetMode="External"/.test(tag))
      .map((tag) => /\bTarget="([^"]+)"/.exec(tag)?.[1])
      .filter(Boolean);
    for (const target of targets) {
      const mediaName = `${mediaPrefix}${target.replace(/^(?:\.\.\/)?media\//, "")}`;
      const data = entries.get(mediaName);
      const type = IMAGE_TYPES[/\.([a-z0-9]+)$/i.exec(mediaName)?.[1].toLowerCase()];
      if (!data || !type || seen.has(mediaName) || data.length < minBytes) continue;
      const size = imageSize(data);
      if (size && (size.width < minSide || size.height < minSide)) continue;
      seen.add(mediaName);
      const where = kind === "pptx" ? `slide ${slideNumber(relsName)}` : "image";
      images.push({ name: `${baseName} - ${where} ${images.length + 1}.${mediaName.split(".").pop()}`, type, dataUrl: `data:${type};base64,${data.toString("base64")}` });
      if (images.length >= max) return images;
    }
  }
  return images;
}

export function extractPptxText(buffer) {
  const entries = readZipEntries(buffer, (name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
  return [...entries.keys()].sort((left, right) => slideNumber(left) - slideNumber(right)).map((name) => {
    const lines = paragraphsFromXml(entries.get(name).toString("utf8"), "a:p", "a:t");
    return lines.length ? `Slide ${slideNumber(name)}:\n${lines.join("\n")}` : "";
  }).filter(Boolean).join("\n\n");
}

export function extractDocxText(buffer) {
  const entries = readZipEntries(buffer, (name) => name === "word/document.xml");
  const xml = entries.get("word/document.xml");
  return xml ? paragraphsFromXml(xml.toString("utf8"), "w:p", "w:t").join("\n") : "";
}

const NOISE_LINES = [
  /^(?:page|seite|folie|slide)?\s*\d+\s*(?:\/|of|von)?\s*\d*$/i,
  /\b(?:confidential|vertraulich|internal use only|nur f(?:ü|ue)r den internen gebrauch|all rights reserved|alle rechte vorbehalten)\b/i,
  /^(?:©|\(c\))\s*\d{4}/i,
  /^(?:agenda|thank you|vielen dank|questions\??|fragen\??|backup)$/i
];

// Drops page numbers, confidentiality footers, and lines repeated on most pages/slides (headers and footers).
export function cleanDocumentText(text) {
  const lines = String(text || "").replace(/\r/g, "").split("\n").map((line) => line.replace(/\s+/g, " ").trim());
  const counts = new Map();
  for (const line of lines) if (line.length > 3 && line.length < 120) counts.set(line, (counts.get(line) || 0) + 1);
  const sections = Math.max(1, lines.filter((line) => /^Slide \d+:$/.test(line)).length || (text.match(/\f/g) || []).length + 1);
  return lines
    .filter((line) => !line || /^Slide \d+:$/.test(line) || !(NOISE_LINES.some((pattern) => pattern.test(line)) || (sections >= 4 && counts.get(line) >= Math.max(3, sections * 0.6))))
    .join("\n")
    .replace(/Slide \d+:\n(?=\n|Slide \d+:|$)/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
