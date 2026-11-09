export interface Env {
  ASSETS: Fetcher;

  // secrets
  TAVILY_API_KEY?: string;
  OPENAI_API_KEY?: string;
  AZURE_OPENAI_API_KEY?: string;

  // vars
  USE_AZURE?: string;
  AZURE_OPENAI_ENDPOINT?: string;
  AZURE_RESEARCHER_DEPLOYMENT?: string;
  AZURE_ANALYST_DEPLOYMENT?: string;
  AZURE_WRITER_DEPLOYMENT?: string;
  RESEARCHER_MODEL?: string;
  ANALYST_MODEL?: string;
  WRITER_MODEL?: string;

  ENFORCE_ACCESS?: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
}

/** Configuration problems: safe to show to the caller (no secrets in them). */
export class ConfigError extends Error {}
