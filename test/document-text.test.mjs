import assert from "node:assert/strict";
import test from "node:test";
import zlib from "node:zlib";
import { cleanDocumentText, extractDocxText, extractOfficeImages, extractPptxText, imageSize, readZipEntries } from "../documentText.js";

function png(width, height, bytes = 6000) {
  const buffer = Buffer.alloc(bytes);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer);
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  buffer.writeUInt8(width % 251, bytes - 1);
  return buffer;
}

const imageRel = (id, target) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${target}"/>`;
const rels = (...items) => `<Relationships>${items.join("")}</Relationships>`;

function zip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    const compressed = zlib.deflateRawSync(data);
    const nameBuffer = Buffer.from(name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    locals.push(local, nameBuffer, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuffer);
    offset += 30 + nameBuffer.length + compressed.length;
  }
  const centralBuffer = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuffer, end]);
}

const slide = (...paragraphs) => `<p:sld><p:cSld><p:spTree>${paragraphs.map((text) => `<a:p><a:r><a:t>${text}</a:t></a:r></a:p>`).join("")}</p:spTree></p:cSld></p:sld>`;

test("extracts PowerPoint slide text in slide order", () => {
  const pptx = zip({
    "ppt/slides/slide10.xml": slide("Next steps", "EC approval by KW 46"),
    "ppt/slides/slide2.xml": slide("Heat-shrink tubing &amp; coating", "Thickness 11 &#181;m &#x2192; 6 &#181;m"),
    "ppt/slides/slide1.xml": slide("Bremsschlauch Steinschlag X591"),
    "ppt/presentation.xml": "<ignored/>"
  });
  assert.equal(extractPptxText(pptx), "Slide 1:\nBremsschlauch Steinschlag X591\n\nSlide 2:\nHeat-shrink tubing & coating\nThickness 11 µm → 6 µm\n\nSlide 10:\nNext steps\nEC approval by KW 46");
});

test("extracts Word paragraphs with tabs and line breaks", () => {
  const docx = zip({ "word/document.xml": "<w:document><w:body><w:p><w:r><w:t>Status:</w:t><w:tab/><w:t xml:space=\"preserve\">open </w:t></w:r></w:p><w:p><w:r><w:t>Supplier needs 6 weeks</w:t><w:br/><w:t>after EC</w:t></w:r></w:p></w:body></w:document>" });
  assert.equal(extractDocxText(docx), "Status: open\nSupplier needs 6 weeks\nafter EC");
});

test("rejects non-zip data and oversized entries", () => {
  assert.throws(() => readZipEntries(Buffer.from("not a zip file at all, definitely not"), () => true), /not a valid Office document/);
  const bomb = zip({ "ppt/slides/slide1.xml": "x".repeat(21 * 1024 * 1024) });
  assert.throws(() => extractPptxText(bomb), /too large/);
});

test("removes page numbers, confidentiality footers, and repeated headers", () => {
  const pages = Array.from({ length: 5 }, (_, index) => `Slide ${index + 1}:\nBTV Brake Hose Review\nTopic ${index + 1} finding\nConfidential - internal use only\n${index + 1} / 5`).join("\n\n");
  assert.equal(cleanDocumentText(pages), "Slide 1:\nTopic 1 finding\n\nSlide 2:\nTopic 2 finding\n\nSlide 3:\nTopic 3 finding\n\nSlide 4:\nTopic 4 finding\n\nSlide 5:\nTopic 5 finding");
  assert.equal(cleanDocumentText("Agenda\nCorrosion test passed on 12 Oct.\nThank you"), "Corrosion test passed on 12 Oct.");
});

test("reads image sizes from PNG, GIF, and JPEG headers", () => {
  assert.deepEqual(imageSize(png(800, 600)), { width: 800, height: 600 });
  const gif = Buffer.from("GIF89a\x40\x01\xf0\x00", "latin1");
  assert.deepEqual(imageSize(Buffer.concat([gif, Buffer.alloc(8)])), { width: 320, height: 240 });
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03, 0, 0, 0, 0]);
  assert.deepEqual(imageSize(jpeg), { width: 640, height: 480 });
  assert.equal(imageSize(Buffer.from("not an image")), null);
});

test("extracts only slide images in slide order, skipping layout logos, tiny images, vector images, and duplicates", () => {
  const pptx = zip({
    "ppt/slides/_rels/slide2.xml.rels": rels(imageRel("rId2", "../media/image3.png"), imageRel("rId3", "../media/image1.png")),
    "ppt/slides/_rels/slide1.xml.rels": rels(imageRel("rId2", "../media/image1.png"), imageRel("rId4", "../media/image4.emf"), imageRel("rId5", "../media/icon.png")),
    "ppt/slideLayouts/_rels/slideLayout1.xml.rels": rels(imageRel("rId1", "../media/logo.png")),
    "ppt/media/image1.png": png(1200, 700),
    "ppt/media/image3.png": png(900, 500),
    "ppt/media/image4.emf": Buffer.alloc(9000),
    "ppt/media/icon.png": png(64, 64),
    "ppt/media/logo.png": png(400, 200)
  });
  const images = extractOfficeImages(pptx, "pptx", { baseName: "Corrosion review" });
  assert.deepEqual(images.map((image) => image.name), ["Corrosion review - slide 1 1.png", "Corrosion review - slide 2 2.png"]);
  assert.ok(images.every((image) => image.type === "image/png" && image.dataUrl.startsWith("data:image/png;base64,iVBORw0KGgo")));

  const docx = zip({
    "word/_rels/document.xml.rels": rels(imageRel("rId7", "media/image1.png")),
    "word/_rels/header1.xml.rels": rels(imageRel("rId1", "media/header-logo.png")),
    "word/media/image1.png": png(1000, 800),
    "word/media/header-logo.png": png(500, 200)
  });
  assert.deepEqual(extractOfficeImages(docx, "docx", { baseName: "Report" }).map((image) => image.name), ["Report - image 1.png"]);
});
