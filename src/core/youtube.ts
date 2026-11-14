import { readFile } from "node:fs/promises";
import { getAccessToken } from "./auth.js";

const API_BASE = "https://www.googleapis.com/youtube/v3";
const UPLOAD_BASE = "https://www.googleapis.com/upload/youtube/v3";
/** YouTube video category "Sports". */
export const CATEGORY_SPORTS = "17";
/** videos.list accepts at most 50 ids per call. */
const MAX_IDS_PER_CALL = 50;

export interface Channel {
  id: string;
  title: string;
  customUrl?: string;
  uploadsPlaylistId: string;
}

export interface VideoInfo {
  id: string;
  title: string;
  description: string;
  publishedAt: string;
  privacyStatus: string;
  uploadStatus: string;
  /** Original file name as uploaded; only visible to the channel owner. */
  fileName?: string;
  recordingDate?: string;
  duration?: string;
}

interface ApiErrorBody {
  error?: { code: number; message: string; errors?: { reason: string }[] };
}

/** Performs an authorized JSON request against the YouTube Data API. */
async function apiRequest<T>(
  method: "GET" | "POST" | "PUT",
  path: string,
  params: Record<string, string>,
  body?: unknown,
): Promise<T> {
  const url = new URL(`${API_BASE}/${path}`);
  url.search = new URLSearchParams(params).toString();
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${await getAccessToken()}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json()) as T & ApiErrorBody;
  if (!res.ok) {
    const reason = data.error?.errors?.[0]?.reason;
    throw new Error(`YouTube API ${res.status}${reason ? ` (${reason})` : ""}: ${data.error?.message}`);
  }
  return data;
}

function apiGet<T>(path: string, params: Record<string, string>): Promise<T> {
  return apiRequest<T>("GET", path, params);
}

/** Returns the channel the stored token is authorized for. */
export async function getMyChannel(): Promise<Channel> {
  const data = await apiGet<{
    items?: {
      id: string;
      snippet: { title: string; customUrl?: string };
      contentDetails: { relatedPlaylists: { uploads: string } };
    }[];
  }>("channels", { part: "snippet,contentDetails", mine: "true" });

  const item = data.items?.[0];
  if (!item) {
    throw new Error("The authorized account has no YouTube channel.");
  }
  return {
    id: item.id,
    title: item.snippet.title,
    customUrl: item.snippet.customUrl,
    uploadsPlaylistId: item.contentDetails.relatedPlaylists.uploads,
  };
}

/** Lists ids of the most recent videos in the channel's uploads playlist (1 quota unit). */
async function listUploadIds(uploadsPlaylistId: string, limit: number): Promise<string[]> {
  const data = await apiGet<{ items?: { contentDetails: { videoId: string } }[] }>("playlistItems", {
    part: "contentDetails",
    playlistId: uploadsPlaylistId,
    maxResults: String(Math.min(limit, MAX_IDS_PER_CALL)),
  });
  return (data.items ?? []).map((i) => i.contentDetails.videoId);
}

/**
 * Lists ids of the owner's videos via search (100 quota units, own daily bucket).
 * Fallback for videos that do not show up in the uploads playlist, e.g. Studio drafts.
 */
async function searchMyVideoIds(limit: number): Promise<string[]> {
  const data = await apiGet<{ items?: { id: { videoId: string } }[] }>("search", {
    part: "id",
    forMine: "true",
    type: "video",
    order: "date",
    maxResults: String(Math.min(limit, MAX_IDS_PER_CALL)),
  });
  return (data.items ?? []).map((i) => i.id.videoId);
}

/** Fetches details for the given video ids. */
export async function getVideos(ids: string[]): Promise<VideoInfo[]> {
  if (ids.length === 0) return [];
  const data = await apiGet<{
    items?: {
      id: string;
      snippet: { title: string; description: string; publishedAt: string };
      status: { privacyStatus: string; uploadStatus: string };
      fileDetails?: { fileName?: string };
      recordingDetails?: { recordingDate?: string };
      contentDetails?: { duration?: string };
    }[];
  }>("videos", {
    part: "snippet,status,fileDetails,recordingDetails,contentDetails",
    id: ids.slice(0, MAX_IDS_PER_CALL).join(","),
  });

  return (data.items ?? []).map((v) => ({
    id: v.id,
    title: v.snippet.title,
    description: v.snippet.description,
    publishedAt: v.snippet.publishedAt,
    privacyStatus: v.status.privacyStatus,
    uploadStatus: v.status.uploadStatus,
    fileName: v.fileDetails?.fileName,
    recordingDate: v.recordingDetails?.recordingDate,
    duration: v.contentDetails?.duration,
  }));
}

export type ListSource = "uploads" | "search";

/** Lists the most recent videos of the authorized channel, newest first. */
export async function listRecentVideos(source: ListSource, limit: number): Promise<VideoInfo[]> {
  const ids =
    source === "search"
      ? await searchMyVideoIds(limit)
      : await listUploadIds((await getMyChannel()).uploadsPlaylistId, limit);
  const videos = await getVideos(ids);
  return videos.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
}

export type PrivacyStatus = "private" | "unlisted" | "public";

export interface VideoUpdate {
  title: string;
  description: string;
  tags: string[];
  /** ISO 8601 moment the video was recorded. */
  recordingDate: string;
  privacyStatus: PrivacyStatus;
}

/** Overwrites the video's metadata and visibility (50 quota units). */
export async function updateVideo(videoId: string, update: VideoUpdate): Promise<void> {
  await apiRequest("PUT", "videos", { part: "snippet,status,recordingDetails" }, {
    id: videoId,
    snippet: {
      title: update.title,
      description: update.description,
      tags: update.tags,
      categoryId: CATEGORY_SPORTS,
      defaultLanguage: "en",
    },
    status: {
      privacyStatus: update.privacyStatus,
      selfDeclaredMadeForKids: false,
    },
    // The API accepts only the recording date here; the location can be set in YouTube Studio only.
    recordingDetails: { recordingDate: update.recordingDate },
  });
}

/** Changes only the video's visibility (50 quota units). */
export async function setPrivacyStatus(videoId: string, privacyStatus: PrivacyStatus): Promise<void> {
  await apiRequest("PUT", "videos", { part: "status" }, {
    id: videoId,
    status: { privacyStatus, selfDeclaredMadeForKids: false },
  });
}

/** Uploads a JPEG as the video's custom thumbnail (50 quota units). */
export async function setThumbnail(videoId: string, jpegPath: string): Promise<void> {
  const url = new URL(`${UPLOAD_BASE}/thumbnails/set`);
  url.search = new URLSearchParams({ videoId, uploadType: "media" }).toString();
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${await getAccessToken()}`,
      "Content-Type": "image/jpeg",
    },
    body: await readFile(jpegPath),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as ApiErrorBody;
    const reason = data.error?.errors?.[0]?.reason;
    throw new Error(
      `Thumbnail upload failed (${res.status}${reason ? `, ${reason}` : ""}): ${data.error?.message ?? res.statusText}`,
    );
  }
}

export interface Playlist {
  id: string;
  title: string;
}

export async function listPlaylists(): Promise<Playlist[]> {
  const data = await apiGet<{ items?: { id: string; snippet: { title: string } }[] }>("playlists", {
    part: "snippet",
    mine: "true",
    maxResults: "50",
  });
  return (data.items ?? []).map((p) => ({ id: p.id, title: p.snippet.title }));
}

/** Creates a public playlist (50 quota units). */
export async function createPlaylist(title: string): Promise<Playlist> {
  const data = await apiRequest<{ id: string }>("POST", "playlists", { part: "snippet,status" }, {
    snippet: { title, defaultLanguage: "en" },
    status: { privacyStatus: "public" },
  });
  return { id: data.id, title };
}

/** Adds the video to the playlist unless it is already there. */
export async function addToPlaylist(playlistId: string, videoId: string): Promise<void> {
  const existing = await apiGet<{ items?: unknown[] }>("playlistItems", {
    part: "id",
    playlistId,
    videoId,
  });
  if ((existing.items ?? []).length > 0) return;

  await apiRequest("POST", "playlistItems", { part: "snippet" }, {
    snippet: { playlistId, resourceId: { kind: "youtube#video", videoId } },
  });
}

function normalizeName(value: string): string {
  return value
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[_\s]+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * A video is still a raw Studio upload while its title is just the file name
 * (Studio replaces underscores with spaces).
 */
export function isUnprocessed(video: VideoInfo): boolean {
  return Boolean(video.fileName) && normalizeName(video.title) === normalizeName(video.fileName ?? "");
}
