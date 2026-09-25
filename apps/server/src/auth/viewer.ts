import type { FastifyReply, FastifyRequest } from "fastify";
import type { Membership, Person } from "@enterprise-brain/runtime";
import { HttpError } from "../http.ts";

/**
 * Who is making a request: a signed-in person, a machine with the console API key, or anyone in
 * "open" mode (no sign-in, for local trials and tests), who acts as the owner.
 */
export interface Viewer {
  kind: "session" | "api-key" | "open";
  /** The person's id for sessions; null otherwise. */
  userId: string | null;
  /** The company the person belongs to; null (any company) for the API key and open mode. */
  companyId: string | null;
  name: string;
  email: string | null;
  isAdmin: boolean;
  departments: Membership[];
  /** Departments whose AI employees serve everyone (e.g. Shared Services): visible to all. */
  openDepartmentIds: string[];
}

declare module "fastify" {
  interface FastifyRequest {
    viewer?: Viewer;
  }
}

export const OPEN_VIEWER: Viewer = { kind: "open", userId: null, companyId: null, name: "Owner", email: null, isAdmin: true, departments: [], openDepartmentIds: [] };
export const API_VIEWER: Viewer = { kind: "api-key", userId: null, companyId: null, name: "API", email: null, isAdmin: true, departments: [], openDepartmentIds: [] };

export function viewerFromPerson(person: Person, openDepartmentIds: string[] = []): Viewer {
  return {
    openDepartmentIds,
    kind: "session",
    userId: person.id,
    companyId: person.companyId,
    name: person.name,
    email: person.email,
    isAdmin: person.role === "admin",
    departments: person.departments,
  };
}

export function viewerOf(request: FastifyRequest): Viewer {
  if (!request.viewer) throw new HttpError(401, "Sign in to continue");
  return request.viewer;
}

export function requireAdmin(request: FastifyRequest): Viewer {
  const viewer = viewerOf(request);
  if (!viewer.isAdmin) throw new HttpError(403, "Only an admin can do this");
  return viewer;
}

/** How the viewer relates to a department: admins act as managers everywhere. */
export function departmentRole(viewer: Viewer, departmentId: string | null | undefined): "manager" | "worker" | undefined {
  if (viewer.isAdmin) return "manager";
  if (!departmentId) return undefined;
  return viewer.departments.find((d) => d.departmentId === departmentId)?.role;
}

/** Company-wide things (no department) are visible to everyone; department things to its people. */
export function canSeeDepartment(viewer: Viewer, departmentId: string | null | undefined): boolean {
  return (
    !departmentId || viewer.isAdmin || viewer.openDepartmentIds.includes(departmentId) || viewer.departments.some((d) => d.departmentId === departmentId)
  );
}

/** Managers run their departments' AI employees; admins run all, including company-wide ones. */
export function canManageDepartment(viewer: Viewer, departmentId: string | null | undefined): boolean {
  if (viewer.isAdmin) return true;
  return Boolean(departmentId) && departmentRole(viewer, departmentId) === "manager";
}

export function requireManager(request: FastifyRequest, departmentId: string | null | undefined): Viewer {
  const viewer = viewerOf(request);
  if (!canManageDepartment(viewer, departmentId)) throw new HttpError(403, "Only a manager of this department can do this");
  return viewer;
}

/** Admins, or managers of at least one department (company resources such as knowledge). */
export function requireAnyManager(request: FastifyRequest): Viewer {
  const viewer = viewerOf(request);
  if (!viewer.isAdmin && !viewer.departments.some((d) => d.role === "manager")) throw new HttpError(403, "Only a manager or an admin can do this");
  return viewer;
}

/** How the viewer appears in the audit log and on decisions. */
export function actorOf(viewer: Viewer | undefined): string {
  if (!viewer) return "system";
  if (viewer.kind === "session") return `${viewer.name} <${viewer.email}>`;
  return viewer.kind === "api-key" ? "api" : "user";
}

// ---------------------------------------------------------------------------
// Cookies (no plugin needed for the two the console uses)
// ---------------------------------------------------------------------------

export function readCookie(request: FastifyRequest, name: string): string | undefined {
  const header = request.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return decodeURIComponent(part.slice(index + 1).trim());
  }
  return undefined;
}

export function setCookie(reply: FastifyReply, name: string, value: string, options: { maxAgeSeconds: number; secure: boolean }): void {
  const cookie = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`,
    ...(options.secure ? ["Secure"] : []),
  ].join("; ");
  const existing = reply.getHeader("set-cookie");
  const list = Array.isArray(existing) ? existing.map(String) : existing ? [String(existing)] : [];
  reply.header("set-cookie", [...list, cookie]);
}

export function clearCookie(reply: FastifyReply, name: string, secure: boolean): void {
  setCookie(reply, name, "", { maxAgeSeconds: 0, secure });
}
