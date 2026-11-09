# Research Desk (Cloudflare)

Front end (static files in `public/`) plus a Cloudflare Worker API (`src/`) implementing
Researcher → Analyst → Writer. Access is controlled with Cloudflare Access (email one-time PIN).

```
public/index.html  front end (Azure sign-in gate removed; Cloudflare Access handles login)
public/app.js      front end logic, still calls the same relative /api/* URLs
public/styles.css  unchanged
public/_headers    security headers (ported from staticwebapp.config.json)
src/index.ts       routes: /api/research, /api/analyze, /api/write, /api/health
src/pipeline.ts    the three agent steps (port of pipeline.py)
src/access.ts      verifies the Cloudflare Access JWT on every API call
wrangler.jsonc     Worker + static assets config
```

The Static Web Apps 45-second limit no longer applies (Workers limit CPU time, not time spent waiting
on model calls), but keeping the three-step flow is fine.

## Changes from the Azure version

- **Sign-in:** the Microsoft/GitHub sign-in screen and `/.auth/me` check are gone. The whole site is
  behind Cloudflare Access, so anyone who sees the page is signed in. The page reads the email from
  `/cdn-cgi/access/get-identity` for the header badge, and "Sign out" goes to `/cdn-cgi/access/logout`.
- **Expired sessions:** if the Access session expires mid-use, the page shows "Your session has expired.
  Please reload the page to sign in again." instead of a network error.
- **Headers:** `staticwebapp.config.json` is replaced by `public/_headers` (same CSP and headers).
  If you add a script or font from another origin, add it to the CSP there.
- **API:** `api/` (Python Azure Functions) is replaced by the Worker in `src/`. The `api/*` auth rule is
  replaced by Access plus the JWT check in `src/access.ts`.

## Migrate from the Azure repo

1. Create the new repo and copy in the files from this folder (nothing else is needed).
2. Do **not** bring over: `app/`, `api/`, `staticwebapp.config.json`, `host.json`,
   `local.settings.json`, `.github/workflows/azure-static-web-apps-*.yml`.

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars    # add TAVILY_API_KEY and OPENAI_API_KEY (or Azure settings)
npm run dev                       # http://localhost:8787
```

`ENFORCE_ACCESS=false` in `.dev.vars` skips the Access JWT check locally only.

## Deploy

```bash
npx wrangler login
npx wrangler secret put TAVILY_API_KEY
npx wrangler secret put OPENAI_API_KEY          # or AZURE_OPENAI_API_KEY if USE_AZURE=true
npm run deploy
```

Non-secret settings (`USE_AZURE`, model/deployment names, endpoint) are in `wrangler.jsonc` under `vars`.

You can also connect the GitHub repo in **Workers & Pages → your Worker → Settings → Builds** for
auto-deploys on push (deploy command: `npx wrangler deploy`). Secrets are set once and persist.

## Protect it with Cloudflare Access (email login)

1. **Zero Trust dashboard → Settings → Authentication → Login methods**: make sure
   **One-time PIN** is enabled (it is by default).
2. **Access → Applications → Add an application → Self-hosted.**
   - Destination: your Worker's hostname (custom domain or `research-desk.<account>.workers.dev`).
     Alternatively, in the Worker's **Settings → Domains & Routes**, use **Enable Cloudflare Access**
     on the workers.dev / preview URLs, which creates the application for you.
   - Policy: action **Allow**, include **Emails** (or **Emails ending in** `@yourcompany.com`).
3. Open the application and copy the **Application Audience (AUD) tag**. Your team domain is
   `<team-name>.cloudflareaccess.com` (Zero Trust → Settings → Custom pages / General).
4. Put both in `wrangler.jsonc`:
   ```jsonc
   "CF_ACCESS_TEAM_DOMAIN": "your-team.cloudflareaccess.com",
   "CF_ACCESS_AUD": "the-aud-tag"
   ```
   then `npm run deploy`.

Users visit the site, enter their email, receive a PIN, and get in. The Worker additionally validates
the signed `Cf-Access-Jwt-Assertion` header and returns 401 for any API call without it, so the API is
not reachable if Access is ever bypassed or misconfigured. If the Access variables are left as
placeholders, the Worker refuses requests (fail closed).

> Tip: if you use a custom domain, disable the workers.dev route (or put it behind Access too) so there
> is no unprotected URL.

## Behaviour notes

- The Agents SDK is replaced by direct Responses API calls (the same API the Python version used), with
  a function-calling loop capped at 3 Tavily searches and strict JSON-schema outputs. Prompts and limits
  are unchanged.
- Works with OpenAI or Azure OpenAI / Foundry (`USE_AZURE=true`, deployment names as model names).
