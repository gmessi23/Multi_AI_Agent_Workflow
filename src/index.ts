/**
 * Research Desk API on Cloudflare Workers.
 *
 *   POST /api/research  {query}                                  -> {research_summary}
 *   POST /api/analyze   {research_summary}                       -> {analysis_summary}
 *   POST /api/write     {query, research_summary, analysis_summary, french}
 *                                                                -> {short_summary, markdown_report, follow_up_questions}
 *   GET  /api/health                                             -> {status}
 *
 * Static files in ./public are served by the assets binding; only /api/* reaches this Worker.
 * The whole site (assets + API) should sit behind a Cloudflare Access application.
 */

import { verifyAccess } from "./access";
import { runAnalysis, runResearch, runWriter } from "./pipeline";
import { ConfigError, type Env } from "./types";

const MAX_QUERY = 500;
const MAX_NOTES = 8000;

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

const error = (message: string, status = 400) => json({ error: message }, status);

async function body(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const data = await request.json();
    return data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function text(data: Record<string, unknown>, key: string, limit: number): string | null {
  const value = data[key];
  if (typeof value !== "string" || !value.trim()) return null;
  return value.trim().slice(0, limit);
}

function failure(step: string, err: unknown): Response {
  console.error(`Step '${step}' failed`, err);
  if (err instanceof ConfigError) return error(err.message, 500);
  return error(`The ${step} step failed. Please try again in a moment.`, 500);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (!pathname.startsWith("/api/")) return env.ASSETS.fetch(request);

    if (pathname === "/api/health" && request.method === "GET") return json({ status: "ok" });

    // Every other API route requires a valid Cloudflare Access identity.
    const email = await verifyAccess(request, env);
    if (!email) return error("Unauthorized.", 401);

    if (request.method !== "POST") return error("Method not allowed.", 405);
    const data = (await body(request)) ?? {};

    switch (pathname) {
      case "/api/research": {
        const query = text(data, "query", MAX_QUERY);
        if (!query) return error("Please enter a research question.");
        try {
          return json({ research_summary: await runResearch(env, query) });
        } catch (err) {
          return failure("research", err);
        }
      }

      case "/api/analyze": {
        const notes = text(data, "research_summary", MAX_NOTES);
        if (!notes) return error("Missing research notes.");
        try {
          return json({ analysis_summary: await runAnalysis(env, notes) });
        } catch (err) {
          return failure("analysis", err);
        }
      }

      case "/api/write": {
        const query = text(data, "query", MAX_QUERY);
        const research = text(data, "research_summary", MAX_NOTES);
        const analysis = text(data, "analysis_summary", MAX_NOTES);
        if (!(query && research && analysis)) return error("Missing query, research notes or analysis.");
        try {
          return json(await runWriter(env, query, research, analysis, Boolean(data.french)));
        } catch (err) {
          return failure("writing", err);
        }
      }

      default:
        return error("Not found.", 404);
    }
  },
} satisfies ExportedHandler<Env>;
