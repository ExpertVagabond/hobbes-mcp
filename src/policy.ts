/**
 * Policy layer for hobbes-mcp.
 *
 * Hobbes already built the right shape server-side. `POST /playbook/update-previews`
 * validates restricted JSON Patch ops against a clone of staging and returns a
 * deterministic before/after summary while never touching staging. Applying is a
 * separate call against a preview id that expires in 24 hours. And
 * `POST /agent/publish-jobs` demands an explicit `publish_to_production`
 * confirmation before anything reaches production.
 *
 * That is preview, then confirm, then act. This file is the client-side half of
 * the same idea, so the boundary holds even when an agent is composing the calls
 * rather than a human clicking through a UI.
 *
 * Of the 34 operations generated from their OpenAPI spec, 21 are read-only and
 * 13 mutate. The 13 are what this gate exists for.
 */

export type Decision =
  | { verdict: "allow" }
  | { verdict: "escalate"; prompt: string }
  | { verdict: "refuse"; reason: string };

export interface PolicyContext {
  /** MCP tool name, e.g. "hobbes_apply_playbook_update_preview". */
  tool: string;
  /** HTTP verb from the spec. GET is always safe. */
  method: string;
  /** Path template, e.g. "/api/v1/agent/publish-jobs". */
  path: string;
  /** True for POST/PATCH/PUT/DELETE. */
  mutating: boolean;
  /** `hb_live_` keys act on real customer data. */
  keyMode: "live" | "none";
  /** Mutating calls already made in this MCP session. */
  sessionMutations: number;
  /** Ceiling from HOBBES_SESSION_MUTATION_LIMIT. */
  sessionLimit: number;
}

/**
 * Operations that reach a customer's production agent or their prospects.
 * These are the ones where a mistake is visible outside the building.
 */
export const PRODUCTION_REACHING = new Set([
  "/api/v1/agent/publish-jobs",
  "/api/v1/playbook/update-previews/{preview_id}/apply",
  "/api/v1/playbook/suggestions/{group_id}/apply",
  "/api/v1/custom-links/actions",
  "/api/v1/custom-link-campaigns/{campaign_id}",
]);

/**
 * Deliberately safe to call unattended: it is Hobbes's own dry run. The spec is
 * explicit that it never changes staging, which makes it the one mutating verb
 * an agent should be free to use for exploration.
 */
export const DRY_RUN = "/api/v1/playbook/update-previews";

export function evaluate(ctx: PolicyContext): Decision {
  if (!ctx.mutating) return { verdict: "allow" };

  // Hobbes's own preview endpoint cannot mutate staging. Let the agent explore.
  if (ctx.path === DRY_RUN) return { verdict: "allow" };

  if (ctx.keyMode === "none") {
    return { verdict: "refuse", reason: "no HOBBES_API_KEY set, refusing to attempt a write" };
  }

  if (ctx.sessionMutations >= ctx.sessionLimit) {
    return {
      verdict: "refuse",
      reason: `session mutation limit reached (${ctx.sessionLimit}); restart with a higher HOBBES_SESSION_MUTATION_LIMIT if this is intended`,
    };
  }

  if (ctx.path === "/api/v1/agent/publish-jobs") {
    return {
      verdict: "escalate",
      prompt:
        "This publishes the current staging version to a customer's production agent. Hobbes runs its conversation-test gate, but the blast radius is a live sales conversation. Confirm explicitly.",
    };
  }

  if (PRODUCTION_REACHING.has(ctx.path)) {
    return {
      verdict: "escalate",
      prompt: `${ctx.method} ${ctx.path} changes what prospects see. Preview first where the API offers one, then confirm.`,
    };
  }

  return { verdict: "allow" };
}

export function sessionLimitFromEnv(): number {
  const n = Number(process.env.HOBBES_SESSION_MUTATION_LIMIT);
  return Number.isFinite(n) && n >= 0 ? n : 10;
}
