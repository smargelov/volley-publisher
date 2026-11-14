import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { INBOX_DIR } from "../core/config.js";
import { formatDuration, probeFile, type MediaFile } from "../core/media.js";
import {
  loadStore,
  playlistKey,
  saveStore,
  slugify,
  type Discipline,
  type EventType,
  type SessionAnswers,
  type Store,
  type Venue,
  type VideoAnswers,
} from "../core/store.js";
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
} from "../core/text.js";
import {
  extractPreviewFrames,
  loadCropChoice,
  parseTimecode,
  renderBaseFrame,
  thumbnailPath,
} from "../core/thumbnail.js";
import {
  addToPlaylist,
  createPlaylist,
  getVideos,
  isUnprocessed,
  listPlaylists,
  listRecentVideos,
  updateVideo,
  type PrivacyStatus,
  type VideoInfo,
} from "../core/youtube.js";
import {
  loadOpenRouterKey,
  openRouterKeyPath,
  translateKnownStage,
  translateTexts,
} from "../core/translate.js";
import { sendThumbnail, tidyInbox } from "../core/workflow.js";
import { runThumbnailSession } from "../ui/cropSession.js";
import { ask, choose, confirm } from "./prompts.js";

const RECENT_VIDEOS_LIMIT = 50;
const PRIVACY_VALUES: PrivacyStatus[] = ["private", "unlisted", "public"];

function localPathFor(video: VideoInfo): string | undefined {
  if (!video.fileName) return undefined;
  const path = join(INBOX_DIR, video.fileName);
  return existsSync(path) ? path : undefined;
}

/** Videos uploaded by this tool are matched to their source files through the store. */
async function withUploadedFileNames(videos: VideoInfo[]): Promise<VideoInfo[]> {
  const { uploads } = await loadStore();
  return videos.map((v) => {
    const fileName = uploads[v.id];
    return fileName ? { ...v, fileName } : v;
  });
}

/** Picks the video to work on: an explicit id, or one of the raw Studio uploads. */
async function pickVideo(videoId?: string): Promise<VideoInfo> {
  if (videoId) {
    const [video] = await withUploadedFileNames(await getVideos([videoId]));
    if (!video) throw new Error(`Video ${videoId} not found on the channel.`);
    return video;
  }

  const recent = await withUploadedFileNames(await listRecentVideos("uploads", RECENT_VIDEOS_LIMIT));
  const pending = recent.filter(isUnprocessed);
  if (pending.length === 0) {
    throw new Error("No raw uploads found: every recent video already has a custom title.");
  }
  // Oldest recording first: file names start with the recording timestamp.
  pending.sort((a, b) => (a.fileName ?? "").localeCompare(b.fileName ?? ""));
  if (pending.length === 1 && pending[0]) return pending[0];

  const picked = await choose(
    "Videos waiting for details:",
    pending.map((v) => ({
      label: `${v.fileName}${localPathFor(v) ? "" : "  (no local file)"}`,
      value: v,
    })),
  );
  if (!picked) throw new Error("Nothing selected.");
  return picked;
}

async function askEventType(store: Store): Promise<EventType> {
  const picked = await choose(
    "What kind of games is it?",
    store.eventTypes.map((e) => ({ label: `${e.nameRu} (${e.nameEn})`, value: e })),
    "Add a new type",
  );
  if (picked) return picked;

  const nameRu = await ask("Name as you call it");
  const nameEn = await ask("English name for titles", transliterate(nameRu));
  const eventType = { id: slugify(nameEn), nameRu, nameEn };
  store.eventTypes.push(eventType);
  return eventType;
}

async function askVenue(store: Store): Promise<Venue> {
  const picked = await choose(
    "Where was it shot?",
    store.venues.map((v) => ({ label: `${v.name}, ${v.city}`, value: v })),
    "Add a new venue",
  );
  if (picked) return picked;

  const last = store.venues.at(-1);
  const name = await ask("Venue name (English)");
  const city = await ask("City", last?.city);
  const country = await ask("Country", last?.country);
  const venue: Venue = { id: slugify(name), name, city, country };
  store.venues.push(venue);
  return venue;
}

async function askPlaylist(
  store: Store,
  event: EventType,
  venue: Venue,
): Promise<{ id: string; title: string } | undefined> {
  const key = playlistKey(event.id, venue.id);
  const remembered = store.playlistByKey[key];
  const suggestedTitle = `${event.nameEn} - ${venue.name}`;
  const playlists = await listPlaylists();

  // Prefer the playlist used before for this event + venue, then one with the suggested name.
  const preferred =
    playlists.find((p) => p.id === remembered?.id) ?? playlists.find((p) => p.title === suggestedTitle);
  const ordered = preferred ? [preferred, ...playlists.filter((p) => p !== preferred)] : playlists;

  const NONE = "none";
  const picked = await choose<{ id: string; title: string } | typeof NONE>(
    "Playlist:",
    [
      ...ordered.map((p) => ({ label: p.title, value: p })),
      { label: "Do not add to a playlist", value: NONE },
    ],
    "Create a new playlist",
  );
  if (picked === NONE) return undefined;

  const playlist = picked ?? (await createPlaylist(await ask("New playlist title", suggestedTitle)));
  store.playlistByKey[key] = playlist;
  return playlist;
}

/** Collects answers shared by all videos of the same shooting day, reusing earlier ones. */
async function askSession(
  store: Store,
  localDate: string,
  withPlaylist = true,
): Promise<SessionAnswers> {
  const saved = store.sessions[localDate];
  if (saved) {
    const event = store.eventTypes.find((e) => e.id === saved.eventTypeId);
    const venue = store.venues.find((v) => v.id === saved.venueId);
    if (event && venue) {
      console.log(
        `\nSame day as before: ${event.nameRu} (${event.nameEn}), ${venue.name}, ` +
          `${saved.discipline}, playlist: ${saved.playlistTitle ?? "none"}`,
      );
      if (await confirm("Use the same details?")) return saved;
    }
  }

  const event = await askEventType(store);
  const venue = await askVenue(store);
  const discipline =
    (await choose<Discipline>("Discipline:", [
      { label: "Beach volleyball", value: "beach" },
      { label: "Indoor volleyball", value: "indoor" },
    ])) ?? "beach";
  const playlist = withPlaylist ? await askPlaylist(store, event, venue) : undefined;

  const session: SessionAnswers = {
    eventTypeId: event.id,
    venueId: venue.id,
    discipline,
    playlistId: playlist?.id,
    playlistTitle: playlist?.title,
  };
  // A session without the playlist answer is not remembered: "apply" still has to ask for it.
  if (withPlaylist) store.sessions[localDate] = session;
  return session;
}

/** Turns typed names into English spellings, asking once per new Cyrillic name. */
async function resolvePlayers(store: Store, input: string): Promise<string[]> {
  const result: string[] = [];
  for (const name of splitNames(input)) {
    const key = name.toLowerCase();
    let english = store.players[key];
    if (!english) {
      english = hasCyrillic(name)
        ? await ask(`English spelling for "${name}"`, transliterate(name))
        : name;
      store.players[key] = english;
    }
    result.push(english);
  }
  return result;
}

function openInViewer(path: string): void {
  if (process.platform === "darwin") {
    execFile("open", [path], () => {});
  }
}

/**
 * Thumbnail flow: moment -> frame, crop area and graphics preview in the browser.
 * Returns the thumbnail path, or undefined when the user skips it.
 */
async function askThumbnail(
  file: MediaFile,
  overlay: ThumbnailOverlay,
  initialMoment?: string,
): Promise<string | undefined> {
  // A frame and crop picked earlier can be reused, e.g. after the texts have changed.
  const saved = initialMoment ? null : await loadCropChoice(file.path);
  if (saved && (await confirm("\nReuse the frame and crop picked earlier?"))) {
    await renderBaseFrame(file, saved.timeSec, saved.crop);
    const thumbnail = await runThumbnailSession({ file, frames: [], overlay });
    if (thumbnail) return thumbnail;
    console.log("Cancelled.");
  }

  let preset = initialMoment;
  for (;;) {
    const input =
      preset ??
      (await ask(`\nThumbnail moment, m:ss (video is ${formatDuration(file.durationSec)}; empty to skip)`));
    preset = undefined;
    if (!input) return undefined;

    const atSec = parseTimecode(input);
    if (atSec === null || atSec >= file.durationSec) {
      console.log("Enter a time inside the video, e.g. 4:37.");
      continue;
    }

    console.log("Extracting frames...");
    const frames = await extractPreviewFrames(file, atSec);
    if (frames.length === 0) {
      console.log("No frames extracted, try another moment.");
      continue;
    }

    console.log("Pick the frame and the crop area in the browser, then save the thumbnail there.");
    const thumbnail = await runThumbnailSession({ file, frames, overlay });
    if (thumbnail) return thumbnail;
    console.log("Cancelled.");
  }
}

interface VideoDetails {
  teamA: string[];
  teamB: string[];
  /** Stage or set in English. */
  part: string;
  score: string;
  /** Notes in English. */
  notes: string;
}

/**
 * Turns the typed stage and notes into English.
 * Known stages and earlier translations are free; anything else goes to the model in one call.
 * Without an OpenRouter key the user is asked to type the English text.
 */
async function translateDetails(
  store: Store,
  stage: string,
  notes: string,
  previous?: VideoAnswers,
): Promise<{ part: string; notes: string }> {
  let part = !hasCyrillic(stage) ? stage : (translateKnownStage(stage) ?? store.stages[stage.toLowerCase()] ?? "");
  let notesEn = !hasCyrillic(notes) ? notes : previous?.notes === notes ? (previous.notesEn ?? "") : "";

  const pending: Record<string, string> = {};
  if (stage && !part) pending.stage = stage;
  if (notes && !notesEn) pending.notes = notes;
  if (Object.keys(pending).length === 0) return { part, notes: notesEn };

  const apiKey = await loadOpenRouterKey();
  let translated: Record<string, string> = {};
  if (apiKey) {
    try {
      // Player spellings are passed along so names in notes match the title.
      translated = await translateTexts(apiKey, { texts: pending, glossary: store.players });
    } catch (err) {
      console.warn(`Translation failed: ${(err as Error).message}`);
    }
  } else {
    console.log(`No OpenRouter key found (${openRouterKeyPath()}), so type the English text yourself.`);
  }

  // The user always sees the English text and can correct it.
  if (pending.stage) {
    part = await ask(`Stage in English for "${stage}"`, translated.stage ?? transliterate(stage));
    store.stages[stage.toLowerCase()] = part;
  }
  if (pending.notes) {
    notesEn = await ask("Notes in English", translated.notes);
  }
  return { part, notes: notesEn };
}

/** Asks for the per-video details and remembers them under the given key. */
async function askVideoDetails(store: Store, key: string): Promise<VideoDetails> {
  const previous = store.videos[key];
  console.log("\nTeams (names separated by commas; empty to skip)");
  const teamAInput = await ask("Team 1", previous?.teamA);
  const teamBInput = teamAInput ? await ask("Team 2", previous?.teamB) : "";
  const teamA = await resolvePlayers(store, teamAInput);
  const teamB = await resolvePlayers(store, teamBInput);
  const stageInput = await ask(
    'Stage or set in any language, e.g. "Полуфинал", "Сет 2" (empty to skip)',
    previous?.part,
  );
  const score = await ask("Score (empty to skip)", previous?.score);
  const notesInput = await ask("Notes for the description in any language (empty to skip)", previous?.notes);

  const { part, notes } = await translateDetails(store, stageInput, notesInput, previous);
  store.videos[key] = {
    teamA: teamAInput,
    teamB: teamBInput,
    part: stageInput,
    score,
    notes: notesInput,
    notesEn: notes,
  };
  return { teamA, teamB, part, score, notes };
}

/** Standalone thumbnail maker: asks the same questions as "apply" but does not touch YouTube. */
export async function cmdThumb(args: string[]): Promise<void> {
  const [fileArg, moment] = args;
  if (!fileArg) {
    throw new Error("Usage: volley thumb <file> [m:ss]");
  }
  // A bare file name is looked up in the inbox folder.
  const path = fileArg.includes("/") ? resolve(fileArg) : join(INBOX_DIR, fileArg);
  const file = await probeFile(path);

  const store = await loadStore();
  const session = await askSession(store, file.localDate, false);
  const event = store.eventTypes.find((e) => e.id === session.eventTypeId);
  const venue = store.venues.find((v) => v.id === session.venueId);
  if (!event || !venue) throw new Error("Saved session refers to a missing event type or venue.");
  // Without a YouTube id the answers are remembered by file name.
  const details = await askVideoDetails(store, file.fileName);
  await saveStore(store);

  const overlay = buildOverlay({
    event,
    venue,
    discipline: session.discipline,
    localDate: file.localDate,
    localTime: file.localTime,
    teamA: details.teamA,
    teamB: details.teamB,
    part: details.part || undefined,
  });
  const thumbnail = await askThumbnail(file, overlay, moment);
  console.log(thumbnail ? `Saved: ${thumbnail}` : "No thumbnail created.");
}

export async function cmdApply(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { privacy: { type: "string", default: "unlisted" } },
  });
  const privacy = values.privacy as PrivacyStatus;
  if (!PRIVACY_VALUES.includes(privacy)) {
    throw new Error(`--privacy must be one of: ${PRIVACY_VALUES.join(", ")}`);
  }

  const video = await pickVideo(positionals[0]);
  const localPath = localPathFor(video);
  if (!localPath) {
    throw new Error(`Source file ${video.fileName ?? "(unknown)"} is not in ${INBOX_DIR}`);
  }
  const file = await probeFile(localPath);
  console.log(
    `\nVideo: ${file.fileName} — recorded ${file.localDate} ${file.localTime}, ` +
      `${formatDuration(file.durationSec)}, ${file.camera}`,
  );

  const store = await loadStore();
  const session = await askSession(store, file.localDate);
  const event = store.eventTypes.find((e) => e.id === session.eventTypeId);
  const venue = store.venues.find((v) => v.id === session.venueId);
  if (!event || !venue) throw new Error("Saved session refers to a missing event type or venue.");

  // Answers given earlier through "thumb" (keyed by file name) are picked up as defaults.
  store.videos[video.id] ??= store.videos[file.fileName] ?? { teamA: "", teamB: "", part: "", score: "" };
  const { teamA, teamB, part, score, notes } = await askVideoDetails(store, video.id);
  await saveStore(store);

  const meta: VideoMeta = {
    event,
    venue,
    discipline: session.discipline,
    localDate: file.localDate,
    localTime: file.localTime,
    teamA,
    teamB,
    part: part || undefined,
    score: score || undefined,
    notes: notes || undefined,
  };
  const title = await ask("\nTitle", buildTitle(meta));
  const description = buildDescription(meta);
  console.log(`\nDescription:\n${description.replace(/^/gm, "  ")}`);

  // A finished thumbnail made earlier is offered first. A saved crop choice marks thumbnails
  // produced by the editor; older ones without channel graphics are never offered.
  const readyThumbnail = thumbnailPath(file.path);
  let thumbnail: string | undefined;
  if (existsSync(readyThumbnail) && (await loadCropChoice(file.path))) {
    openInViewer(readyThumbnail);
    if (await confirm(`\nUse the thumbnail made earlier (${readyThumbnail})?`)) {
      thumbnail = readyThumbnail;
    }
  }
  thumbnail ??= await askThumbnail(file, buildOverlay(meta));

  console.log(`\nVisibility: ${privacy}`);
  console.log(`Playlist:   ${session.playlistTitle ?? "none"}`);
  console.log(`Thumbnail:  ${thumbnail ?? "not set"}`);
  if (!(await confirm("Write this to YouTube?"))) {
    console.log("Cancelled, nothing was changed on YouTube.");
    return;
  }

  await updateVideo(video.id, {
    title,
    description,
    tags: buildTags(meta),
    recordingDate: file.recordedAt,
    privacyStatus: privacy,
  });
  console.log("Details saved.");
  if (thumbnail) {
    // A thumbnail problem must not block the remaining steps: details are already saved.
    try {
      const sent = await sendThumbnail(video.id, thumbnail);
      console.log(sent ? "Thumbnail set." : "Thumbnail unchanged, not sent again.");
    } catch (err) {
      console.warn(`Thumbnail NOT set: ${(err as Error).message}`);
      console.warn(
        "Custom thumbnails need a phone-verified channel: https://www.youtube.com/verify\n" +
          `After verifying, run: npm run volley -- apply ${video.id}`,
      );
    }
  }
  if (session.playlistId) {
    await addToPlaylist(session.playlistId, video.id);
    console.log("Added to the playlist.");
  }
  console.log(`\nDone: https://youtu.be/${video.id}`);

  if (video.uploadStatus !== "processed") {
    console.log('The source file stays in inbox until YouTube finishes processing; run "tidy" later.');
  }
}

/** Moves source files of fully processed, already described videos from inbox to done. */
export async function cmdTidy(): Promise<void> {
  const moved = await tidyInbox();
  for (const name of moved) console.log(`Moved to done: ${name}`);
  if (moved.length === 0) console.log("Nothing to move.");
}

/** Translates a text with the configured model; a quick check that the OpenRouter key works. */
export async function cmdTranslate(args: string[]): Promise<void> {
  const text = args.join(" ").trim();
  if (!text) throw new Error("Usage: volley translate <text>");
  const apiKey = await loadOpenRouterKey();
  if (!apiKey) throw new Error(`No OpenRouter key. Put it into ${openRouterKeyPath()}`);
  const store = await loadStore();
  const { text: english } = await translateTexts(apiKey, { texts: { text }, glossary: store.players });
  console.log(english);
}
