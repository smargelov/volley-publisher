import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  ACCENT_COLOR,
  BACKGROUND_COLOR,
  CONFIG_DIR,
  MEDIA_DIR,
  SETTINGS,
  SETTINGS_PATH,
  TIME_ZONE,
  expandHome,
  isHexColor,
  parseSettings,
} from "../core/config.js";
import { ask } from "./prompts.js";

async function askColor(question: string, current: string): Promise<string> {
  for (;;) {
    const value = await ask(question, current);
    if (isHexColor(value)) return value;
    console.log("Enter a color like #FFC53D.");
  }
}

/** Asks for the channel settings and writes them to config.json. */
export async function cmdInit(): Promise<void> {
  console.log(`Settings file: ${SETTINGS_PATH}`);
  console.log("Press Enter to keep the value in brackets.\n");

  const channelTitle = await ask("YouTube channel title", SETTINGS.channelTitle);
  const brandText = await ask(
    "Text next to the logo on thumbnails",
    SETTINGS.brandText ?? channelTitle.toUpperCase(),
  );
  const logoPath = await ask("Your logo, a square PNG (empty for the bundled volleyball)", SETTINGS.logoPath);
  const accentColor = await askColor("Accent color of thumbnails", ACCENT_COLOR);
  const backgroundColor = await askColor("Dark color of thumbnails", BACKGROUND_COLOR);
  const timeZone = await ask("Time zone the videos are shot in", TIME_ZONE);
  const mediaDir = await ask("Folder for videos", SETTINGS.mediaDir ?? MEDIA_DIR);

  // Fields this command does not ask about are kept as they are.
  const settings = parseSettings({
    ...SETTINGS,
    channelTitle,
    brandText,
    logoPath,
    accentColor,
    backgroundColor,
    timeZone,
    mediaDir,
  });

  if (settings.logoPath) {
    const logo = expandHome(settings.logoPath);
    if (!existsSync(isAbsolute(logo) ? logo : join(CONFIG_DIR, logo))) {
      console.warn(`Warning: no logo file at ${settings.logoPath} yet.`);
    }
  }

  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await writeFile(SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`);
  const media = expandHome(mediaDir);
  for (const sub of ["inbox", "done", "thumbs"]) {
    await mkdir(join(media, sub), { recursive: true });
  }

  console.log(`\nSaved ${SETTINGS_PATH}`);
  if (!existsSync(join(CONFIG_DIR, "client_secret.json"))) {
    console.log(`Next: put your OAuth client file into ${join(CONFIG_DIR, "client_secret.json")}`);
    console.log("      and run: npm run volley -- auth");
  }
}
