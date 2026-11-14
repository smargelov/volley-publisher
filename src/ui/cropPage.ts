import type { ThumbnailOverlay } from "../core/text.js";

/** Data the thumbnail editor needs; injected into the HTML as JSON. */
export interface CropPageConfig {
  token: string;
  /** Positions of the preview frames in the video, seconds. Empty when cropping is skipped. */
  frameTimes: number[];
  /** Source video size in pixels, used to report the real crop resolution. */
  sourceWidth: number;
  sourceHeight: number;
  /** Target thumbnail size in pixels; defines the locked aspect ratio. */
  targetWidth: number;
  targetHeight: number;
  title: string;
  overlay: ThumbnailOverlay;
  /** Channel colors as #RRGGBB: accent, and the dark color for text on the accent. */
  colors: { accent: string; background: string };
  /** Start at the design step with an already rendered base frame. */
  startAtCompose: boolean;
}

/**
 * Builds the single-page thumbnail editor.
 * Step 1: pick a frame and move/resize a fixed-ratio crop box.
 * Step 2: preview the frame with the channel graphics and save it.
 */
export function renderCropPage(config: CropPageConfig): string {
  // "<" is escaped so user-provided texts cannot close the script tag.
  const configJson = JSON.stringify(config).replace(/</g, "\\u003c");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Thumbnail editor</title>
<style>
  @font-face { font-family: "Inter Display"; font-weight: 700; src: url("/fonts/InterDisplay-Bold.otf?token=${config.token}"); }
  @font-face { font-family: "Inter Display"; font-weight: 800; src: url("/fonts/InterDisplay-ExtraBold.otf?token=${config.token}"); }
  @font-face { font-family: "Inter Display"; font-weight: 900; src: url("/fonts/InterDisplay-Black.otf?token=${config.token}"); }
  * { box-sizing: border-box; }
  body { margin: 0; background: #111; color: #eee; font: 14px/1.4 -apple-system, system-ui, sans-serif;
         display: flex; flex-direction: column; height: 100vh; user-select: none; }
  header, footer { padding: 10px 16px; display: flex; align-items: center; gap: 16px; flex: none; }
  header { justify-content: space-between; }
  h1 { font-size: 14px; font-weight: 600; margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #info.warn { color: #ffb347; }
  main { flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; gap: 24px; padding: 0 16px; }
  #stage { position: relative; overflow: hidden; line-height: 0; touch-action: none; }
  #frame { display: block; max-width: calc(100vw - 32px); max-height: calc(100vh - 150px); }
  #box { position: absolute; border: 2px solid #fff; box-shadow: 0 0 0 9999px rgba(0,0,0,.6); cursor: move; }
  #box::before, #box::after { content: ""; position: absolute; pointer-events: none; border: 0 solid rgba(255,255,255,.35); }
  #box::before { inset: 0 33.33%; border-width: 0 1px; }
  #box::after { inset: 33.33% 0; border-width: 1px 0; }
  .handle { position: absolute; width: 16px; height: 16px; background: #fff; border-radius: 50%; }
  .handle[data-h="nw"] { left: -9px; top: -9px; cursor: nwse-resize; }
  .handle[data-h="ne"] { right: -9px; top: -9px; cursor: nesw-resize; }
  .handle[data-h="sw"] { left: -9px; bottom: -9px; cursor: nesw-resize; }
  .handle[data-h="se"] { right: -9px; bottom: -9px; cursor: nwse-resize; }
  #result { max-width: calc(100vw - 420px); max-height: calc(100vh - 150px); border-radius: 6px; }
  #feed { width: 320px; height: 180px; border-radius: 6px; }
  .side { display: flex; flex-direction: column; gap: 8px; }
  input[type=range] { flex: 1; }
  .spacer { flex: 1; }
  button { font: inherit; padding: 8px 18px; border-radius: 8px; border: 1px solid #555; background: #222; color: #eee; cursor: pointer; }
  button.primary { background: #2f6fed; border-color: #2f6fed; color: #fff; }
  button:disabled { opacity: .5; cursor: default; }
  .hint { color: #999; }
  .hidden { display: none !important; }
  #message { flex: 1; display: flex; align-items: center; justify-content: center; font-size: 18px; }
</style>
</head>
<body>
<header>
  <h1 id="title"></h1>
  <span id="info"></span>
</header>

<main id="cropView">
  <div id="stage">
    <img id="frame" alt="Video frame" draggable="false">
    <div id="box">
      <div class="handle" data-h="nw"></div><div class="handle" data-h="ne"></div>
      <div class="handle" data-h="sw"></div><div class="handle" data-h="se"></div>
    </div>
  </div>
</main>
<footer id="cropBar">
  <span id="frameLabel"></span>
  <input id="slider" type="range" min="0" step="1">
  <span class="hint">&larr; &rarr; frame &middot; drag to move &middot; corners or wheel to resize</span>
  <button id="cancelCrop">Cancel (Esc)</button>
  <button id="next" class="primary">Next (Enter)</button>
</footer>

<main id="composeView" class="hidden">
  <canvas id="result"></canvas>
  <div class="side">
    <span class="hint">Feed size</span>
    <canvas id="feed"></canvas>
  </div>
</main>
<footer id="composeBar" class="hidden">
  <button id="back">&larr; Back to crop</button>
  <span class="spacer"></span>
  <button id="cancelCompose">Cancel (Esc)</button>
  <button id="save" class="primary">Save thumbnail (Enter)</button>
</footer>

<div id="message" class="hidden"></div>

<script>
const config = ${configJson};
const tokenQuery = "?token=" + config.token;
const $ = (id) => document.getElementById(id);

// ---------- Step switching ----------

let step = "crop";

function showStep(name) {
  step = name;
  $("cropView").classList.toggle("hidden", name !== "crop");
  $("cropBar").classList.toggle("hidden", name !== "crop");
  $("composeView").classList.toggle("hidden", name !== "compose");
  $("composeBar").classList.toggle("hidden", name !== "compose");
  $("message").classList.toggle("hidden", name !== "message");
  document.querySelector("header").classList.toggle("hidden", name === "message");
  if (name === "compose") $("info").textContent = "Preview with channel graphics";
  if (name === "crop") renderCrop();
}

function showMessage(text) {
  $("message").textContent = text;
  showStep("message");
}

// Closing the tab without saving counts as cancelling, so the tool does not keep waiting.
window.addEventListener("pagehide", () => {
  if (step !== "message") navigator.sendBeacon("/cancel" + tokenQuery);
});

async function post(path, body, contentType) {
  const response = await fetch(path + tokenQuery, {
    method: "POST",
    headers: { "Content-Type": contentType },
    body,
  });
  if (!response.ok) throw new Error((await response.text()) || "Request failed: " + response.status);
}

async function cancel() {
  await post("/cancel", "{}", "application/json").catch(() => {});
  showMessage("Cancelled. You can close this tab.");
}

// ---------- Step 1: frame and crop ----------

const MIN_WIDTH = 0.08;
const stage = $("stage");
const box = $("box");
const slider = $("slider");

// Crop box height as a fraction of frame height, per unit of fractional width.
const ratio = (config.sourceWidth / config.sourceHeight) / (config.targetWidth / config.targetHeight);
const maxWidth = Math.min(1, 1 / ratio);

let frameIndex = Math.floor(config.frameTimes.length / 2);
// Crop box in fractions of the frame: x, y is the top-left corner, w is the width.
const crop = { w: Math.min(1 / 3, maxWidth), x: 0, y: 0 };
crop.x = (1 - crop.w) / 2;
crop.y = (1 - crop.w * ratio) / 2;

function clamp(value, min, max) { return Math.min(Math.max(value, min), max); }

function formatTime(sec) {
  const m = Math.floor(sec / 60);
  return m + ":" + (sec - m * 60).toFixed(1).padStart(4, "0");
}

function renderCrop() {
  const h = crop.w * ratio;
  box.style.left = crop.x * 100 + "%";
  box.style.top = crop.y * 100 + "%";
  box.style.width = crop.w * 100 + "%";
  box.style.height = h * 100 + "%";

  const pxW = Math.round(crop.w * config.sourceWidth);
  const pxH = Math.round(h * config.sourceHeight);
  const upscaled = pxW < config.targetWidth;
  $("info").textContent = "Zoom " + (1 / crop.w).toFixed(1) + "\\u00d7 \\u00b7 " + pxW + "\\u00d7" + pxH + " px"
    + (upscaled ? " \\u2014 below " + config.targetWidth + " px, will look soft" : "");
  $("info").className = upscaled ? "warn" : "";
}

function showFrame(index) {
  frameIndex = clamp(index, 0, config.frameTimes.length - 1);
  $("frame").src = "/frame/" + frameIndex + tokenQuery;
  slider.value = String(frameIndex);
  $("frameLabel").textContent = "Frame " + (frameIndex + 1) + "/" + config.frameTimes.length
    + " \\u00b7 " + formatTime(config.frameTimes[frameIndex]);
}

function pointerPosition(event) {
  const rect = stage.getBoundingClientRect();
  return { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height };
}

// Dragging either moves the box or resizes it from a corner with the opposite corner fixed.
let drag = null;

box.addEventListener("pointerdown", (event) => {
  const pos = pointerPosition(event);
  const handle = event.target.dataset.h;
  if (handle) {
    const h = crop.w * ratio;
    drag = {
      kind: "resize",
      dirX: handle.includes("e") ? 1 : -1,
      dirY: handle.includes("s") ? 1 : -1,
      anchorX: handle.includes("e") ? crop.x : crop.x + crop.w,
      anchorY: handle.includes("s") ? crop.y : crop.y + h,
    };
  } else {
    drag = { kind: "move", offsetX: pos.x - crop.x, offsetY: pos.y - crop.y };
  }
  box.setPointerCapture(event.pointerId);
  event.preventDefault();
});

box.addEventListener("pointermove", (event) => {
  if (!drag) return;
  const pos = pointerPosition(event);
  if (drag.kind === "move") {
    crop.x = clamp(pos.x - drag.offsetX, 0, 1 - crop.w);
    crop.y = clamp(pos.y - drag.offsetY, 0, 1 - crop.w * ratio);
  } else {
    const wanted = Math.max((pos.x - drag.anchorX) * drag.dirX, ((pos.y - drag.anchorY) * drag.dirY) / ratio);
    const roomX = drag.dirX > 0 ? 1 - drag.anchorX : drag.anchorX;
    const roomY = (drag.dirY > 0 ? 1 - drag.anchorY : drag.anchorY) / ratio;
    crop.w = clamp(wanted, MIN_WIDTH, Math.min(roomX, roomY));
    crop.x = drag.dirX > 0 ? drag.anchorX : drag.anchorX - crop.w;
    crop.y = drag.dirY > 0 ? drag.anchorY : drag.anchorY - crop.w * ratio;
  }
  renderCrop();
});

function endDrag() { drag = null; }
box.addEventListener("pointerup", endDrag);
box.addEventListener("pointercancel", endDrag);

// Wheel resizes the box around its center.
stage.addEventListener("wheel", (event) => {
  event.preventDefault();
  const centerX = crop.x + crop.w / 2;
  const centerY = crop.y + (crop.w * ratio) / 2;
  crop.w = clamp(crop.w * (event.deltaY > 0 ? 1.04 : 0.96), MIN_WIDTH, maxWidth);
  crop.x = clamp(centerX - crop.w / 2, 0, 1 - crop.w);
  crop.y = clamp(centerY - (crop.w * ratio) / 2, 0, 1 - crop.w * ratio);
  renderCrop();
}, { passive: false });

slider.addEventListener("input", () => showFrame(Number(slider.value)));

async function submitCrop() {
  $("next").disabled = true;
  $("info").className = "";
  $("info").textContent = "Rendering the frame at full resolution\\u2026";
  try {
    await post("/crop", JSON.stringify({
      frameIndex,
      crop: { x: crop.x, y: crop.y, width: crop.w, height: crop.w * ratio },
    }), "application/json");
    await openCompose();
  } catch (error) {
    $("info").className = "warn";
    $("info").textContent = error.message;
  } finally {
    $("next").disabled = false;
  }
}

// ---------- Step 2: channel graphics ----------

const W = config.targetWidth;
const H = config.targetHeight;
const ACCENT = config.colors.accent;
const NAVY = config.colors.background;
const SOFT_WHITE = "#FFFFFF";
const MARGIN = 40;
const PLATE_BOTTOM = H - MARGIN;

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not load " + src));
    image.src = src;
  });
}

function font(weight, size) { return weight + " " + size + "px \\"Inter Display\\""; }

function textWidth(ctx, text, tracking) {
  return ctx.measureText(text).width + (tracking || 0) * text.length;
}

/** Draws text from the left edge; letter spacing is applied manually for wide browser support. */
function drawText(ctx, text, x, y, tracking) {
  if (!tracking) { ctx.fillText(text, x, y); return; }
  for (const ch of text) {
    ctx.fillText(ch, x, y);
    x += ctx.measureText(ch).width + tracking;
  }
}

/** Blurred copy of the whole frame; glass plates show pieces of it. */
function makeBackdrop(base) {
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");
  if ("filter" in ctx) {
    ctx.filter = "blur(18px) saturate(1.25)";
    // Drawn slightly oversized so the blur has no transparent edges.
    ctx.drawImage(base, -36, -36, W + 72, H + 72);
  } else {
    // Fallback blur: scale far down, then back up with smoothing.
    const small = document.createElement("canvas");
    small.width = Math.round(W / 24); small.height = Math.round(H / 24);
    small.getContext("2d").drawImage(base, 0, 0, small.width, small.height);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(small, 0, 0, W, H);
  }
  return canvas;
}

/** Frosted glass plate: soft shadow, blurred backdrop, dark tint, top highlight and a light rim. */
function glass(ctx, backdrop, x, y, w, h, radius) {
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.38)";
  ctx.shadowBlur = 28;
  ctx.shadowOffsetY = 6;
  ctx.fillStyle = "rgba(0,0,0,0.5)";
  ctx.beginPath(); ctx.roundRect(x, y, w, h, radius); ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.beginPath(); ctx.roundRect(x, y, w, h, radius); ctx.clip();
  ctx.drawImage(backdrop, 0, 0);
  ctx.fillStyle = "rgba(12,22,40,0.32)";
  ctx.fillRect(x, y, w, h);
  const highlight = ctx.createLinearGradient(0, y, 0, y + h * 0.55);
  highlight.addColorStop(0, "rgba(255,255,255,0.18)");
  highlight.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = highlight;
  ctx.fillRect(x, y, w, h * 0.55);
  ctx.restore();

  ctx.strokeStyle = "rgba(255,255,255,0.47)";
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.roundRect(x + 1, y + 1, w - 2, h - 2, radius - 1); ctx.stroke();
}

/** Top-left badge with the channel logo and name; returns its right edge. */
function drawChannelBadge(ctx, backdrop, logo, overlay) {
  const height = 64;
  const tracking = 2;
  ctx.font = font(800, 24);
  // Without a channel text the badge shrinks to a circle around the logo.
  const width = overlay.channel ? 66 + textWidth(ctx, overlay.channel, tracking) + 24 : 70;
  glass(ctx, backdrop, MARGIN, 36, width, height, height / 2);
  ctx.drawImage(logo, MARGIN + 12, 36 + 9, 46, 46);
  ctx.fillStyle = SOFT_WHITE;
  ctx.font = font(800, 24);
  drawText(ctx, overlay.channel, MARGIN + 66, 36 + 41, tracking);
  return MARGIN + width;
}

/** Top-right plate with event, venue and date; shrinks or drops parts to stay clear of the badge. */
function drawInfoPlate(ctx, backdrop, parts, leftLimit) {
  const height = 64;
  const tracking = 1;
  const available = W - MARGIN - leftLimit - 24;
  let items = parts.filter(Boolean);
  let size = 26;
  let text = "";
  let width = 0;
  for (;;) {
    text = items.join("  \\u00b7  ").toUpperCase();
    ctx.font = font(700, size);
    width = textWidth(ctx, text, tracking) + 56;
    if (width <= available || items.length <= 1) break;
    if (size > 20) size -= 2;
    else { items = items.slice(0, -2).concat(items.slice(-1)); size = 26; }
  }
  if (!text) return;
  const x = W - MARGIN - width;
  glass(ctx, backdrop, x, 36, width, height, height / 2);
  ctx.fillStyle = SOFT_WHITE;
  ctx.font = font(700, size);
  drawText(ctx, text, x + 28, 36 + 32 + size * 0.35, tracking);
}

function drawVsCircle(ctx, cx, cy, radius) {
  ctx.fillStyle = ACCENT;
  ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = SOFT_WHITE;
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.fillStyle = NAVY;
  ctx.font = font(900, Math.round(radius * 0.85));
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("VS", cx, cy + 1);
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
}

/** Bottom plates with both sides and a VS mark; falls back to two rows for long names. */
function drawTeams(ctx, backdrop, left, right) {
  const maxTotal = W - MARGIN * 2;
  for (let size = 50; size >= 36; size -= 2) {
    ctx.font = font(800, size);
    const lw = textWidth(ctx, left);
    const rw = textWidth(ctx, right);
    const pad = Math.round(size * 0.72);
    const gap = Math.round(size * 1.92);
    const total = lw + rw + pad * 4 + gap;
    if (total > maxTotal) continue;

    const height = Math.round(size * 2.04);
    const y = PLATE_BOTTOM - height;
    const x = (W - total) / 2;
    const rightX = x + lw + pad * 2 + gap;
    glass(ctx, backdrop, x, y, lw + pad * 2, height, height / 2);
    glass(ctx, backdrop, rightX, y, rw + pad * 2, height, height / 2);
    ctx.fillStyle = SOFT_WHITE;
    ctx.font = font(800, size);
    const baseline = y + height / 2 + size * 0.36;
    ctx.fillText(left, x + pad, baseline);
    ctx.fillText(right, rightX + pad, baseline);
    drawVsCircle(ctx, x + lw + pad * 2 + gap / 2, y + height / 2, size * 0.8);
    return;
  }

  // Two rows: each side gets its own centered plate, VS sits between them.
  let size = 44;
  ctx.font = font(800, size);
  while (size > 28 && Math.max(textWidth(ctx, left), textWidth(ctx, right)) + 88 > maxTotal) {
    size -= 2;
    ctx.font = font(800, size);
  }
  const height = Math.round(size * 2.04);
  const rowGap = 12;
  const rows = [
    { text: left, y: PLATE_BOTTOM - height * 2 - rowGap },
    { text: right, y: PLATE_BOTTOM - height },
  ];
  for (const row of rows) {
    ctx.font = font(800, size);
    const width = textWidth(ctx, row.text) + 88;
    glass(ctx, backdrop, (W - width) / 2, row.y, width, height, height / 2);
    ctx.fillStyle = SOFT_WHITE;
    ctx.font = font(800, size);
    ctx.fillText(row.text, (W - width) / 2 + 44, row.y + height / 2 + size * 0.36);
  }
  drawVsCircle(ctx, MARGIN + 34, PLATE_BOTTOM - height - rowGap / 2, 30);
}

/** Single bottom plate used when teams are not specified: event name plus an optional part label. */
function drawHeadline(ctx, backdrop, headline, part) {
  const size = 50;
  const pad = 44;
  const gap = part ? 26 : 0;
  ctx.font = font(800, size);
  const hw = textWidth(ctx, headline);
  ctx.font = font(900, size);
  const pw = part ? textWidth(ctx, part) : 0;
  const total = hw + gap + pw + pad * 2;
  const height = Math.round(size * 2.04);
  const x = (W - total) / 2;
  const y = PLATE_BOTTOM - height;
  glass(ctx, backdrop, x, y, total, height, height / 2);
  const baseline = y + height / 2 + size * 0.36;
  ctx.fillStyle = SOFT_WHITE;
  ctx.font = font(800, size);
  ctx.fillText(headline, x + pad, baseline);
  if (part) {
    ctx.fillStyle = ACCENT;
    ctx.font = font(900, size);
    ctx.fillText(part, x + pad + hw + gap, baseline);
  }
}

function compose(canvas, base, logo, overlay) {
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(base, 0, 0, W, H);
  const backdrop = makeBackdrop(base);
  const hasTeams = Boolean(overlay.left && overlay.right);

  const badgeRight = drawChannelBadge(ctx, backdrop, logo, overlay);
  // With teams the event moves to the top plate; without them it is the bottom headline.
  const infoParts = hasTeams
    ? [overlay.eventName, overlay.part, overlay.venue, overlay.date]
    : [overlay.venue, overlay.date];
  drawInfoPlate(ctx, backdrop, infoParts, badgeRight);

  if (hasTeams) drawTeams(ctx, backdrop, overlay.left, overlay.right);
  else drawHeadline(ctx, backdrop, overlay.eventName, overlay.part);
}

async function openCompose() {
  await Promise.all([700, 800, 900].map((weight) => document.fonts.load(font(weight, 40))));
  const [base, logo] = await Promise.all([
    loadImage("/base.jpg" + tokenQuery + "&t=" + Date.now()),
    loadImage("/logo.png" + tokenQuery),
  ]);
  compose($("result"), base, logo, config.overlay);

  const feed = $("feed");
  feed.width = 320; feed.height = 180;
  const feedCtx = feed.getContext("2d");
  feedCtx.imageSmoothingQuality = "high";
  feedCtx.drawImage($("result"), 0, 0, 320, 180);
  showStep("compose");
}

async function saveThumbnail() {
  $("save").disabled = true;
  try {
    const blob = await new Promise((resolve) => $("result").toBlob(resolve, "image/jpeg", 0.92));
    await post("/final", blob, "image/jpeg");
    showMessage("Saved. You can close this tab and return to the terminal.");
  } catch (error) {
    $("save").disabled = false;
    $("info").className = "warn";
    $("info").textContent = error.message;
  }
}

// ---------- Wiring ----------

$("next").addEventListener("click", submitCrop);
$("save").addEventListener("click", saveThumbnail);
$("back").addEventListener("click", () => showStep("crop"));
$("cancelCrop").addEventListener("click", cancel);
$("cancelCompose").addEventListener("click", cancel);

document.addEventListener("keydown", (event) => {
  if (step === "message") return;
  if (event.key === "Escape") cancel();
  else if (event.key === "Enter") { if (step === "crop") submitCrop(); else saveThumbnail(); }
  else if (step === "crop" && event.key === "ArrowLeft") showFrame(frameIndex - 1);
  else if (step === "crop" && event.key === "ArrowRight") showFrame(frameIndex + 1);
  else return;
  event.preventDefault();
});

$("title").textContent = config.title;
const canCrop = config.frameTimes.length > 0;
$("back").classList.toggle("hidden", !canCrop);
if (canCrop) {
  slider.max = String(config.frameTimes.length - 1);
  showFrame(frameIndex);
}
if (config.startAtCompose || !canCrop) {
  openCompose().catch((error) => showMessage(error.message));
} else {
  showStep("crop");
}
</script>
</body>
</html>`;
}
