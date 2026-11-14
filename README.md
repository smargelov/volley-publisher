# volley-publisher

A command-line tool (with an optional Raycast extension) that uploads volleyball videos
to your YouTube channel and fills in their titles, descriptions, thumbnails and playlists.

It runs entirely on your own Mac. You sign in with your own Google account, through your
own Google Cloud project, and the tool manages only your own channel. There is no server
and no shared service.

## What it does

1. **Upload** — sends a source video file from a local folder to the channel as a
   private video, using the resumable upload protocol.
2. **Describe** — asks a few questions (event type, venue, teams, stage, score), builds
   an English title, description and tags, and sets the recording date. Venues, event
   types and player name spellings are remembered for the next video.
3. **Thumbnail** — extracts a still frame from the local file, lets you crop it in a
   local browser page, adds your channel graphics and sets it as the custom thumbnail.
4. **Playlist** — adds the video to an existing playlist or creates a new one.
5. **Tidy** — moves the local source files of finished videos to an archive folder.

Every change on YouTube is shown first and written only after an explicit confirmation.

## Requirements

- macOS, Node.js 22 or newer
- `ffmpeg` / `ffprobe` in `PATH` (reading file metadata, extracting frames)
- Your own Google Cloud project (see below)

## Setup

### 1. Google Cloud project

The tool does not ship with API credentials; each user brings their own.

1. Create a project in [Google Cloud Console](https://console.cloud.google.com/).
2. Enable **YouTube Data API v3** for it.
3. Configure the OAuth consent screen and add your Google account as a test user.
4. Create an OAuth client of type **Desktop app** and download its JSON file.
5. Save the file as `~/.config/volley-publisher/client_secret.json`.

Two things to know:

- While the OAuth app is in "Testing" status, the refresh token expires after 7 days;
  run `auth` again when that happens.
- Videos uploaded through the API by a project that has not passed
  [YouTube's API compliance audit](https://support.google.com/youtube/contact/yt_api_form)
  stay locked as private. Until your project passes it, upload through YouTube Studio
  and use this tool for everything else — that part works without the audit.

### 2. The tool

```sh
npm install
npm run volley -- init    # channel name, logo, colors, folders
npm run volley -- auth    # opens the browser; pick your channel
```

Optional: put an [OpenRouter](https://openrouter.ai) API key into
`~/.config/volley-publisher/openrouter.key` to have stage names and notes typed in
another language translated into English.

## Settings

`init` writes `~/.config/volley-publisher/config.json`. Every field is optional.

| Field | Meaning | Default |
| --- | --- | --- |
| `channelTitle` | Your channel's title; `whoami` warns when another channel is authorized | none |
| `brandText` | Text next to the logo on thumbnails | `channelTitle` in upper case |
| `logoPath` | Square PNG logo for thumbnails, absolute or relative to the config folder | bundled volleyball |
| `accentColor` | Thumbnail accent color, `#RRGGBB` | `#FF7A45` |
| `backgroundColor` | Dark color for text on the accent color, `#RRGGBB` | `#1B1F2A` |
| `timeZone` | IANA time zone the videos are shot in | system time zone |
| `mediaDir` | Folder with the `inbox`, `done` and `thumbs` subfolders | `~/Movies/Volley` |
| `translateModel` | OpenRouter model for translations | `anthropic/claude-haiku-5.5` |

## Commands

Run as `npm run volley -- <command>`.

| Command | What it does |
| --- | --- |
| `init` | Set up the channel name, logo, colors and folders |
| `auth` | Authorize access to the channel (opens the browser) |
| `whoami` | Show the authorized channel |
| `scan [dir]` | Show local source videos and their metadata |
| `upload [file] [--yes]` | Upload a source video as private; without a file, pick one from the inbox |
| `list [--source uploads\|search] [--limit n]` | List recent videos with their statuses |
| `apply [videoId] [--privacy private\|unlisted\|public]` | Fill in title, description, thumbnail and playlist |
| `thumb <file> [m:ss]` | Make a thumbnail only |
| `translate <text>` | Translate a text to English (checks the OpenRouter key) |
| `tidy` | Move source files of finished videos from `inbox` to `done` |

### Typical flow

```sh
npm run volley -- upload            # pick a file from the inbox and upload it
npm run volley -- apply <videoId>   # title, description, thumbnail, playlist
npm run volley -- tidy              # archive the source file once YouTube has processed it
```

An interrupted upload continues from the last stored byte when `upload` is run again for
the same file. Failed chunks are retried with exponential backoff.

The `raycast/` folder holds a Raycast extension with the same workflow on top of the
same core.

## How it uses the YouTube Data API

| API method | Why |
| --- | --- |
| `channels.list` (mine) | Show which channel the tool is authorized for |
| `playlistItems.list`, `search.list` (forMine) | Find your recent uploads |
| `videos.list` | Read title, status and file name of your videos |
| `videos.insert` | Upload a video file (resumable upload) |
| `videos.update` | Set title, description, tags, category, recording date and visibility |
| `thumbnails.set` | Set the custom thumbnail |
| `playlists.list`, `playlists.insert` | Offer existing playlists or create a new one |
| `playlistItems.list`, `playlistItems.insert` | Add the video to a playlist once |

The tool requests a single OAuth scope, `https://www.googleapis.com/auth/youtube`, and
reads or changes only the authorized user's own channel. It does not read comments,
analytics, subscriptions or any data of other channels and users.

## Where data lives

Everything stays on your computer:

| Path | Content |
| --- | --- |
| `<mediaDir>/inbox`, `done`, `thumbs` | Source videos, archived videos, frames and thumbnails |
| `~/.config/volley-publisher/config.json` | Settings |
| `~/.config/volley-publisher/client_secret.json` | OAuth client file |
| `~/.config/volley-publisher/token.json` | OAuth tokens (file mode 600) |
| `~/.config/volley-publisher/store.json` | Remembered venues, event types, player name spellings, playlists and answers per video |
| `~/.config/volley-publisher/upload-sessions.json` | Unfinished upload sessions |

See [PRIVACY.md](PRIVACY.md) for the privacy policy.

## Notes

- The API does not accept a recording location, so the venue is written in the title and
  description as text.
- Custom thumbnails need a phone-verified channel.

## License

[MIT](LICENSE). The bundled Inter typeface is licensed under the SIL Open Font License
(`assets/fonts/LICENSE-Inter.txt`).

## Terms

This tool uses YouTube API Services. By using it you agree to be bound by the
[YouTube Terms of Service](https://www.youtube.com/t/terms).
