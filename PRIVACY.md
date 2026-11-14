# Privacy Policy

_Last updated: November 15, 2026_

`volley-publisher` ("the tool") is an open-source program that a YouTube channel owner
("the user") runs on their own computer to upload videos to their own channel and to fill
in their details. Each user connects it to their own Google Cloud project and their own
Google account. The tool has no server and no user accounts, and its author receives no
data from anyone who runs it.

The tool uses YouTube API Services. By using it, the user agrees to be bound by the
[YouTube Terms of Service](https://www.youtube.com/t/terms). Google's handling of data is
described in the [Google Privacy Policy](https://policies.google.com/privacy).

## What data the tool accesses

After the user signs in with Google and grants the `https://www.googleapis.com/auth/youtube`
scope, the tool accesses only the authorized user's own channel through the YouTube Data
API:

- the channel's id, title and handle;
- the list of the channel's own videos with their titles, descriptions, statuses,
  original file names, recording dates and durations;
- the channel's own playlists.

The tool uses this access to upload video files chosen by the user, to set titles,
descriptions, tags, recording dates, visibility and thumbnails of the user's videos, and to
create playlists and add the user's videos to them.

The tool does not access comments, analytics, subscriptions, or any data about other
YouTube users or channels.

## What data the tool stores

All data is stored only in local files on the user's computer:

- OAuth access and refresh tokens (`~/.config/volley-publisher/token.json`,
  readable by the user account only);
- ids and titles of the user's own videos and playlists, together with the answers the
  user typed for them (`store.json`);
- the user's settings: channel title, logo path, colors, folders (`config.json`);
- addresses of unfinished upload sessions (`upload-sessions.json`).

Nothing is copied to any server operated by the author, because there is none.

## Sharing with third parties

The tool does not sell, share or transfer YouTube API data to anyone.

If the user has configured an OpenRouter API key, short texts that the user typed in the
terminal (a tournament stage, free-form notes, and the user's own list of player name
spellings) are sent to [OpenRouter](https://openrouter.ai/privacy) to be translated into
English. This text comes from the user's keyboard, not from YouTube; no data obtained
through YouTube API Services is sent there. Without the key this feature is off.

The tool has no analytics, no telemetry, no advertising, and it sets no cookies.

## Retention and deletion

Data stays on the computer until the user deletes it. To remove everything the tool
stores, delete the folder `~/.config/volley-publisher`.

To revoke the tool's access to the YouTube account, open the
[Google security settings](https://security.google.com/settings/security/permissions) and
remove the app's access. After revocation the stored tokens stop working.

## Changes

Changes to this policy are published in this file with a new "Last updated" date.

## Contact

Questions about this policy: [github.com/smargelov](https://github.com/smargelov).
