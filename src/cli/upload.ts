import { basename, extname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { INBOX_DIR } from "../core/config.js";
import { formatDuration, probeFile, scanDirectory, type MediaFile } from "../core/media.js";
import { loadStore, saveStore } from "../core/store.js";
import { uploadVideo } from "../core/upload.js";
import type { PrivacyStatus } from "../core/youtube.js";
import { choose, confirm } from "./prompts.js";

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const PRIVACY_VALUES: PrivacyStatus[] = ["private", "unlisted", "public"];
/** YouTube plays at most 60 fps; higher frame rates are converted on their side. */
const MAX_PLAYBACK_FPS = 60;

/** Picks the file to upload: an explicit path or name, or one of the inbox files not uploaded yet. */
async function pickFile(fileArg: string | undefined, uploaded: Set<string>): Promise<MediaFile> {
  if (fileArg) {
    // A bare file name is looked up in the inbox folder.
    return probeFile(fileArg.includes("/") ? resolve(fileArg) : join(INBOX_DIR, fileArg));
  }

  const pending = (await scanDirectory(INBOX_DIR)).filter((f) => !uploaded.has(f.fileName));
  if (pending.length === 0) {
    throw new Error(`No files waiting for upload in ${INBOX_DIR}`);
  }
  if (pending.length === 1 && pending[0]) return pending[0];

  const picked = await choose(
    "Files waiting for upload:",
    pending.map((f) => ({
      label: `${f.fileName}  ${f.localDate} ${f.localTime}  ${formatDuration(f.durationSec)}`,
      value: f,
    })),
  );
  if (!picked) throw new Error("Nothing selected.");
  return picked;
}

/** Draws a single-line progress indicator with speed and remaining time. */
function createProgressPrinter(): (sentBytes: number, totalBytes: number) => void {
  const startedAt = Date.now();
  let firstSent: number | undefined;

  return (sentBytes, totalBytes) => {
    // Bytes stored by an earlier run do not count towards the speed of this one.
    firstSent ??= sentBytes;
    const elapsedSec = (Date.now() - startedAt) / 1000;
    const speed = elapsedSec > 0 ? (sentBytes - firstSent) / elapsedSec : 0;
    const eta = speed > 0 ? formatDuration((totalBytes - sentBytes) / speed) : "--:--";
    const line =
      `  ${((sentBytes / totalBytes) * 100).toFixed(1).padStart(5)}%  ` +
      `${(sentBytes / GIB).toFixed(2)} / ${(totalBytes / GIB).toFixed(2)} GB  ` +
      `${(speed / MIB).toFixed(1)} MB/s  ETA ${eta}`;
    if (process.stdout.isTTY) process.stdout.write(`\r${line.padEnd(70)}`);
    else console.log(line);
  };
}

/** Takes the visibility from --privacy, or asks for it; private is the default. */
async function pickPrivacy(flag: string | undefined, interactive: boolean): Promise<PrivacyStatus> {
  if (flag !== undefined) {
    if (!PRIVACY_VALUES.includes(flag as PrivacyStatus)) {
      throw new Error(`--privacy must be one of: ${PRIVACY_VALUES.join(", ")}`);
    }
    return flag as PrivacyStatus;
  }
  if (!interactive) return "private";
  const picked = await choose<PrivacyStatus>("Visibility of the uploaded video:", [
    { label: "Private — only you can see it", value: "private" },
    { label: "Unlisted — anyone with the link", value: "unlisted" },
    { label: "Public — visible to everyone, subscribers are notified", value: "public" },
  ]);
  return picked ?? "private";
}

/**
 * Uploads a source file to the channel with the visibility the user picks.
 * Details, thumbnail and playlist are filled in afterwards by "apply".
 */
export async function cmdUpload(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      yes: { type: "boolean", short: "y", default: false },
      privacy: { type: "string" },
    },
  });

  const store = await loadStore();
  const file = await pickFile(positionals[0], new Set(Object.values(store.uploads)));

  console.log(
    `\nFile: ${file.fileName} — recorded ${file.localDate} ${file.localTime}, ` +
      `${formatDuration(file.durationSec)}, ${file.width}x${file.height} ${Math.round(file.fps)}fps, ` +
      `${(file.sizeBytes / GIB).toFixed(2)} GB`,
  );
  if (Math.round(file.fps) > MAX_PLAYBACK_FPS) {
    console.log(`Note: the file is ${Math.round(file.fps)} fps; YouTube will play it at ${MAX_PLAYBACK_FPS} fps at most.`);
  }
  const privacy = await pickPrivacy(values.privacy, !values.yes);
  console.log(`Visibility: ${privacy}. The title is the file name until you run "apply".`);
  if (!values.yes && !(await confirm("Upload this file?"))) {
    console.log("Cancelled, nothing was uploaded.");
    return;
  }

  const { videoId, resumed } = await uploadVideo(
    file.path,
    {
      // Same placeholder title YouTube Studio gives a fresh upload; "apply" replaces it.
      title: basename(file.fileName, extname(file.fileName)),
      description: "",
      tags: [],
      recordingDate: file.recordedAt,
      privacyStatus: privacy,
    },
    { onProgress: createProgressPrinter() },
  );
  if (process.stdout.isTTY) process.stdout.write("\n");

  // "apply" and "tidy" find the source file of the video through this record.
  store.uploads[videoId] = file.fileName;
  await saveStore(store);

  console.log(`${resumed ? "Upload resumed and finished" : "Uploaded"}: https://youtu.be/${videoId}`);
  console.log(`Next: npm run volley -- apply ${videoId}`);
}
