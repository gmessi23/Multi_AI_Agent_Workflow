/**
 * Defense-in-depth for Cloudflare Access.
 *
 * Access already blocks unauthenticated users at the edge, but the Worker also
 * verifies the signed JWT in `Cf-Access-Jwt-Assertion`, so the API stays
 * protected even if the Access policy is misconfigured or the route is exposed
 * some other way (e.g. a workers.dev URL without Access enabled).
 */

import type { Env } from "./types";

interface Jwk extends JsonWebKey {
  kid: string;
}

let cachedKeys: { keys: Jwk[]; fetchedAt: number } | null = null;
const KEY_TTL_MS = 60 * 60 * 1000;

function b64urlToBytes(input: string): Uint8Array {
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(input.length / 4) * 4, "=");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function decodeJson<T>(part: string): T {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(part))) as T;
}

async function getKeys(teamDomain: string, force = false): Promise<Jwk[]> {
  if (!force && cachedKeys && Date.now() - cachedKeys.fetchedAt < KEY_TTL_MS) return cachedKeys.keys;
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Could not fetch Access signing keys (${res.status})`);
  const body = (await res.json()) as { keys: Jwk[] };
  cachedKeys = { keys: body.keys, fetchedAt: Date.now() };
  return body.keys;
}

/** Returns the authenticated email, or null if the request is not authorised. */
export async function verifyAccess(request: Request, env: Env): Promise<string | null> {
  if ((env.ENFORCE_ACCESS ?? "true").toLowerCase() === "false") return "local-dev";

  const teamDomain = (env.CF_ACCESS_TEAM_DOMAIN ?? "").trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
  const aud = (env.CF_ACCESS_AUD ?? "").trim();
  if (!teamDomain || !aud || teamDomain.startsWith("your-") || aud.startsWith("your-")) {
    console.error("CF_ACCESS_TEAM_DOMAIN / CF_ACCESS_AUD are not configured; refusing request.");
    return null;
  }

  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  try {
    const header = decodeJson<{ kid?: string; alg?: string }>(parts[0]);
    const payload = decodeJson<{ aud?: string[] | string; iss?: string; exp?: number; nbf?: number; email?: string }>(parts[1]);
    if (header.alg !== "RS256" || !header.kid) return null;

    let keys = await getKeys(teamDomain);
    let jwk = keys.find((k) => k.kid === header.kid);
    if (!jwk) {
      keys = await getKeys(teamDomain, true); // keys rotate
      jwk = keys.find((k) => k.kid === header.kid);
    }
    if (!jwk) return null;

    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      b64urlToBytes(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
    if (!valid) return null;

    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp !== "number" || payload.exp < now) return null;
    if (typeof payload.nbf === "number" && payload.nbf > now + 60) return null;
    if (payload.iss !== `https://${teamDomain}`) return null;
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!audiences.includes(aud)) return null;

    return payload.email ?? "unknown";
  } catch (err) {
    console.error("Access JWT verification failed", err);
    return null;
  }
}
