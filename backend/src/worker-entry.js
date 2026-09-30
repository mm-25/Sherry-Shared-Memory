import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { appHandler } from "./index.js";
import { mcpHandler } from "./mcp.js";
import { createDefaultHandler } from "./oauth.js";

const oauthProvider = new OAuthProvider({
  apiRoute: "/mcp", apiHandler: mcpHandler, defaultHandler: createDefaultHandler(appHandler),
  authorizeEndpoint: "/authorize", tokenEndpoint: "/oauth/token", clientRegistrationEndpoint: "/oauth/register",
  scopesSupported: ["memory:read", "memory:write"],
  resourceMetadata: {
    resource: "https://shared-memory-ingestion.mufaddal-m25.workers.dev/mcp",
    authorization_servers: ["https://shared-memory-ingestion.mufaddal-m25.workers.dev"],
    scopes_supported: ["memory:read", "memory:write"], resource_name: "Shared Memory"
  }
});

export default {
  fetch(request, env, ctx) { return oauthProvider.fetch(request, env, ctx); },
  scheduled: appHandler.scheduled
};
