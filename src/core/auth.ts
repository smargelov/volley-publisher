import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname } from "node:path";
import { CONFIG_DIR, SCOPES, TOKEN_PATH, resolveClientSecretPath } from "./config.js";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
/** Refresh the access token slightly before it actually expires. */
const EXPIRY_SKEW_MS = 60_000;
const LOGIN_TIMEOUT_MS = 5 * 60_000;

interface OAuthClient {
  clientId: string;
  clientSecret: string;
}

export interface StoredToken {
  accessToken: string;
  refreshToken: string;
  /** Unix epoch in milliseconds. */
  expiresAt: number;
  scope: string;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
}

async function loadClient(): Promise<OAuthClient> {
  const raw = JSON.parse(await readFile(resolveClientSecretPath(), "utf8")) as {
    installed?: { client_id?: string; client_secret?: string };
  };
  const installed = raw.installed;
  if (!installed?.client_id || !installed.client_secret) {
    throw new Error('client_secret.json must be an OAuth client of type "Desktop app".');
  }
  return { clientId: installed.client_id, clientSecret: installed.client_secret };
}

async function requestToken(params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const body = (await res.json()) as TokenResponse & { error?: string; error_description?: string };
  if (!res.ok) {
    throw new Error(`Token request failed: ${body.error ?? res.status} ${body.error_description ?? ""}`);
  }
  return body;
}

async function saveToken(token: StoredToken): Promise<void> {
  await mkdir(dirname(TOKEN_PATH), { recursive: true, mode: 0o700 });
  await writeFile(TOKEN_PATH, JSON.stringify(token, null, 2), { mode: 0o600 });
}

async function loadToken(): Promise<StoredToken | null> {
  try {
    return JSON.parse(await readFile(TOKEN_PATH, "utf8")) as StoredToken;
  } catch {
    return null;
  }
}

/** Waits for Google to redirect the browser back to the local loopback server. */
function waitForAuthCode(expectedState: string): Promise<{ code: Promise<string>; redirectUri: string }> {
  return new Promise((resolveServer) => {
    let resolveCode!: (code: string) => void;
    let rejectCode!: (err: Error) => void;
    const code = new Promise<string>((res, rej) => {
      resolveCode = res;
      rejectCode = rej;
    });

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/") {
        res.writeHead(404).end();
        return;
      }
      const error = url.searchParams.get("error");
      const returnedCode = url.searchParams.get("code");
      const stateOk = url.searchParams.get("state") === expectedState;
      const ok = !error && returnedCode && stateOk;

      res.writeHead(ok ? 200 : 400, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        ok
          ? "<h2>Authorized. You can close this tab.</h2>"
          : `<h2>Authorization failed: ${error ?? (stateOk ? "no code" : "state mismatch")}</h2>`,
      );
      server.close();
      clearTimeout(timer);
      if (ok) resolveCode(returnedCode);
      else rejectCode(new Error(`Authorization failed: ${error ?? "invalid response"}`));
    });

    const timer = setTimeout(() => {
      server.close();
      rejectCode(new Error("Timed out waiting for authorization."));
    }, LOGIN_TIMEOUT_MS);

    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolveServer({ code, redirectUri: `http://127.0.0.1:${port}` });
    });
  });
}

/**
 * Runs the interactive OAuth flow (loopback redirect + PKCE) and stores the tokens.
 * The user picks the YouTube channel on Google's consent page.
 */
export async function login(onUrl: (url: string) => void = () => {}): Promise<StoredToken> {
  const client = await loadClient();
  const state = randomBytes(16).toString("hex");
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");

  const { code, redirectUri } = await waitForAuthCode(state);

  const authUrl = new URL(AUTH_ENDPOINT);
  authUrl.search = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    // Force the consent screen so Google always returns a refresh token.
    prompt: "consent",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();

  onUrl(authUrl.toString());
  if (process.platform === "darwin") {
    execFile("open", [authUrl.toString()], () => {});
  }

  const response = await requestToken({
    grant_type: "authorization_code",
    code: await code,
    client_id: client.clientId,
    client_secret: client.clientSecret,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
  if (!response.refresh_token) {
    throw new Error("Google did not return a refresh token. Revoke the app access and try again.");
  }

  const token: StoredToken = {
    accessToken: response.access_token,
    refreshToken: response.refresh_token,
    expiresAt: Date.now() + response.expires_in * 1000,
    scope: response.scope,
  };
  await saveToken(token);
  return token;
}

/** Returns a valid access token, refreshing it when needed. */
export async function getAccessToken(): Promise<string> {
  const token = await loadToken();
  if (!token) {
    throw new Error(`Not authorized yet (no token in ${CONFIG_DIR}). Run: npm run volley -- auth`);
  }
  if (token.expiresAt - EXPIRY_SKEW_MS > Date.now()) {
    return token.accessToken;
  }

  const client = await loadClient();
  let response: TokenResponse;
  try {
    response = await requestToken({
      grant_type: "refresh_token",
      refresh_token: token.refreshToken,
      client_id: client.clientId,
      client_secret: client.clientSecret,
    });
  } catch (err) {
    // In "Testing" publishing status refresh tokens expire after 7 days.
    throw new Error(`${(err as Error).message}\nRe-authorize with: npm run volley -- auth`);
  }

  const refreshed: StoredToken = {
    ...token,
    accessToken: response.access_token,
    expiresAt: Date.now() + response.expires_in * 1000,
  };
  await saveToken(refreshed);
  return refreshed.accessToken;
}
