import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_DIR, TRANSLATE_MODEL } from "./config.js";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const KEY_PATH = join(CONFIG_DIR, "openrouter.key");
const MODEL = TRANSLATE_MODEL;
const REQUEST_TIMEOUT_MS = 30_000;

/** Common stage names that never need a model. */
const STAGE_PATTERNS: [RegExp, (match: RegExpExecArray) => string][] = [
  [/^(?:сет|партия|set)\s*№?\s*(\d+)$/i, (m) => `Set ${m[1]}`],
  [/^(\d+)[-\s]*(?:й|я|ый|ая)?\s*(?:сет|партия)$/i, (m) => `Set ${m[1]}`],
  [/^(?:игра|матч)\s*№?\s*(\d+)$/i, (m) => `Game ${m[1]}`],
  [/^финал$/i, () => "Final"],
  [/^полуфинал$|^1\/2(?:\s*финала)?$/i, () => "Semifinal"],
  [/^четвертьфинал$|^1\/4(?:\s*финала)?$/i, () => "Quarterfinal"],
  [/^1\/8(?:\s*финала)?$/i, () => "Round of 16"],
  [/^(?:группа|групповой этап)$/i, () => "Group Stage"],
  [/^матч за (?:3|третье)(?:-е)? место$/i, () => "Third Place Match"],
];

/** Translates a well-known stage name without calling a model; null when it is not recognized. */
export function translateKnownStage(input: string): string | null {
  const value = input.trim();
  for (const [pattern, build] of STAGE_PATTERNS) {
    const match = pattern.exec(value);
    if (match) return build(match);
  }
  return null;
}

/** Reads the OpenRouter key from the environment or the config folder; undefined when not set up. */
export async function loadOpenRouterKey(): Promise<string | undefined> {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  try {
    return (await readFile(KEY_PATH, "utf8")).trim() || undefined;
  } catch {
    return undefined;
  }
}

export function openRouterKeyPath(): string {
  return KEY_PATH;
}

export interface TranslationRequest {
  /** Named texts to translate; empty values are skipped. */
  texts: Record<string, string>;
  /** Known spellings (original -> English) the translation must keep, e.g. player names. */
  glossary: Record<string, string>;
}

/**
 * Translates short texts about a volleyball video into English with one model call.
 * Returns translations under the same keys as the input.
 */
export async function translateTexts(apiKey: string, request: TranslationRequest): Promise<Record<string, string>> {
  const texts = Object.fromEntries(Object.entries(request.texts).filter(([, value]) => value.trim()));
  if (Object.keys(texts).length === 0) return {};

  const glossary = Object.entries(request.glossary)
    .map(([from, to]) => `${from} = ${to}`)
    .join("\n");
  const system = [
    "You translate short texts about amateur volleyball videos into natural, concise English",
    "for YouTube titles and descriptions. Use standard volleyball terms (set, rally, spike, block,",
    "semifinal). Do not add information, opinions or emojis. Keep names exactly as in the glossary;",
    "transliterate other personal names. Text that is already English stays unchanged.",
    'Reply with a JSON object that has the same keys as the input and the translations as values.',
    glossary ? `\nGlossary:\n${glossary}` : "",
  ].join(" ");

  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(texts) },
      ],
    }),
  });

  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    error?: { message?: string };
  };
  if (!res.ok || data.error) {
    throw new Error(`OpenRouter ${res.status}: ${data.error?.message ?? "request failed"} (model ${MODEL})`);
  }

  const content = data.choices?.[0]?.message?.content ?? "";
  // Some models wrap the JSON in a code fence or add text around it.
  const json = content.slice(content.indexOf("{"), content.lastIndexOf("}") + 1);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(json) as Record<string, unknown>;
  } catch {
    throw new Error(`The model returned an unexpected answer: ${content.slice(0, 200)}`);
  }

  const result: Record<string, string> = {};
  for (const key of Object.keys(texts)) {
    const value = parsed[key];
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`The model returned no translation for "${key}".`);
    }
    result[key] = value.trim();
  }
  return result;
}
