import { AppWindow, BookOpen, Bot, Brain, Calculator, FileText, Plug, Table2, type LucideIcon } from "lucide-react";
import type { Tone } from "../../components/Badge.tsx";
import { paths } from "../../lib/paths.ts";
import type { ProjectAsset, ProjectAssetKind, ProjectStatus } from "../../types.ts";

export const PROJECT_STATUSES: ProjectStatus[] = ["planned", "active", "on_hold", "done", "cancelled"];

export const STATUS_LABELS: Record<ProjectStatus, string> = {
  planned: "Planned",
  active: "Active",
  on_hold: "On hold",
  done: "Done",
  cancelled: "Cancelled",
};

export const STATUS_TONES: Record<ProjectStatus, Tone> = {
  planned: "blue",
  active: "green",
  on_hold: "amber",
  done: "neutral",
  cancelled: "red",
};

export const ASSET_KINDS: ProjectAssetKind[] = ["thing", "table", "app", "calculation", "document", "file", "connection", "agent"];

export const ASSET_LABELS: Record<ProjectAssetKind, [singular: string, plural: string]> = {
  thing: ["In the brain", "In the brain"],
  table: ["Table", "Tables"],
  app: ["App", "Apps"],
  calculation: ["Calculation", "Calculations"],
  document: ["Document", "Documents"],
  file: ["File", "Files"],
  connection: ["Connection", "Connections"],
  agent: ["AI employee", "AI employees"],
};

export const ASSET_ICONS: Record<ProjectAssetKind, LucideIcon> = {
  thing: Brain,
  table: Table2,
  app: AppWindow,
  calculation: Calculator,
  document: BookOpen,
  file: FileText,
  connection: Plug,
  agent: Bot,
};

/** Where an asset opens in the app (documents and files have no page of their own). */
export function assetHref(asset: Pick<ProjectAsset, "kind" | "ref">): string | null {
  switch (asset.kind) {
    case "thing":
      return paths.brain.thing(asset.ref);
    case "table":
      return paths.table(asset.ref, "studio");
    case "app":
      return paths.app(asset.ref, "studio");
    case "calculation":
      return paths.calculation(asset.ref, "studio");
    case "connection":
      return paths.settings("connections");
    case "agent":
      return paths.ai(asset.ref, "studio");
    default:
      return null;
  }
}
