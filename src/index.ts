#!/usr/bin/env node
/**
 * hobbes-mcp: a Model Context Protocol server for the Hobbes API.
 *
 * All 34 tools are generated from Hobbes's own published OpenAPI document
 * (https://api-us.hihobbes.com/api/v1/openapi.json, "Hobbes API" 1.0.0), so the
 * surface is their contract rather than my guess at it. Every mutating call
 * passes through src/policy.ts first.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { evaluate, sessionLimitFromEnv } from "./policy.js";
import { mcpError, categoryForStatus } from "./errors.js";

interface GenTool {
  name: string;
  method: string;
  path: string;
  summary: string;
  desc: string;
  tag: string;
  mutating: boolean;
  body: boolean;
  params: Array<{ name: string; in: string; required: boolean; desc: string }>;
}

const here = dirname(fileURLToPath(import.meta.url));
const SPEC: GenTool[] = JSON.parse(readFileSync(join(here, "tools.json"), "utf8"));

const BASE = (process.env.HOBBES_BASE_URL ?? "https://api-us.hihobbes.com").replace(/\/+$/, "");
const API_KEY = process.env.HOBBES_API_KEY;
const keyMode: "live" | "none" = API_KEY ? "live" : "none";
const sessionLimit = sessionLimitFromEnv();
let sessionMutations = 0;

function schemaFor(t: GenTool) {
  const props: Record<string, unknown> = {};
  const required: string[] = [];
  for (const p of t.params) {
    props[p.name] = { type: "string", description: p.desc || `${p.in} parameter` };
    if (p.required) required.push(p.name);
  }
  if (t.body) {
    props.body = {
      type: "object",
      description: "JSON request body, shaped by the Hobbes OpenAPI schema for this operation.",
    };
  }
  return { type: "object", properties: props, required, additionalProperties: false };
}

const server = new Server({ name: "hobbes-mcp", version: "0.1.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: SPEC.map((t) => ({
    name: t.name,
    description: `[${t.tag}] ${t.summary}${t.desc ? ` — ${t.desc}` : ""}${t.mutating ? " (mutating)" : ""}`,
    inputSchema: schemaFor(t),
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const t = SPEC.find((x) => x.name === req.params.name);
  if (!t) return mcpError("validation", `Unknown tool: ${req.params.name}`);
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;

  const decision = evaluate({
    tool: t.name,
    method: t.method,
    path: t.path,
    mutating: t.mutating,
    keyMode,
    sessionMutations,
    sessionLimit,
  });
  if (decision.verdict === "refuse")
    return mcpError("permission", `Refused by policy: ${decision.reason}`, { policy: "refuse" });
  if (decision.verdict === "escalate")
    return mcpError("permission", `Needs human approval: ${decision.prompt}`, {
      policy: "escalate",
      requiresHumanApproval: true,
    });

  // Build the URL: path params substituted, query params appended.
  let path = t.path;
  const query = new URLSearchParams();
  for (const p of t.params) {
    const v = args[p.name];
    if (v === undefined) continue;
    if (p.in === "path") path = path.replace(`{${p.name}}`, encodeURIComponent(String(v)));
    else if (p.in === "query") query.set(p.name, String(v));
  }
  const url = `${BASE}${path}${query.toString() ? `?${query}` : ""}`;

  const headers: Record<string, string> = { Accept: "application/json" };
  if (API_KEY) {
    headers["Authorization"] = `Bearer ${API_KEY}`;
    headers["x-api-key"] = API_KEY;
  }
  if (t.body && args.body !== undefined) headers["Content-Type"] = "application/json";

  const res = await fetch(url, {
    method: t.method,
    headers,
    body: t.body && args.body !== undefined ? JSON.stringify(args.body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });

  const text = await res.text();
  if (!res.ok) {
    const hint = res.status === 401 ? " Set HOBBES_API_KEY (an hb_live_ key)." : "";
    return mcpError(categoryForStatus(res.status), `Hobbes ${res.status}: ${text.slice(0, 400)}${hint}`, {
      httpStatus: res.status,
      operation: `${t.method} ${t.path}`,
    });
  }
  if (t.mutating) sessionMutations++;
  return { content: [{ type: "text", text: text || "(empty response)" }] };
});

await server.connect(new StdioServerTransport());
console.error(
  `hobbes-mcp ready. ${SPEC.length} tools from the published OpenAPI spec, key=${keyMode}, mutation limit=${sessionLimit}`,
);
