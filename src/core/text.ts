import { BRAND_TEXT } from "./config.js";
import type { Discipline, EventType, Venue } from "./store.js";

/** YouTube rejects titles longer than this. */
const MAX_TITLE_LENGTH = 100;

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const CYRILLIC_TO_LATIN: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "yo", ж: "zh", з: "z", и: "i",
  й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t",
  у: "u", ф: "f", х: "kh", ц: "ts", ч: "ch", ш: "sh", щ: "shch", ъ: "", ы: "y",
  ь: "", э: "e", ю: "yu", я: "ya",
};

export interface VideoMeta {
  event: EventType;
  venue: Venue;
  discipline: Discipline;
  /** Local recording date, YYYY-MM-DD. */
  localDate: string;
  /** Local recording start time, HH:MM. */
  localTime: string;
  /** English player names per side; both empty when teams are not specified. */
  teamA: string[];
  teamB: string[];
  /** Free-form label such as "Set 2" or "Final". */
  part?: string;
  score?: string;
  /** Extra paragraph for the description, already in English. */
  notes?: string;
}

export function hasCyrillic(value: string): boolean {
  return /[а-яё]/i.test(value);
}

/** Transliterates Russian text to Latin, capitalizing each word. */
export function transliterate(value: string): string {
  return value
    .toLowerCase()
    .split("")
    .map((ch) => CYRILLIC_TO_LATIN[ch] ?? ch)
    .join("")
    .replace(/(^|[\s-])(\p{L})/gu, (_, sep: string, letter: string) => sep + letter.toUpperCase());
}

/** Splits user input like "Анна, Maria" or "Анна и Maria" into separate names. */
export function splitNames(input: string): string[] {
  return input
    .split(/\s*(?:,|&|\+|\sи\s|\sand\s)\s*/i)
    .map((n) => n.trim())
    .filter(Boolean);
}

function dateParts(localDate: string): { day: number; month: string; year: string } {
  const [year = "", month = "1", day = "1"] = localDate.split("-");
  return { day: Number(day), month: MONTHS[Number(month) - 1] ?? "", year };
}

/** "2026-11-14" -> "14 Nov 2026" */
export function formatShortDate(localDate: string): string {
  const { day, month, year } = dateParts(localDate);
  return `${day} ${month.slice(0, 3)} ${year}`;
}

/** "2026-11-14" -> "14 November 2026" */
export function formatLongDate(localDate: string): string {
  const { day, month, year } = dateParts(localDate);
  return `${day} ${month} ${year}`;
}

function disciplineLabel(discipline: Discipline): string {
  return discipline === "beach" ? "Beach Volleyball" : "Volleyball";
}

function matchup(meta: VideoMeta): string {
  if (meta.teamA.length === 0 || meta.teamB.length === 0) return "";
  return `${meta.teamA.join(" & ")} vs ${meta.teamB.join(" & ")}`;
}

/**
 * Builds the video title, e.g.
 * "Anna & Maria vs Kate & Olga | Open Play at Sunny Beach, Lisbon | Beach Volleyball | 14 Nov 2026".
 * Less important parts are dropped when the title would exceed YouTube's limit.
 */
export function buildTitle(meta: VideoMeta): string {
  const head = [matchup(meta), meta.part].filter(Boolean).join(", ");
  // Without teams or a part label the start time keeps same-day titles distinct.
  const date = formatShortDate(meta.localDate) + (head ? "" : `, ${meta.localTime}`);
  const eventShort = `${meta.event.nameEn} at ${meta.venue.name}`;
  const eventFull = `${eventShort}, ${meta.venue.city}`;
  const discipline = disciplineLabel(meta.discipline);

  const candidates = [
    [head, eventFull, discipline, date],
    [head, eventShort, discipline, date],
    [head, eventShort, date],
  ].map((parts) => parts.filter(Boolean).join(" | "));

  const fitting = candidates.find((c) => c.length <= MAX_TITLE_LENGTH);
  return fitting ?? (candidates.at(-1) ?? "").slice(0, MAX_TITLE_LENGTH);
}

function hashtag(value: string): string {
  return `#${value.toLowerCase().replace(/[^a-z0-9]/g, "")}`;
}

export function buildDescription(meta: VideoMeta): string {
  const discipline = disciplineLabel(meta.discipline);
  const place = `${meta.venue.name}, ${meta.venue.city}, ${meta.venue.country}`;
  const teams = matchup(meta);

  const facts = [
    teams && `Teams: ${teams}`,
    meta.part && `Stage: ${meta.part}`,
    meta.score && `Score: ${meta.score}`,
    `Date: ${formatLongDate(meta.localDate)}`,
    `Venue: ${place}`,
  ].filter(Boolean);

  const hashtags = [
    hashtag(discipline),
    ...(meta.discipline === "beach" ? ["#volleyball"] : []),
    hashtag(meta.event.nameEn),
    hashtag(meta.venue.city),
  ];

  return [
    `${discipline} ${meta.event.nameEn.toLowerCase()} at ${meta.venue.name}, ${meta.venue.city}.`,
    ...(meta.notes ? ["", meta.notes] : []),
    "",
    ...facts,
    "",
    [...new Set(hashtags)].join(" "),
  ].join("\n");
}

export function buildTags(meta: VideoMeta): string[] {
  const tags = [
    disciplineLabel(meta.discipline).toLowerCase(),
    "volleyball",
    meta.event.nameEn.toLowerCase(),
    meta.venue.name,
    meta.venue.city,
    meta.venue.country,
  ];
  return [...new Set(tags)];
}

/** Texts drawn over the thumbnail. */
export interface ThumbnailOverlay {
  /** Text next to the logo; empty to show the logo alone. */
  channel: string;
  /** Sides of the match; both empty when teams are not specified. */
  left: string;
  right: string;
  eventName: string;
  part: string;
  venue: string;
  date: string;
}

export function buildOverlay(meta: VideoMeta): ThumbnailOverlay {
  const hasTeams = meta.teamA.length > 0 && meta.teamB.length > 0;
  return {
    channel: BRAND_TEXT,
    left: hasTeams ? meta.teamA.join(" & ") : "",
    right: hasTeams ? meta.teamB.join(" & ") : "",
    eventName: meta.event.nameEn,
    part: meta.part ?? "",
    venue: meta.venue.name,
    date: formatShortDate(meta.localDate),
  };
}
