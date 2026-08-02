import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getStoredServiceTier, saveServiceTier } from "./settings.js";

export const SERVICE_TIERS = [
  "auto",
  "default",
  "flex",
  "priority",
  "standard_only",
] as const;

export type ServiceTier = (typeof SERVICE_TIERS)[number];

const SERVICE_TIER_SET = new Set<string>(SERVICE_TIERS);
const OPENAI_SERVICE_TIERS = new Set<ServiceTier>(["auto", "default", "flex", "priority"]);
const ANTHROPIC_SERVICE_TIERS = new Set<ServiceTier>(["auto", "standard_only"]);

export function normalizeServiceTier(value: string | undefined): ServiceTier | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  return SERVICE_TIER_SET.has(normalized) ? (normalized as ServiceTier) : undefined;
}

/** Resolve the active service tier: env > stored config > undefined. */
export function resolveActiveServiceTier(): ServiceTier | undefined {
  return (
    normalizeServiceTier(process.env.DSCODE_SERVICE_TIER) ??
    normalizeServiceTier(getStoredServiceTier())
  );
}

/** Filter a tier to what the given provider actually supports. */
export function resolveProviderServiceTier(
  provider: string | undefined,
  tier: ServiceTier | undefined,
): ServiceTier | undefined {
  if (!provider || !tier) return undefined;
  if ((provider === "openai" || provider === "openai-codex") && OPENAI_SERVICE_TIERS.has(tier)) {
    return tier;
  }
  if (provider === "anthropic" && ANTHROPIC_SERVICE_TIERS.has(tier)) {
    return tier;
  }
  return undefined;
}

export function registerServiceTierControls(pi: ExtensionAPI): void {
  pi.on("before_provider_request", (event, ctx) => {
    if (!ctx.model || !event.payload || typeof event.payload !== "object") {
      return;
    }

    const activeTier = resolveActiveServiceTier();
    const providerTier = resolveProviderServiceTier(ctx.model.provider, activeTier);
    if (!providerTier) {
      return;
    }

    return {
      ...(event.payload as Record<string, unknown>),
      service_tier: providerTier,
    };
  });

  pi.registerCommand("service-tier", {
    description: "View or set the provider service tier (auto|default|flex|priority|standard_only|unset)",
    handler: async (args, ctx) => {
      const trimmed = args.trim();

      if (!trimmed) {
        const current = resolveActiveServiceTier();
        if (!ctx.hasUI) {
          ctx.ui.notify(current ?? "not set", "info");
          return;
        }
        const selected = await ctx.ui.select(
          "Select service tier",
          [
            current ? `unset (current: ${current})` : "unset (current)",
            ...SERVICE_TIERS.map((tier) => (tier === current ? `${tier} (current)` : tier)),
          ],
        );
        if (!selected) return;
        if (selected.startsWith("unset")) {
          await saveServiceTier(undefined);
          ctx.ui.notify("Cleared service tier override.", "info");
          return;
        }
        const tier = normalizeServiceTier(selected);
        if (tier) {
          await saveServiceTier(tier);
          ctx.ui.notify(`Service tier set to ${tier}.`, "info");
        }
        return;
      }

      if (trimmed === "unset" || trimmed === "clear" || trimmed === "off") {
        await saveServiceTier(undefined);
        ctx.ui.notify("Cleared service tier override.", "info");
        return;
      }

      const tier = normalizeServiceTier(trimmed);
      if (!tier) {
        ctx.ui.notify(
          "Use auto, default, flex, priority, standard_only, or unset.",
          "warning",
        );
        return;
      }

      await saveServiceTier(tier);
      ctx.ui.notify(`Service tier set to ${tier}.`, "info");
    },
  });
}
