import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const root = process.cwd();
const outputDir = process.argv[2];

if (!outputDir) {
  throw new Error("Usage: node scripts/render-demo-video-frames.mjs <output-directory>");
}

const escapeXml = (value) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

const toSeconds = (value) => {
  const [hours, minutes, secondsAndMillis] = value.split(":");
  const [seconds, millis] = secondsAndMillis.split(",");
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds) + Number(millis) / 1000;
};

const wrapCaption = (caption, maxCharacters = 68) => {
  const words = caption.split(/\s+/);
  const lines = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > maxCharacters && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, 2);
};

const slideTimeline = [
  [0, path.join(outputDir, "01-pulse-home.png")],
  [21.5, path.join(root, "docs/architecture.png")],
  [46, path.join(outputDir, "03-demo-report.png")],
  [58, path.join(outputDir, "04-report-entered.png")],
  [67, path.join(outputDir, "05-report-review.png")],
  [75, path.join(outputDir, "06-qwen-coordinating.png")],
  [85, path.join(outputDir, "07-qwen-plan.png")],
  [102, path.join(outputDir, "08-override-gate.png")],
  [120, path.join(outputDir, "10-sandbox-outcome.png")],
  [128, path.join(root, "docs/evaluation-summary.png")],
  [149, path.join(root, "docs/proof/alibaba-function-compute-trigger.png")],
  [157, path.join(root, "docs/proof/alibaba-function-compute-trigger-details.png")],
  [165, path.join(root, "docs/architecture.png")],
];

const backgroundFor = (time) => {
  let selected = slideTimeline[0][1];
  for (const [start, image] of slideTimeline) {
    if (time < start) break;
    selected = image;
  }
  return selected;
};

const srt = await fs.readFile(path.join(root, "docs/demo-captions.srt"), "utf8");
const cues = srt
  .trim()
  .split(/\n\s*\n/)
  .map((block) => {
    const [, timing, ...captionLines] = block.split("\n");
    const [start, end] = timing.split(" --> ");
    return {
      start: toSeconds(start),
      end: toSeconds(end),
      caption: captionLines.join(" ").trim(),
    };
  });

await fs.mkdir(outputDir, { recursive: true });
const concatLines = ["ffconcat version 1.0"];

for (const [index, cue] of cues.entries()) {
  const framePath = path.join(outputDir, `frame-${String(index + 1).padStart(2, "0")}.png`);
  const lines = wrapCaption(cue.caption);
  const lineHeight = 47;
  const captionHeight = lines.length === 1 ? 92 : 132;
  const captionTop = 1080 - captionHeight - 42;
  const captionText = lines
    .map((line, lineIndex) => `<text x="960" y="${captionTop + 57 + lineIndex * lineHeight}" text-anchor="middle" fill="#ffffff" font-family="Arial, Helvetica, sans-serif" font-size="34" font-weight="700">${escapeXml(line)}</text>`)
    .join("");
  const overlay = Buffer.from(`
    <svg width="1920" height="1080" xmlns="http://www.w3.org/2000/svg">
      <rect x="54" y="32" width="525" height="54" rx="27" fill="#0f172a" fill-opacity="0.88"/>
      <text x="84" y="69" fill="#bfdbfe" font-family="Arial, Helvetica, sans-serif" font-size="25" font-weight="700" letter-spacing="2">PULSE · QWEN CLOUD · TRACK 4</text>
      <rect x="120" y="${captionTop}" width="1680" height="${captionHeight}" rx="26" fill="#020617" fill-opacity="0.88" stroke="#60a5fa" stroke-opacity="0.8" stroke-width="2"/>
      ${captionText}
    </svg>
  `);

  await sharp(backgroundFor(cue.start))
    .resize(1920, 1080, { fit: "contain", background: "#070d1a" })
    .composite([{ input: overlay, left: 0, top: 0 }])
    .png()
    .toFile(framePath);

  concatLines.push(`file '${framePath}'`);
  concatLines.push(`duration ${(cue.end - cue.start).toFixed(3)}`);
}

const outroPath = path.join(outputDir, "frame-outro.png");
await sharp(path.join(root, "docs/architecture.png"))
  .resize(1920, 1080, { fit: "contain", background: "#070d1a" })
  .png()
  .toFile(outroPath);
concatLines.push(`file '${outroPath}'`);
concatLines.push("duration 2.000");
concatLines.push(`file '${outroPath}'`);

await fs.writeFile(path.join(outputDir, "frames.ffconcat"), `${concatLines.join("\n")}\n`, "utf8");
