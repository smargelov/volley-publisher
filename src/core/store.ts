import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_DIR } from "./config.js";

const STORE_PATH = join(CONFIG_DIR, "store.json");

export type Discipline = "beach" | "indoor";

export interface Venue {
  id: string;
  name: string;
  city: string;
  country: string;
  /** Kept for reference only: YouTube's API no longer accepts a recording location. */
  latitude?: number;
  longitude?: number;
}

export interface EventType {
  id: string;
  /** How the user calls this kind of games in their own language. */
  nameRu: string;
  /** Public English name used in titles, e.g. "Open Play". */
  nameEn: string;
}

/** Answers shared by all videos shot on the same day. */
export interface SessionAnswers {
  eventTypeId: string;
  venueId: string;
  discipline: Discipline;
  playlistId?: string;
  playlistTitle?: string;
}

/** Answers given for one video, kept so a repeated run does not ask for them again. */
export interface VideoAnswers {
  teamA: string;
  teamB: string;
  /** Stage or set as typed by the user, e.g. "Полуфинал". */
  part: string;
  score: string;
  /** Free-form notes as typed, and their English version used in the description. */
  notes?: string;
  notesEn?: string;
  /** English stage name when it differs from what was typed. */
  partEn?: string;
  /** Title typed by the user instead of the generated one. */
  titleOverride?: string;
  /** When the tool first saw the video public and fully processed, ISO 8601. */
  publicSince?: string;
}

export interface Store {
  venues: Venue[];
  eventTypes: EventType[];
  /** Maps a lower-cased name as typed by the user to its English spelling. */
  players: Record<string, string>;
  /** Keyed by local recording date, YYYY-MM-DD. */
  sessions: Record<string, SessionAnswers>;
  /** Remembers the playlist picked for an event type + venue pair. */
  playlistByKey: Record<string, { id: string; title: string }>;
  /** Keyed by YouTube video id. */
  videos: Record<string, VideoAnswers>;
  /** Stage names translated earlier: lower-cased original -> English. */
  stages: Record<string, string>;
  /** Videos uploaded by this tool: YouTube video id -> source file name. */
  uploads: Record<string, string>;
}

const DEFAULT_STORE: Store = {
  venues: [],
  eventTypes: [],
  players: {},
  sessions: {},
  playlistByKey: {},
  videos: {},
  stages: {},
  uploads: {},
};

export async function loadStore(): Promise<Store> {
  try {
    const saved = JSON.parse(await readFile(STORE_PATH, "utf8")) as Partial<Store>;
    return { ...structuredClone(DEFAULT_STORE), ...saved };
  } catch {
    return structuredClone(DEFAULT_STORE);
  }
}

export async function saveStore(store: Store): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await writeFile(STORE_PATH, JSON.stringify(store, null, 2));
}

/** Builds a stable id from a human-readable name. */
export function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || `item-${Date.now()}`
  );
}

export function playlistKey(eventTypeId: string, venueId: string): string {
  return `${eventTypeId}|${venueId}`;
}
