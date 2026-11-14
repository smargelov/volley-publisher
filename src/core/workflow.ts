import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DONE_DIR, INBOX_DIR } from "./config.js";
import { listVideoFiles, type MediaFile, type SourceFile } from "./media.js";
import { loadStore, type EventType, type SessionAnswers, type Store, type Venue, type VideoAnswers } from "./store.js";
import {
  buildDescription,
  buildOverlay,
  buildTags,
  buildTitle,
  hasCyrillic,
  splitNames,
  transliterate,
  type ThumbnailOverlay,
  type VideoMeta,
} from "./text.js";
import { loadOpenRouterKey, translateKnownStage, translateTexts } from "./translate.js";
import {
  addToPlaylist,
  isUnprocessed,
  listRecentVideos,
  setThumbnail,
  updateVideo,
  type PrivacyStatus,
  type VideoInfo,
} from "./youtube.js";

const RECENT_VIDEOS_LIMIT = 50;

export interface ChannelVideo {
  video: VideoInfo;
  /** Source file on disk, looked up in inbox and then in done. */
  localPath?: string;
  /** True while the video still has the file name as its title. */
  raw: boolean;
}

/** Finds the source file of a video by the file name YouTube remembers for it. */
export function findLocalFile(video: VideoInfo): string | undefined {
  if (!video.fileName) return undefined;
  return [join(INBOX_DIR, video.fileName), join(DONE_DIR, video.fileName)].find((p) => existsSync(p));
}

/**
 * Videos uploaded by this tool are matched to their source files through the store,
 * because YouTube does not always keep the original file name for API uploads.
 */
export function withUploadedFileNames(videos: VideoInfo[], uploads: Record<string, string>): VideoInfo[] {
  return videos.map((video) => {
    const fileName = uploads[video.id];
    return fileName ? { ...video, fileName } : video;
  });
}

/** Lists recent channel videos, newest first, with their local source files. */
export async function listChannelVideos(): Promise<ChannelVideo[]> {
  const [recent, store] = await Promise.all([listRecentVideos("uploads", RECENT_VIDEOS_LIMIT), loadStore()]);
  const videos = withUploadedFileNames(recent, store.uploads);
  return videos.map((video) => ({ video, localPath: findLocalFile(video), raw: isUnprocessed(video) }));
}

/** Inbox files that no recent channel video was made from: they still have to be uploaded. */
export async function listPendingUploads(videos: VideoInfo[]): Promise<SourceFile[]> {
  const onChannel = new Set(videos.map((video) => video.fileName));
  return (await listVideoFiles(INBOX_DIR)).filter((file) => !onChannel.has(file.fileName));
}

/**
 * Answers are stored under the YouTube video id and, as a backup, under the source file name.
 * When a file is uploaded again it gets a new id; this links the earlier answers to it,
 * taking them from the file-name key or from another channel video of the same file.
 * Returns true when the store was changed.
 */
export function adoptAnswers(store: Store, videos: VideoInfo[]): boolean {
  let changed = false;
  for (const video of videos) {
    if (!video.fileName || store.videos[video.id]) continue;
    const sibling = videos.find((other) => other.fileName === video.fileName && store.videos[other.id]);
    const answers = store.videos[video.fileName] ?? (sibling ? store.videos[sibling.id] : undefined);
    if (!answers) continue;
    store.videos[video.id] = { ...answers };
    changed = true;
  }
  return changed;
}

/** Saves the answers for a video under its id and under its file name. */
export function rememberAnswers(store: Store, video: VideoInfo, answers: VideoAnswers): void {
  store.videos[video.id] = answers;
  if (video.fileName) store.videos[video.fileName] = { ...answers };
}

/**
 * Turns typed names into English spellings without asking anything:
 * unknown Cyrillic names are transliterated and remembered.
 */
export function resolvePlayersAuto(store: Store, input: string): string[] {
  return splitNames(input).map((name) => {
    const key = name.toLowerCase();
    store.players[key] ??= hasCyrillic(name) ? transliterate(name) : name;
    return store.players[key];
  });
}

export interface TranslatedDetails {
  partEn: string;
  notesEn: string;
  /** Set when something could not be translated and a fallback was used. */
  warning?: string;
}

/**
 * Turns the typed stage and notes into English without asking anything.
 * Known stages and earlier translations are free; the rest goes to the model in one call.
 * When the model is unavailable the stage is transliterated and the notes are kept as typed.
 */
export async function translateStageAndNotes(
  store: Store,
  stage: string,
  notes: string,
  previous?: VideoAnswers,
): Promise<TranslatedDetails> {
  let partEn = !hasCyrillic(stage) ? stage : (translateKnownStage(stage) ?? store.stages[stage.toLowerCase()] ?? "");
  let notesEn = !hasCyrillic(notes) ? notes : previous?.notes === notes ? (previous.notesEn ?? "") : "";

  const pending: Record<string, string> = {};
  if (stage && !partEn) pending.stage = stage;
  if (notes && !notesEn) pending.notes = notes;
  if (Object.keys(pending).length === 0) return { partEn, notesEn };

  let translated: Record<string, string> = {};
  let warning: string | undefined;
  const apiKey = await loadOpenRouterKey();
  if (!apiKey) {
    warning = "No OpenRouter key: the text was not translated.";
  } else {
    try {
      translated = await translateTexts(apiKey, { texts: pending, glossary: store.players });
    } catch (err) {
      warning = `Translation failed: ${(err as Error).message}`;
    }
  }

  if (pending.stage) {
    partEn = translated.stage ?? transliterate(stage);
    // Only real translations are remembered, so a failed attempt is retried next time.
    if (translated.stage) store.stages[stage.toLowerCase()] = partEn;
  }
  if (pending.notes) notesEn = translated.notes ?? notes;
  return { partEn, notesEn, warning };
}

/** Everything needed to describe one video on YouTube, derived from the saved answers. */
export interface VideoPlan {
  event: EventType;
  venue: Venue;
  session: SessionAnswers;
  meta: VideoMeta;
  title: string;
  description: string;
  tags: string[];
  overlay: ThumbnailOverlay;
}

/**
 * Builds the plan for a video from the answers saved in the store.
 * Returns null when the day or the video has not been described yet.
 */
export function buildPlan(store: Store, file: MediaFile, videoId: string): VideoPlan | null {
  const session = store.sessions[file.localDate];
  const answers = store.videos[videoId];
  if (!session || !answers) return null;

  const event = store.eventTypes.find((e) => e.id === session.eventTypeId);
  const venue = store.venues.find((v) => v.id === session.venueId);
  if (!event || !venue) return null;

  const meta: VideoMeta = {
    event,
    venue,
    discipline: session.discipline,
    localDate: file.localDate,
    localTime: file.localTime,
    teamA: resolvePlayersAuto(store, answers.teamA),
    teamB: resolvePlayersAuto(store, answers.teamB),
    part: (answers.partEn ?? answers.part) || undefined,
    score: answers.score || undefined,
    notes: answers.notesEn || undefined,
  };

  return {
    event,
    venue,
    session,
    meta,
    title: answers.titleOverride || buildTitle(meta),
    description: buildDescription(meta),
    tags: buildTags(meta),
    overlay: buildOverlay(meta),
  };
}

/** Kept next to the thumbnail: YouTube video id -> SHA-256 of the image YouTube last accepted for it. */
const SENT_THUMBNAILS_FILE = "uploaded.json";

/**
 * Sets the video's thumbnail unless YouTube already has this very image for it.
 * YouTube limits how many thumbnails an account may upload in a short time, so an
 * unchanged image is not sent again. Returns false when the upload was skipped.
 */
export async function sendThumbnail(videoId: string, jpegPath: string): Promise<boolean> {
  const recordPath = join(dirname(jpegPath), SENT_THUMBNAILS_FILE);
  const hash = createHash("sha256").update(await readFile(jpegPath)).digest("hex");
  let sent: Record<string, string> = {};
  try {
    sent = JSON.parse(await readFile(recordPath, "utf8")) as Record<string, string>;
  } catch {
    // No record yet: nothing has been sent from this folder.
  }
  if (sent[videoId] === hash) return false;

  await setThumbnail(videoId, jpegPath);
  sent[videoId] = hash;
  await writeFile(recordPath, JSON.stringify(sent, null, 2));
  return true;
}

/**
 * Writes the plan to YouTube: details, thumbnail, playlist.
 * Returns warnings for steps that failed without blocking the rest.
 */
export async function applyPlan(
  video: VideoInfo,
  file: MediaFile,
  plan: VideoPlan,
  privacyStatus: PrivacyStatus,
  thumbnail?: string,
): Promise<string[]> {
  const warnings: string[] = [];
  await updateVideo(video.id, {
    title: plan.title,
    description: plan.description,
    tags: plan.tags,
    recordingDate: file.recordedAt,
    privacyStatus,
  });

  if (thumbnail) {
    try {
      await sendThumbnail(video.id, thumbnail);
    } catch (err) {
      warnings.push(`Thumbnail was not set: ${(err as Error).message}`);
    }
  }
  if (plan.session.playlistId) {
    try {
      await addToPlaylist(plan.session.playlistId, video.id);
    } catch (err) {
      warnings.push(`Not added to the playlist: ${(err as Error).message}`);
    }
  }
  return warnings;
}

/**
 * Moves source files of fully processed, already described videos from inbox to done.
 * A file is left alone while YouTube is still receiving or processing it, so a running
 * upload in the browser is never broken. Returns the names of the moved files.
 */
export async function tidyInbox(known?: VideoInfo[]): Promise<string[]> {
  // A list fetched by the caller is reused to save an API request.
  const videos = known ?? (await listRecentVideos("uploads", RECENT_VIDEOS_LIMIT));
  await mkdir(DONE_DIR, { recursive: true });

  const moved: string[] = [];
  for (const video of videos) {
    if (!video.fileName || isUnprocessed(video) || video.uploadStatus !== "processed") continue;
    const source = join(INBOX_DIR, video.fileName);
    if (!existsSync(source)) continue;
    await rename(source, join(DONE_DIR, video.fileName));
    moved.push(video.fileName);
  }
  return moved;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Remembers when each video was first seen public and fully processed,
 * and forgets it when a video is taken out of public access again.
 * Returns true when the store was changed.
 */
export function trackPublicVideos(store: Store, videos: VideoInfo[], now = new Date()): boolean {
  let changed = false;
  for (const video of videos) {
    const answers = store.videos[video.id];
    if (!answers) continue;
    const isLive = video.privacyStatus === "public" && video.uploadStatus === "processed";
    if (isLive && !answers.publicSince) {
      answers.publicSince = now.toISOString();
      changed = true;
    } else if (!isLive && answers.publicSince) {
      delete answers.publicSince;
      changed = true;
    }
  }
  return changed;
}

/**
 * Finds source files in the done folder whose videos have been public for the given number of days.
 * Only videos the tool has described are considered, so nothing unknown is ever picked.
 */
export function findExpiredSources(
  store: Store,
  videos: VideoInfo[],
  retentionDays: number,
  now = new Date(),
): string[] {
  const expired: string[] = [];
  for (const video of videos) {
    const publicSince = store.videos[video.id]?.publicSince;
    if (!publicSince || !video.fileName) continue;
    if (video.privacyStatus !== "public" || video.uploadStatus !== "processed") continue;
    if (now.getTime() - new Date(publicSince).getTime() < retentionDays * DAY_MS) continue;

    const path = join(DONE_DIR, video.fileName);
    if (existsSync(path)) expired.push(path);
  }
  return expired;
}
