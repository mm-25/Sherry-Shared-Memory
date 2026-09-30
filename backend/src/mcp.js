import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import { z } from "zod";
import { getSource, listConnections, listProjects, saveNote, searchMemory } from "./retrieval.js";

function text(value) { return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], structuredContent: value }; }
function identity() {
  const props = getMcpAuthContext()?.props || {};
  if (!props.userId || !props.workspaceId) throw new Error("The authenticated memory identity is incomplete.");
  return props;
}

function createServer(env) {
  const server = new McpServer({ name: "Shared Memory", version: "1.0.0" });
  server.registerTool("memory.search", {
    description: "Search the user's shared memory. Returns source-backed excerpts, explicit notes, and conversation summaries. Use before answering when prior user context may matter.",
    inputSchema: { query: z.string().min(1).max(500), limit: z.number().int().min(1).max(30).optional(), maxCharacters: z.number().int().min(1000).max(20000).optional() }
  }, async ({ query, limit, maxCharacters }) => text(await searchMemory({ ...identity(), query, limit, maxCharacters, toolName: "memory.search" }, env)));
  server.registerTool("memory.get_context", {
    description: "Build a compact context packet for a task from the user's shared memory, with source provenance.",
    inputSchema: { task: z.string().min(1).max(500), maxCharacters: z.number().int().min(1000).max(20000).optional() }
  }, async ({ task, maxCharacters }) => text(await searchMemory({ ...identity(), query: task, maxCharacters, toolName: "memory.get_context" }, env)));
  server.registerTool("memory.get_source", {
    description: "Inspect one source returned by memory.search. Use when exact wording or provenance matters.",
    inputSchema: { type: z.enum(["excerpt", "summary", "note"]), id: z.string().min(1).max(100) }
  }, async ({ type, id }) => text({ source: await getSource({ ...identity(), type, id }, env) }));
  server.registerTool("memory.list_projects", { description: "List memory scopes/projects available to this user." }, async () => text({ projects: await listProjects(identity(), env) }));
  server.registerTool("memory.get_permissions", { description: "Show which AI providers can read memory or save explicit notes." }, async () => text({ connections: await listConnections(identity(), env) }));
  server.registerTool("memory.save_note", {
    description: "Save a note only when the user explicitly asks to remember or save something. This never runs implicitly.",
    inputSchema: { title: z.string().min(1).max(200), content: z.string().min(1).max(30000), tags: z.array(z.string().max(60)).max(20).optional(), projectId: z.string().uuid().optional() }
  }, async ({ title, content, tags, projectId }) => text({ note: await saveNote({ ...identity(), title, content, tags, projectId }, env) }));
  return server;
}

export const mcpHandler = {
  fetch(request, env, ctx) {
    return createMcpHandler(() => createServer(env), { route: "/mcp", legacy: "stateless" })(request, env, ctx);
  }
};
