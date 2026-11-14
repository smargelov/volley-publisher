import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/** Directory for user-level files: settings, OAuth client file, tokens and remembered answers. */
export const CONFIG_DIR = process.env.VOLLEY_CONFIG_DIR ?? join(homedir(), ".config", "volley-publisher");

export const SETTINGS_PATH = join(CONFIG_DIR, "config.json");
export const TOKEN_PATH = join(CONFIG_DIR, "token.json");

/** User settings from config.json; every field is optional. Created by the "init" command. */
export interface Settings {
  /** Title of the YouTube channel the tool is used for; "whoami" warns when another one is authorized. */
  channelTitle?: string;
  /** Text shown next to the logo on thumbnails; defaults to the channel title in upper case. */
  brandText?: string;
  /** PNG logo for thumbnails, absolute or relative to the config folder; defaults to the bundled ball. */
  logoPath?: string;
  /** Thumbnail accent color, #RRGGBB. */
  accentColor?: string;
  /** Dark thumbnail color used for text on the accent color, #RRGGBB. */
  backgroundColor?: string;
  /** IANA time zone the videos are shot in; defaults to the system one. */
  timeZone?: string;
  /** Folder with the "inbox", "done" and "thumbs" subfolders. */
  mediaDir?: string;
  /** OpenRouter model used for translations. */
  translateModel?: string;
}

const STRING_FIELDS = [
  "channelTitle",
  "brandText",
  "logoPath",
  "accentColor",
  "backgroundColor",
  "timeZone",
  "mediaDir",
  "translateModel",
] as const satisfies readonly (keyof Settings)[];

const COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
const DEFAULT_ACCENT_COLOR = "#FF7A45";
const DEFAULT_BACKGROUND_COLOR = "#1B1F2A";
const DEFAULT_TRANSLATE_MODEL = "anthropic/claude-haiku-5.5";

export function isHexColor(value: string): boolean {
  return COLOR_PATTERN.test(value);
}

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** Expands a leading "~" to the home folder. */
export function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
}

/** Checks settings and returns them without empty or unknown fields; throws on a bad value. */
export function parseSettings(raw: unknown): Settings {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("settings must be a JSON object.");
  }
  const source = raw as Record<string, unknown>;
  const settings: Settings = {};
  for (const field of STRING_FIELDS) {
    const value = source[field];
    if (value === undefined || value === null || value === "") continue;
    if (typeof value !== "string") throw new Error(`"${field}" must be a string.`);
    settings[field] = value.trim();
  }
  for (const field of ["accentColor", "backgroundColor"] as const) {
    const value = settings[field];
    if (value && !isHexColor(value)) throw new Error(`"${field}" must look like #RRGGBB.`);
  }
  if (settings.timeZone && !isTimeZone(settings.timeZone)) {
    throw new Error(`"timeZone" is not a known time zone: ${settings.timeZone}`);
  }
  return settings;
}

function readSettings(): Settings {
  if (!existsSync(SETTINGS_PATH)) return {};
  try {
    return parseSettings(JSON.parse(readFileSync(SETTINGS_PATH, "utf8")));
  } catch (err) {
    throw new Error(`Invalid settings in ${SETTINGS_PATH}: ${(err as Error).message}`);
  }
}

/** Settings are read once at startup: both the CLI and the Raycast extension are short-lived. */
export const SETTINGS = readSettings();

/** Root folder with source videos: "inbox" holds unprocessed files, "done" the processed ones. */
export const MEDIA_DIR =
  process.env.VOLLEY_MEDIA_DIR ??
  (SETTINGS.mediaDir ? expandHome(SETTINGS.mediaDir) : join(homedir(), "Movies", "Volley"));
export const INBOX_DIR = join(MEDIA_DIR, "inbox");
export const DONE_DIR = join(MEDIA_DIR, "done");

/** Time zone the videos are shot in; used to turn UTC metadata into local dates. */
export const TIME_ZONE =
  process.env.VOLLEY_TIME_ZONE ?? SETTINGS.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Text shown next to the logo on thumbnails; empty when no channel is configured. */
export const BRAND_TEXT = SETTINGS.brandText ?? SETTINGS.channelTitle?.toUpperCase() ?? "";

export const ACCENT_COLOR = SETTINGS.accentColor ?? DEFAULT_ACCENT_COLOR;
export const BACKGROUND_COLOR = SETTINGS.backgroundColor ?? DEFAULT_BACKGROUND_COLOR;

export const TRANSLATE_MODEL =
  process.env.VOLLEY_TRANSLATE_MODEL ?? SETTINGS.translateModel ?? DEFAULT_TRANSLATE_MODEL;

/** Path of the user's own thumbnail logo; undefined when the bundled one should be used. */
export function resolveLogoPath(): string | undefined {
  if (!SETTINGS.logoPath) return undefined;
  const path = expandHome(SETTINGS.logoPath);
  return isAbsolute(path) ? path : join(CONFIG_DIR, path);
}

/** Full channel management scope: uploads, metadata updates, thumbnails, playlists. */
export const SCOPES = ["https://www.googleapis.com/auth/youtube"];

/**
 * Resolves the OAuth client file downloaded from Google Cloud Console.
 * Lookup order: VOLLEY_CLIENT_SECRET env, config dir, current working directory.
 */
export function resolveClientSecretPath(): string {
  const candidates = [
    process.env.VOLLEY_CLIENT_SECRET,
    join(CONFIG_DIR, "client_secret.json"),
    join(process.cwd(), "client_secret.json"),
  ].filter((p): p is string => Boolean(p));

  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    throw new Error(
      `OAuth client file not found. Put client_secret.json into one of:\n` +
        candidates.map((p) => `  - ${p}`).join("\n"),
    );
  }
  return found;
}
