import {
  Activity,
  BookOpen,
  Bot,
  Boxes,
  Brain,
  Briefcase,
  Building,
  Calculator,
  Calendar,
  ChartBar,
  CircleCheckBig,
  Cloud,
  Database,
  Factory,
  FileSearch,
  FileSpreadsheet,
  FileText,
  Flag,
  FolderOpen,
  Gavel,
  Globe,
  Handshake,
  Headphones,
  HeartPulse,
  Inbox,
  Landmark,
  Layers,
  LayoutGrid,
  Mail,
  Megaphone,
  Monitor,
  MessageSquare,
  MessagesSquare,
  Package,
  PenLine,
  Plug,
  Receipt,
  Scale,
  ScanText,
  Search,
  Send,
  Server,
  Shield,
  ShieldCheck,
  ShoppingCart,
  Sparkles,
  Table,
  TrendingUp,
  Tags,
  Truck,
  UserCheck,
  Users,
  Wallet,
  Workflow,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import type { Archetype, WorkflowStep } from "../types.ts";

/** Department / use-case `icon` names from the catalog (lucide kebab-case names) → components. */
const NAMED_ICONS: Record<string, LucideIcon> = {
  users: Users,
  "user-check": UserCheck,
  layers: Layers,
  calculator: Calculator,
  briefcase: Briefcase,
  "shopping-cart": ShoppingCart,
  truck: Truck,
  factory: Factory,
  headphones: Headphones,
  headset: Headphones,
  scale: Scale,
  gavel: Gavel,
  megaphone: Megaphone,
  landmark: Landmark,
  wrench: Wrench,
  shield: Shield,
  "shield-check": ShieldCheck,
  server: Server,
  monitor: Monitor,
  "trending-up": TrendingUp,
  "line-chart": TrendingUp,
  database: Database,
  building: Building,
  "building-2": Building,
  wallet: Wallet,
  receipt: Receipt,
  package: Package,
  "heart-pulse": HeartPulse,
  handshake: Handshake,
  globe: Globe,
  "message-square": MessageSquare,
  "messages-square": MessagesSquare,
  "file-text": FileText,
  search: Search,
  table: Table,
  "file-spreadsheet": FileSpreadsheet,
  "book-open": BookOpen,
  inbox: Inbox,
  mail: Mail,
  brain: Brain,
  sparkles: Sparkles,
  bot: Bot,
  "bar-chart": ChartBar,
  "chart-bar": ChartBar,
  activity: Activity,
  calendar: Calendar,
  cloud: Cloud,
  folder: FolderOpen,
  flag: Flag,
  workflow: Workflow,
  tags: Tags,
  plug: Plug,
};

export function namedIcon(name: string | null | undefined, fallback: LucideIcon = Boxes): LucideIcon {
  if (!name) return fallback;
  return NAMED_ICONS[name] ?? NAMED_ICONS[name.toLowerCase()] ?? fallback;
}

export const ARCHETYPE_ICONS: Record<Archetype, LucideIcon> = {
  "document-processing": ScanText,
  "mail-triage": Inbox,
  conversational: MessageSquare,
  "excel-automation": FileSpreadsheet,
  search: Search,
  "process-automation": Workflow,
  "report-generation": ChartBar,
};

export function archetypeIcon(archetype: string | null | undefined): LucideIcon {
  return (archetype && ARCHETYPE_ICONS[archetype as Archetype]) || Bot;
}

export const STEP_ICONS: Record<WorkflowStep["type"], LucideIcon> = {
  extract: ScanText,
  "llm.extract": FileSearch,
  "llm.classify": Tags,
  "llm.evaluate": Scale,
  "llm.generate": PenLine,
  "knowledge.search": BookOpen,
  connector: Plug,
  approval: UserCheck,
  "mail.send": Send,
  "excel.read": FileSpreadsheet,
  "excel.write": FileSpreadsheet,
  agent: Bot,
  output: CircleCheckBig,
};

export function stepIcon(type: string): LucideIcon {
  return STEP_ICONS[type as WorkflowStep["type"]] ?? Workflow;
}

export const CATEGORY_ICONS: Record<string, LucideIcon> = {
  erp: Factory,
  crm: Handshake,
  hris: Users,
  ats: UserCheck,
  itsm: Wrench,
  mail: Mail,
  calendar: Calendar,
  dms: FolderOpen,
  storage: Cloud,
  accounting: Calculator,
  bi: ChartBar,
  ecommerce: ShoppingCart,
  scm: Truck,
  messaging: MessagesSquare,
  database: Database,
  web: Globe,
  esign: PenLine,
  other: LayoutGrid,
};

export function categoryIcon(category: string | null | undefined): LucideIcon {
  return (category && CATEGORY_ICONS[category]) || Plug;
}

/** Icon for an audit-log action ("agent.activated", "run.failed", …). */
export function activityIcon(action: string): LucideIcon {
  const [entity = "", verb = ""] = action.split(".");
  if (entity === "run") return verb === "failed" ? Flag : Activity;
  if (entity === "approval") return UserCheck;
  if (entity === "agent") return verb === "generated" ? Sparkles : Bot;
  if (entity === "connector") return Plug;
  if (entity === "knowledge") return BookOpen;
  if (entity === "department") return Building;
  if (entity === "stakeholder_request") return Mail;
  if (entity === "paperclip") return Workflow;
  if (entity === "mail") return Inbox;
  if (entity === "builder") return Sparkles;
  return Activity;
}
