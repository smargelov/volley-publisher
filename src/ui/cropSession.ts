import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { getAssetsDir } from "../core/assets.js";
import { ACCENT_COLOR, BACKGROUND_COLOR, resolveLogoPath } from "../core/config.js";
import type { MediaFile } from "../core/media.js";
import type { ThumbnailOverlay } from "../core/text.js";
import {
  THUMB_HEIGHT,
  THUMB_WIDTH,
  baseFramePath,
  renderBaseFrame,
  saveCropChoice,
  thumbnailPath,
  type CropRect,
  type PreviewFrame,
} from "../core/thumbnail.js";
import { renderCropPage } from "./cropPage.js";

const execFileAsync = promisify(execFile);

const SESSION_TIMEOUT_MS = 30 * 60_000;
const MAX_JSON_BYTES = 10_000;
/** YouTube rejects thumbnails above 2 MB. */
const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024;

/** Static files the page may request, mapped to their location in the assets directory. */
/** Bundled logo used until the user sets their own in the settings. */
const DEFAULT_LOGO_FILE = "logo-mark.png";

const ASSETS: Record<string, { file: string; type: string }> = {
  "/fonts/InterDisplay-Bold.otf": { file: "fonts/InterDisplay-Bold.otf", type: "font/otf" },
  "/fonts/InterDisplay-ExtraBold.otf": { file: "fonts/InterDisplay-ExtraBold.otf", type: "font/otf" },
  "/fonts/InterDisplay-Black.otf": { file: "fonts/InterDisplay-Black.otf", type: "font/otf" },
};

/** Browsers whose tabs can be closed through AppleScript, by process name. */
const SCRIPTABLE_BROWSERS = [
  "Google Chrome",
  "Arc",
  "Brave Browser",
  "Microsoft Edge",
  "Vivaldi",
  "Chromium",
  "Safari",
];
const CLOSE_TAB_TIMEOUT_MS = 10_000;
/** Lets the page show its final message before the tab disappears. */
const CLOSE_TAB_DELAY_MS = 600;

/**
 * Closes the editor tab once the session is over (macOS only).
 * A page cannot close a tab it did not open itself, so the browser is asked to do it.
 * The first time, macOS asks for permission to control the browser.
 */
async function closeEditorTabs(address: string): Promise<void> {
  if (process.platform !== "darwin") return;
  await new Promise((done) => setTimeout(done, CLOSE_TAB_DELAY_MS));

  for (const browser of SCRIPTABLE_BROWSERS) {
    const running = await execFileAsync("pgrep", ["-x", browser]).then(
      () => true,
      () => false,
    );
    if (!running) continue;

    const script = [
      `tell application "${browser}"`,
      "  repeat with w in windows",
      `    close (tabs of w whose URL starts with "${address}")`,
      "  end repeat",
      "end tell",
    ].join("\n");
    // Best effort: when the browser refuses, the tab simply stays open.
    await execFileAsync("osascript", ["-e", script], { timeout: CLOSE_TAB_TIMEOUT_MS }).catch(() => {});
  }
}

export interface ThumbnailSessionOptions {
  file: MediaFile;
  /** Preview frames to choose from; empty to skip cropping and reuse the existing base frame. */
  frames: PreviewFrame[];
  overlay: ThumbnailOverlay;
}

function isFraction(value: unknown): value is number {
  return typeof value === "number" && value >= 0 && value <= 1;
}

/** Validates the crop sent by the browser; returns null when it is malformed. */
function parseCrop(raw: string, frames: PreviewFrame[]): { frame: PreviewFrame; crop: CropRect } | null {
  try {
    const data = JSON.parse(raw) as { frameIndex?: unknown; crop?: Partial<Record<keyof CropRect, unknown>> };
    const frame = typeof data.frameIndex === "number" ? frames[data.frameIndex] : undefined;
    const crop = data.crop;
    if (!frame || !crop) return null;
    const { x, y, width, height } = crop;
    if (!isFraction(x) || !isFraction(y) || !isFraction(width) || !isFraction(height)) return null;
    if (width === 0 || height === 0) return null;
    return { frame, crop: { x, y, width, height } };
  } catch {
    return null;
  }
}

/** Reads a request body, rejecting it once it grows past the limit. */
function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("Request body is too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * Opens the thumbnail editor in the browser and waits until the user saves or cancels.
 * Serves a one-off page on a random loopback port.
 * Resolves to the path of the finished thumbnail, or null when cancelled.
 */
export function runThumbnailSession(options: ThumbnailSessionOptions): Promise<string | null> {
  const { file, frames, overlay } = options;
  const token = randomBytes(16).toString("hex");
  const page = renderCropPage({
    token,
    frameTimes: frames.map((f) => f.timeSec),
    sourceWidth: file.width,
    sourceHeight: file.height,
    targetWidth: THUMB_WIDTH,
    targetHeight: THUMB_HEIGHT,
    title: file.fileName,
    overlay,
    colors: { accent: ACCENT_COLOR, background: BACKGROUND_COLOR },
    startAtCompose: frames.length === 0,
  });

  return new Promise((resolve, reject) => {
    let address = "";
    let finished = false;
    const finish = (result: string | null, closeTab = true) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      void (closeTab ? closeEditorTabs(address) : Promise.resolve()).finally(() => {
        server.close();
        server.closeAllConnections();
        resolve(result);
      });
    };

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const route = `${req.method} ${url.pathname}`;
      const sendFile = (path: string, type: string) =>
        readFile(path).then(
          (data) => res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" }).end(data),
          () => res.writeHead(404).end(),
        );
      const fail = (status: number, err: unknown) =>
        res.writeHead(status, { "Content-Type": "text/plain" }).end((err as Error).message);

      if (route === "GET /") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(page);
        return;
      }
      // Everything except the page itself requires the per-session token.
      if (url.searchParams.get("token") !== token) {
        res.writeHead(403).end();
        return;
      }

      if (route === "GET /logo.png") {
        void sendFile(resolveLogoPath() ?? join(getAssetsDir(), DEFAULT_LOGO_FILE), "image/png");
        return;
      }

      const asset = req.method === "GET" ? ASSETS[url.pathname] : undefined;
      if (asset) {
        void sendFile(join(getAssetsDir(), asset.file), asset.type);
        return;
      }

      const frameMatch = /^\/frame\/(\d+)$/.exec(url.pathname);
      if (req.method === "GET" && frameMatch) {
        const frame = frames[Number(frameMatch[1])];
        if (frame) void sendFile(frame.path, "image/jpeg");
        else res.writeHead(404).end();
        return;
      }

      switch (route) {
        case "GET /base.jpg":
          void sendFile(baseFramePath(file.path), "image/jpeg");
          return;

        case "POST /cancel":
          res.writeHead(204).end();
          finish(null);
          return;

        // Step 1 result: render the chosen frame and area at full resolution.
        case "POST /crop":
          readBody(req, MAX_JSON_BYTES)
            .then(async (body) => {
              const choice = parseCrop(body.toString(), frames);
              if (!choice) {
                res.writeHead(400, { "Content-Type": "text/plain" }).end("Invalid crop data.");
                return;
              }
              await renderBaseFrame(file, choice.frame.timeSec, choice.crop);
              await saveCropChoice(file.path, { timeSec: choice.frame.timeSec, crop: choice.crop });
              res.writeHead(204).end();
            })
            .catch((err) => fail(500, err));
          return;

        // Step 2 result: the finished thumbnail drawn by the browser.
        case "POST /final":
          readBody(req, MAX_THUMBNAIL_BYTES)
            .then(async (body) => {
              // JPEG files start with the bytes FF D8.
              if (body.length < 4 || body[0] !== 0xff || body[1] !== 0xd8) {
                res.writeHead(400, { "Content-Type": "text/plain" }).end("Expected a JPEG image.");
                return;
              }
              const target = thumbnailPath(file.path);
              await writeFile(target, body);
              res.writeHead(204).end();
              finish(target);
            })
            .catch((err) => fail(500, err));
          return;

        default:
          res.writeHead(404).end();
      }
    });

    // On timeout the tab is left alone: the user may still be looking at it.
    const timer = setTimeout(() => finish(null, false), SESSION_TIMEOUT_MS);
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      address = `http://127.0.0.1:${port}/`;
      console.log(`Thumbnail editor: ${address}`);
      if (process.platform === "darwin") {
        execFile("open", [address], () => {});
      }
    });
  });
}
