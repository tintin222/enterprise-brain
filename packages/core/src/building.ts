import { z } from "zod";

/** Who makes tables, apps and calculations for a department. */
export const BUILDERS = ["managers", "everyone", "it"] as const;
export type Builders = (typeof BUILDERS)[number];

export const BUILDERS_LABELS: Record<Builders, string> = {
  managers: "Managers, for their departments",
  everyone: "Everyone, for their own department",
  it: "Only IT",
};

/**
 * The rules for building, which IT sets: who may build, whom IT lets build besides, and the data
 * protection officer, who decides on tables that keep personal data (IT, when none is named).
 * Sharing anything beyond its department always waits for IT.
 */
export const BuildingRules = z.object({
  who: z.enum(BUILDERS).default("managers"),
  /** People IT lets build for their own departments, whatever `who` says (user ids). */
  builders: z.array(z.string()).default([]),
  /** The data protection officer (a user id); null: IT decides. */
  dpo: z.string().nullable().default(null),
});
export type BuildingRules = z.infer<typeof BuildingRules>;

/** The company's rules for building, from its settings (the defaults when none are set). */
export function buildingRulesOf(settings: Record<string, unknown>): BuildingRules {
  const parsed = BuildingRules.safeParse(settings.building ?? {});
  return parsed.success ? parsed.data : BuildingRules.parse({});
}
