import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { promisify } from "node:util";
import { TIME_ZONE } from "./config.js";

const execFileAsync = promisify(execFile);

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".m4v", ".mkv"]);
/** Transfer characteristics that mark HDR footage (HLG and PQ). */
const HDR_TRANSFERS = new Set(["arib-std-b67", "smpte2084"]);

export type Camera = "DJI Action" | "Samsung Galaxy" | "unknown";

export interface MediaFile {
  path: string;
  fileName: string;
  sizeBytes: number;
  /** Moment the recording started, ISO 8601 in UTC. */
  recordedAt: string;
  /** Recording date in the shooting time zone, YYYY-MM-DD. */
  localDate: string;
  /** Recording start time in the shooting time zone, HH:MM. */
  localTime: string;
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  isHdr: boolean;
  camera: Camera;
}

interface ProbeOutput {
  streams?: {
    codec_type?: string;
    width?: number;
    height?: number;
    r_frame_rate?: string;
    color_transfer?: string;
  }[];
  format?: { duration?: string; tags?: Record<string, string> };
}

function parseFrameRate(rate: string | undefined): number {
  const [num, den] = (rate ?? "0/1").split("/").map(Number);
  return num && den ? num / den : 0;
}

/** Guesses the camera from the file naming scheme each device uses. */
function detectCamera(fileName: string, tags: Record<string, string>): Camera {
  if (/^DJI_/i.test(fileName)) return "DJI Action";
  // Samsung names files like 20261114_153247.mp4 and writes Android-specific tags.
  if (/^\d{8}_\d{6}/.test(fileName) || Object.keys(tags).some((k) => k.startsWith("com.android"))) {
    return "Samsung Galaxy";
  }
  return "unknown";
}

function toLocalParts(date: Date): { localDate: string; localTime: string } {
  // The sv-SE locale formats dates as "YYYY-MM-DD HH:MM".
  const [localDate = "", localTime = ""] = date
    .toLocaleString("sv-SE", { timeZone: TIME_ZONE, dateStyle: "short", timeStyle: "short" })
    .split(" ");
  return { localDate, localTime };
}

/** Reads technical metadata of a video file with ffprobe (reads headers only, fast on huge files). */
export async function probeFile(path: string): Promise<MediaFile> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error",
    "-show_entries",
    "format=duration:format_tags:stream=codec_type,width,height,r_frame_rate,color_transfer",
    "-of", "json",
    path,
  ]);
  const probe = JSON.parse(stdout) as ProbeOutput;
  const video = probe.streams?.find((s) => s.codec_type === "video");
  if (!video) {
    throw new Error(`No video stream in ${path}`);
  }

  const tags = probe.format?.tags ?? {};
  const fileStat = await stat(path);
  // Fall back to the file modification time when the container has no creation_time.
  const recorded = tags.creation_time ? new Date(tags.creation_time) : fileStat.mtime;
  const fileName = path.split("/").pop() ?? path;

  return {
    path,
    fileName,
    sizeBytes: fileStat.size,
    recordedAt: recorded.toISOString(),
    ...toLocalParts(recorded),
    durationSec: Number(probe.format?.duration ?? 0),
    width: video.width ?? 0,
    height: video.height ?? 0,
    fps: parseFrameRate(video.r_frame_rate),
    isHdr: HDR_TRANSFERS.has(video.color_transfer ?? ""),
    camera: detectCamera(fileName, tags),
  };
}

export interface SourceFile {
  path: string;
  fileName: string;
  sizeBytes: number;
}

/** Lists video files in a directory (non-recursive) without probing them; empty when the folder is missing. */
export async function listVideoFiles(dir: string): Promise<SourceFile[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const videos = names.filter((n) => !n.startsWith(".") && VIDEO_EXTENSIONS.has(extname(n).toLowerCase())).sort();
  return Promise.all(
    videos.map(async (fileName) => {
      const path = join(dir, fileName);
      return { path, fileName, sizeBytes: (await stat(path)).size };
    }),
  );
}

/** Probes every video file in a directory (non-recursive), ordered by recording time. */
export async function scanDirectory(dir: string): Promise<MediaFile[]> {
  const names = (await readdir(dir)).filter(
    (n) => !n.startsWith(".") && VIDEO_EXTENSIONS.has(extname(n).toLowerCase()),
  );
  const files = await Promise.all(names.map((n) => probeFile(join(dir, n))));
  return files.sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
}

/** Formats seconds as M:SS or H:MM:SS. */
export function formatDuration(totalSec: number): string {
  const sec = Math.round(totalSec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(sec % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}
