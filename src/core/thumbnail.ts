import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { promisify } from "node:util";
import { MEDIA_DIR } from "./config.js";
import type { MediaFile } from "./media.js";

const execFileAsync = promisify(execFile);

/** YouTube's recommended thumbnail size. */
export const THUMB_WIDTH = 1280;
export const THUMB_HEIGHT = 720;
/** Candidate frames are taken from a window around the requested moment. */
const WINDOW_SEC = 2;
const FRAMES_PER_SEC = 10;
/** Previews are downscaled: they are only used to pick a frame and a crop area. */
const PREVIEW_WIDTH = 1920;
const PREVIEW_PREFIX = "preview_";

/** Area of the source frame, as fractions (0..1) of its width and height. */
export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PreviewFrame {
  path: string;
  /** Position of the frame in the video, seconds. */
  timeSec: number;
}

/** Working directory for preview frames and the final thumbnail of one video. */
export function thumbDir(videoPath: string): string {
  return join(MEDIA_DIR, "thumbs", basename(videoPath, extname(videoPath)));
}

/** Parses "83", "1:23" or "1:02:03" into seconds; returns null for invalid input. */
export function parseTimecode(input: string): number | null {
  const parts = input.trim().split(":").map(Number);
  if (parts.length === 0 || parts.length > 3 || parts.some((p) => !Number.isFinite(p) || p < 0)) {
    return null;
  }
  return parts.reduce((total, part) => total * 60 + part, 0);
}

/** Extracts full, uncropped preview frames around the given moment, in chronological order. */
export async function extractPreviewFrames(file: MediaFile, atSec: number): Promise<PreviewFrame[]> {
  const dir = thumbDir(file.path);
  await mkdir(dir, { recursive: true });
  // Remove previews of a previous attempt so stale frames never mix with new ones.
  for (const name of await readdir(dir)) {
    if (name.startsWith(PREVIEW_PREFIX)) await unlink(join(dir, name));
  }

  const start = Math.max(0, atSec - WINDOW_SEC / 2);
  await execFileAsync("ffmpeg", [
    "-v", "error", "-y",
    "-ss", start.toFixed(3),
    "-i", file.path,
    "-t", String(WINDOW_SEC),
    "-vf", `fps=${FRAMES_PER_SEC},scale=${PREVIEW_WIDTH}:-2`,
    "-q:v", "3",
    join(dir, `${PREVIEW_PREFIX}%02d.jpg`),
  ]);

  return (await readdir(dir))
    .filter((n) => n.startsWith(PREVIEW_PREFIX))
    .sort()
    .map((name, index) => ({ path: join(dir, name), timeSec: start + index / FRAMES_PER_SEC }));
}

/** Path of the cropped frame without graphics; the overlay is drawn on top of it. */
export function baseFramePath(videoPath: string): string {
  return join(thumbDir(videoPath), "base.jpg");
}

/** Path of the finished thumbnail. */
export function thumbnailPath(videoPath: string): string {
  return join(thumbDir(videoPath), "thumbnail.jpg");
}

/**
 * Renders the base frame from the source video at full resolution:
 * takes the frame at the given moment, crops it and scales to thumbnail size.
 */
export async function renderBaseFrame(file: MediaFile, timeSec: number, crop: CropRect): Promise<string> {
  const clamp = (value: number, max: number) => Math.round(Math.min(Math.max(value, 0), max));
  const width = clamp(crop.width * file.width, file.width);
  const height = clamp(crop.height * file.height, file.height);
  const x = clamp(crop.x * file.width, file.width - width);
  const y = clamp(crop.y * file.height, file.height - height);

  const target = baseFramePath(file.path);
  await mkdir(thumbDir(file.path), { recursive: true });
  await execFileAsync("ffmpeg", [
    "-v", "error", "-y",
    "-ss", timeSec.toFixed(3),
    "-i", file.path,
    "-frames:v", "1",
    "-vf", `crop=${width}:${height}:${x}:${y},scale=${THUMB_WIDTH}:${THUMB_HEIGHT}:flags=lanczos`,
    "-q:v", "2",
    target,
  ]);
  return target;
}

/** The moment and area picked for a video, kept so the thumbnail can be rebuilt later. */
export interface CropChoice {
  timeSec: number;
  crop: CropRect;
}

function cropChoicePath(videoPath: string): string {
  return join(thumbDir(videoPath), "crop.json");
}

export async function saveCropChoice(videoPath: string, choice: CropChoice): Promise<void> {
  await mkdir(thumbDir(videoPath), { recursive: true });
  await writeFile(cropChoicePath(videoPath), JSON.stringify(choice, null, 2));
}

export async function loadCropChoice(videoPath: string): Promise<CropChoice | null> {
  try {
    return JSON.parse(await readFile(cropChoicePath(videoPath), "utf8")) as CropChoice;
  } catch {
    return null;
  }
}
