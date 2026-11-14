import { mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { getAccessToken } from "./auth.js";
import { CONFIG_DIR } from "./config.js";
import { CATEGORY_SPORTS, type PrivacyStatus } from "./youtube.js";

const INIT_URL = "https://www.googleapis.com/upload/youtube/v3/videos";
/** Resumable upload chunks must be multiples of 256 KiB (except the last one). */
const CHUNK_GRANULARITY = 256 * 1024;
const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024;
/** Consecutive failures without any progress before giving up. */
const MAX_FAILURES = 8;
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10 * 60_000;
/** Unfinished upload sessions, so an interrupted upload continues where it stopped. */
const SESSIONS_PATH = join(CONFIG_DIR, "upload-sessions.json");

const CONTENT_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/x-m4v",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
};

export interface UploadMetadata {
  title: string;
  description: string;
  tags: string[];
  /** ISO 8601 moment the video was recorded. */
  recordingDate: string;
  privacyStatus: PrivacyStatus;
}

export interface UploadOptions {
  onProgress?: (sentBytes: number, totalBytes: number) => void;
  /** Must be a multiple of 256 KiB. */
  chunkSize?: number;
  /** Overrides the session initiation endpoint; used by tests. */
  initUrl?: string;
  /** Overrides the base retry delay; used by tests. */
  baseDelayMs?: number;
}

export interface UploadResult {
  videoId: string;
  /** True when the upload continued a session started by an earlier run. */
  resumed: boolean;
}

interface SavedSession {
  sessionUri: string;
  sizeBytes: number;
  mtimeMs: number;
}

type SessionState =
  | { kind: "done"; videoId: string }
  | { kind: "incomplete"; offset: number }
  | { kind: "expired" };

/** A failure worth retrying: network trouble, a timeout, HTTP 429 or 5xx. */
class TransientError extends Error {}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

async function loadSessions(): Promise<Record<string, SavedSession>> {
  try {
    return JSON.parse(await readFile(SESSIONS_PATH, "utf8")) as Record<string, SavedSession>;
  } catch {
    return {};
  }
}

async function saveSession(path: string, session: SavedSession | null): Promise<void> {
  const sessions = await loadSessions();
  if (session) sessions[path] = session;
  else delete sessions[path];
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await writeFile(SESSIONS_PATH, JSON.stringify(sessions, null, 2), { mode: 0o600 });
}

async function describeError(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as {
    error?: { message?: string; errors?: { reason?: string }[] };
  };
  const reason = body.error?.errors?.[0]?.reason;
  return `YouTube upload ${res.status}${reason ? ` (${reason})` : ""}: ${body.error?.message ?? res.statusText}`;
}

/** fetch that reports network failures and timeouts as retryable. */
async function request(url: string, init: RequestInit): Promise<Response> {
  try {
    // 308 means "Resume Incomplete" here, not a redirect to follow.
    return await fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (err) {
    throw new TransientError(`Network error: ${(err as Error).message}`);
  }
}

/** Opens a resumable upload session and returns its URI. */
async function startSession(
  initUrl: string,
  meta: UploadMetadata,
  sizeBytes: number,
  contentType: string,
): Promise<string> {
  const url = new URL(initUrl);
  url.search = new URLSearchParams({
    uploadType: "resumable",
    part: "snippet,status,recordingDetails",
  }).toString();

  const res = await request(url.toString(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${await getAccessToken()}`,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Length": String(sizeBytes),
      "X-Upload-Content-Type": contentType,
    },
    body: JSON.stringify({
      snippet: {
        title: meta.title,
        description: meta.description,
        tags: meta.tags,
        categoryId: CATEGORY_SPORTS,
        defaultLanguage: "en",
      },
      status: { privacyStatus: meta.privacyStatus, selfDeclaredMadeForKids: false },
      recordingDetails: { recordingDate: meta.recordingDate },
    }),
  });
  if (!res.ok) throw new Error(await describeError(res));

  const sessionUri = res.headers.get("location");
  if (!sessionUri) throw new Error("YouTube did not return an upload session URI.");
  return sessionUri;
}

/** Interprets a response to a chunk upload or a status query. */
async function readState(res: Response): Promise<SessionState> {
  if (res.status === 200 || res.status === 201) {
    const body = (await res.json()) as { id?: string };
    if (!body.id) throw new Error("Upload finished but YouTube returned no video id.");
    return { kind: "done", videoId: body.id };
  }
  if (res.status === 308) {
    await res.arrayBuffer().catch(() => undefined);
    // "Range: bytes=0-N" tells how much is stored; no header means nothing yet.
    const lastByte = res.headers.get("range")?.match(/^bytes=0-(\d+)$/)?.[1];
    return { kind: "incomplete", offset: lastByte ? Number(lastByte) + 1 : 0 };
  }
  if (res.status === 404 || res.status === 410) {
    await res.arrayBuffer().catch(() => undefined);
    return { kind: "expired" };
  }
  if (res.status === 429 || res.status >= 500) {
    await res.arrayBuffer().catch(() => undefined);
    throw new TransientError(`YouTube upload ${res.status}: ${res.statusText}`);
  }
  throw new Error(await describeError(res));
}

async function putChunk(
  sessionUri: string,
  chunk: Uint8Array<ArrayBuffer>,
  offset: number,
  totalBytes: number,
): Promise<SessionState> {
  const res = await request(sessionUri, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${await getAccessToken()}`,
      "Content-Length": String(chunk.length),
      "Content-Range": `bytes ${offset}-${offset + chunk.length - 1}/${totalBytes}`,
    },
    body: chunk,
  });
  return readState(res);
}

/** Asks the server how many bytes of the session it has stored. */
async function queryState(sessionUri: string, totalBytes: number): Promise<SessionState> {
  const res = await request(sessionUri, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${await getAccessToken()}`,
      "Content-Length": "0",
      "Content-Range": `bytes */${totalBytes}`,
    },
  });
  return readState(res);
}

/**
 * Uploads a video file with the resumable protocol of videos.insert.
 * The file is sent in chunks; failed chunks are retried with exponential backoff, and an
 * interrupted run continues from the last stored byte when the command is started again.
 */
export async function uploadVideo(
  path: string,
  meta: UploadMetadata,
  options: UploadOptions = {},
): Promise<UploadResult> {
  const absPath = resolve(path);
  const { size: totalBytes, mtimeMs } = await stat(absPath);
  if (totalBytes === 0) throw new Error(`${absPath} is empty.`);

  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  if (chunkSize <= 0 || chunkSize % CHUNK_GRANULARITY !== 0) {
    throw new Error("chunkSize must be a positive multiple of 256 KiB.");
  }
  const initUrl = options.initUrl ?? INIT_URL;
  const baseDelayMs = options.baseDelayMs ?? BASE_DELAY_MS;
  const contentType = CONTENT_TYPES[extname(absPath).toLowerCase()] ?? "video/*";

  const openSession = async (): Promise<string> => {
    const uri = await startSession(initUrl, meta, totalBytes, contentType);
    await saveSession(absPath, { sessionUri: uri, sizeBytes: totalBytes, mtimeMs });
    return uri;
  };

  // A session saved by an earlier run is reused only while the file is unchanged.
  const saved = (await loadSessions())[absPath];
  const reusable = saved && saved.sizeBytes === totalBytes && saved.mtimeMs === mtimeMs ? saved : undefined;

  let sessionUri = reusable?.sessionUri ?? (await openSession());
  let canRestart = Boolean(reusable);
  let resumed = false;
  let offset = 0;
  // After a reused session or a failure the server is asked where to continue from.
  let offsetKnown = !reusable;
  let failures = 0;

  const handle = await open(absPath, "r");
  const buffer = Buffer.allocUnsafe(Math.min(chunkSize, totalBytes));
  try {
    for (;;) {
      let state: SessionState;
      try {
        if (offsetKnown) {
          const length = Math.min(chunkSize, totalBytes - offset);
          const { bytesRead } = await handle.read(buffer, 0, length, offset);
          if (bytesRead !== length) throw new Error(`Could not read ${absPath}: the file changed during upload.`);
          state = await putChunk(sessionUri, buffer.subarray(0, length), offset, totalBytes);
        } else {
          state = await queryState(sessionUri, totalBytes);
        }
      } catch (err) {
        if (!(err instanceof TransientError)) throw err;
        failures += 1;
        if (failures > MAX_FAILURES) {
          throw new Error(`${err.message}\nGiving up for now; run the command again to continue the upload.`);
        }
        await sleep(Math.min(baseDelayMs * 2 ** (failures - 1), MAX_DELAY_MS) * (0.5 + Math.random() / 2));
        offsetKnown = false;
        continue;
      }

      if (state.kind === "done") {
        await saveSession(absPath, null);
        options.onProgress?.(totalBytes, totalBytes);
        return { videoId: state.videoId, resumed };
      }

      if (state.kind === "expired") {
        await saveSession(absPath, null);
        if (!canRestart) {
          throw new Error("The upload session expired; run the command again to start over.");
        }
        // The saved session is gone on the server side: start from the beginning once.
        sessionUri = await openSession();
        canRestart = false;
        resumed = false;
        offset = 0;
        offsetKnown = true;
        continue;
      }

      if (state.offset > offset) failures = 0;
      if (!offsetKnown && canRestart && state.offset > 0) resumed = true;
      canRestart = false;
      offset = state.offset;
      offsetKnown = true;
      options.onProgress?.(offset, totalBytes);
    }
  } finally {
    await handle.close();
  }
}
