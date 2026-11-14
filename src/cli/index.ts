#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { setAssetsDir } from "../core/assets.js";
import { login } from "../core/auth.js";
import { INBOX_DIR, SETTINGS, TOKEN_PATH } from "../core/config.js";
import { formatDuration, scanDirectory } from "../core/media.js";
import { cmdApply, cmdThumb, cmdTidy, cmdTranslate } from "./apply.js";
import { cmdInit } from "./init.js";
import { closePrompts } from "./prompts.js";
import { cmdUpload } from "./upload.js";
import { getMyChannel, listRecentVideos, type ListSource } from "../core/youtube.js";

// Default logo and fonts sit in the repository root, two levels above this file.
setAssetsDir(fileURLToPath(new URL("../../assets/", import.meta.url)));

/** Channel the tool is set up for, if any; a mismatch only produces a warning. */
const EXPECTED_CHANNEL_TITLE = SETTINGS.channelTitle;

const HELP = `Usage: volley <command> [options]

Commands:
  init                 Set up the channel name, logo, colors and folders
  auth                 Authorize access to the YouTube channel (opens the browser)
  whoami               Show the channel the stored token belongs to
  list                 List recent videos of the channel with their statuses
  upload [file]        Upload a source video as private (resumable; default: pick from inbox)
  apply [videoId]      Fill in title, description, thumbnail and playlist for a video
  thumb <file> [m:ss]  Make a thumbnail only: pick a frame and crop it in the browser
  translate <text>     Translate a text to English (checks the OpenRouter key)
  tidy                 Move source files of finished videos from inbox to done
  scan [dir]           Show local source videos and what can be read from them
                       (default dir: the inbox folder)

Options for "list":
  --source <uploads|search>  Where to take videos from (default: uploads).
                             "search" costs more quota but may find Studio drafts.
  --limit <n>                How many videos to show (default: 15, max: 50)

Options for "upload":
  --yes, -y                  Do not ask for confirmation

Options for "apply":
  --privacy <private|unlisted|public>  Visibility to set (default: unlisted)
`;

async function printChannel(): Promise<void> {
  const channel = await getMyChannel();
  console.log(`Channel: ${channel.title}${channel.customUrl ? ` (${channel.customUrl})` : ""}`);
  console.log(`ID:      ${channel.id}`);
  if (EXPECTED_CHANNEL_TITLE && channel.title !== EXPECTED_CHANNEL_TITLE) {
    console.warn(
      `\nWarning: expected the "${EXPECTED_CHANNEL_TITLE}" channel. ` +
        `Run "auth" again and pick it on the Google account chooser.`,
    );
  }
}

async function cmdAuth(): Promise<void> {
  console.log("Opening the browser for Google authorization...");
  console.log(
    `Pick ${EXPECTED_CHANNEL_TITLE ? `the "${EXPECTED_CHANNEL_TITLE}"` : "your"} channel when Google asks which account to use.\n`,
  );
  await login((url) => console.log(`If the browser did not open, visit:\n${url}\n`));
  console.log(`Token saved to ${TOKEN_PATH}\n`);
  await printChannel();
}

async function cmdList(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      source: { type: "string", default: "uploads" },
      limit: { type: "string", default: "15" },
    },
  });
  if (values.source !== "uploads" && values.source !== "search") {
    throw new Error('--source must be "uploads" or "search"');
  }
  const limit = Number(values.limit);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("--limit must be a positive integer");
  }

  const videos = await listRecentVideos(values.source as ListSource, limit);
  if (videos.length === 0) {
    console.log("No videos found.");
    return;
  }
  console.table(
    videos.map((v) => ({
      id: v.id,
      title: v.title.length > 40 ? `${v.title.slice(0, 39)}…` : v.title,
      privacy: v.privacyStatus,
      upload: v.uploadStatus,
      file: v.fileName ?? "",
      published: v.publishedAt.slice(0, 10),
    })),
  );
}

async function cmdScan(args: string[]): Promise<void> {
  const dir = args[0] ?? INBOX_DIR;
  const files = await scanDirectory(dir);
  if (files.length === 0) {
    console.log(`No video files in ${dir}`);
    return;
  }
  console.table(
    files.map((f) => ({
      file: f.fileName,
      recorded: `${f.localDate} ${f.localTime}`,
      duration: formatDuration(f.durationSec),
      camera: f.camera,
      video: `${f.width}x${f.height} ${Math.round(f.fps)}fps ${f.isHdr ? "HDR" : "SDR"}`,
      sizeGb: (f.sizeBytes / 1024 ** 3).toFixed(1),
    })),
  );
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case "init":
      return cmdInit();
    case "auth":
      return cmdAuth();
    case "whoami":
      return printChannel();
    case "list":
      return cmdList(rest);
    case "scan":
      return cmdScan(rest);
    case "upload":
      return cmdUpload(rest);
    case "apply":
      return cmdApply(rest);
    case "thumb":
      return cmdThumb(rest);
    case "translate":
      return cmdTranslate(rest);
    case "tidy":
      return cmdTidy();
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return;
    default:
      console.error(`Unknown command: ${command}\n`);
      console.log(HELP);
      process.exitCode = 1;
  }
}

main()
  .catch((err: Error) => {
    console.error(`Error: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(closePrompts);
