import { buildingRulesOf, type BuildingRules } from "@enterprise-brain/core";
import type { Viewer } from "./viewer.ts";

/**
 * The rules for building, applied to a person: who may make tables, apps and calculations for a
 * department, and who may change what was made (its department's managers and IT's builders, or
 * whoever made it, while they may build).
 */

export function rulesOf(company: { settings: Record<string, unknown> }): BuildingRules {
  return buildingRulesOf(company.settings ?? {});
}

export function canBuildFor(viewer: Viewer, departmentId: string | null | undefined, rules: BuildingRules): boolean {
  if (viewer.isAdmin) return true;
  // Company-wide things are IT's.
  if (!departmentId) return false;
  const membership = viewer.departments.find((d) => d.departmentId === departmentId);
  if (!membership) return false;
  if (viewer.userId && rules.builders.includes(viewer.userId)) return true;
  if (rules.who === "everyone") return true;
  return rules.who === "managers" && membership.role === "manager";
}

/** The departments a person builds for. */
export function buildsFor(viewer: Viewer, rules: BuildingRules, departments: { id: string }[]): string[] {
  return departments.filter((d) => canBuildFor(viewer, d.id, rules)).map((d) => d.id);
}

export function canChangeBuilt(viewer: Viewer, item: { departmentId: string | null; createdBy: string }, rules: BuildingRules): boolean {
  if (viewer.isAdmin) return true;
  if (!canBuildFor(viewer, item.departmentId, rules)) return false;
  const manager = viewer.departments.some((d) => d.departmentId === item.departmentId && d.role === "manager");
  const builder = Boolean(viewer.userId && rules.builders.includes(viewer.userId));
  // Whoever made it ("Zeynep Kaya", or as kept: "Zeynep Kaya <zeynep.kaya@…>").
  const owner = item.createdBy.replace(/\s*<[^>]*>$/, "") === viewer.name;
  return manager || builder || owner;
}

/** Who decides on personal data: the data protection officer, or IT when none is named. */
export function decidesPersonalData(viewer: Viewer, rules: BuildingRules): boolean {
  return rules.dpo ? viewer.userId === rules.dpo : viewer.isAdmin;
}
