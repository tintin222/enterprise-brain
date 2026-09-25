import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { and, asc, count, eq, gt, inArray, lt } from "drizzle-orm";
import { departmentMembers, departments, sessions, users, type DatabaseHandle } from "@enterprise-brain/db";

export type UserRow = typeof users.$inferSelect;
export type UserRole = "admin" | "member";
export type MembershipRole = "manager" | "worker";

export interface Membership {
  departmentId: string;
  key: string;
  name: string;
  role: MembershipRole;
}

/** A person as the product shows them: account plus the departments they work in. */
export interface Person {
  id: string;
  companyId: string;
  email: string;
  name: string;
  title: string | null;
  role: UserRole;
  status: "active" | "disabled";
  departments: Membership[];
  hasPassword: boolean;
  authProvider: string | null;
  lastSignInAt: string | null;
  createdAt: string;
}

export interface PersonInput {
  email: string;
  name: string;
  title?: string | null;
  role?: UserRole;
  password?: string;
  departments?: { departmentId: string; role: MembershipRole }[];
}

export class PeopleError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "PeopleError";
  }
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 8;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function scrypt(password: string, salt: Buffer, keylen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => scryptCallback(password, salt, keylen, options, (error, key) => (error ? reject(error) : resolve(key))));
}

export function normalizeEmail(email: string): string {
  const value = email.trim().toLowerCase();
  if (!EMAIL.test(value)) throw new PeopleError(`"${email}" is not an email address`);
  return value;
}

/** scrypt with a random salt, stored as scrypt:N:r:p:salt:hash (base64). */
export async function hashPassword(password: string): Promise<string> {
  if (password.length < MIN_PASSWORD) throw new PeopleError(`Passwords need at least ${MIN_PASSWORD} characters`);
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64"), hash.toString("base64")].join(":");
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) return false;
  const [scheme, n, r, p, salt, hash] = stored.split(":");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const actual = await scrypt(password, Buffer.from(salt, "base64"), expected.length, { N: Number(n), r: Number(r), p: Number(p) });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function tokenId(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** People, their departments, and their browser sessions. */
export class PeopleService {
  constructor(private readonly handle: DatabaseHandle) {}

  async count(companyId: string): Promise<number> {
    const [row] = await this.handle.db.select({ n: count() }).from(users).where(eq(users.companyId, companyId));
    return row?.n ?? 0;
  }

  async list(companyId: string): Promise<Person[]> {
    const rows = await this.handle.db.select().from(users).where(eq(users.companyId, companyId)).orderBy(asc(users.name));
    return this.toPeople(companyId, rows);
  }

  async get(companyId: string, id: string): Promise<Person> {
    const [row] = await this.handle.db
      .select()
      .from(users)
      .where(and(eq(users.companyId, companyId), eq(users.id, id)));
    if (!row) throw new PeopleError(`Person ${id} not found`, 404);
    return (await this.toPeople(companyId, [row]))[0]!;
  }

  async findByEmail(companyId: string, email: string): Promise<UserRow | undefined> {
    const [row] = await this.handle.db
      .select()
      .from(users)
      .where(and(eq(users.companyId, companyId), eq(users.email, email.trim().toLowerCase())));
    return row;
  }

  async create(companyId: string, input: PersonInput & { authProvider?: string }): Promise<Person> {
    const email = normalizeEmail(input.email);
    if (await this.findByEmail(companyId, email)) throw new PeopleError(`${email} already has an account`, 409);
    const name = input.name.trim();
    if (!name) throw new PeopleError("A name is required");
    const [row] = await this.handle.db
      .insert(users)
      .values({
        companyId,
        email,
        name,
        title: input.title?.trim() || null,
        role: input.role ?? "member",
        passwordHash: input.password ? await hashPassword(input.password) : null,
        authProvider: input.authProvider ?? null,
      })
      .returning();
    if (input.departments?.length) await this.setMemberships(companyId, row!.id, input.departments);
    return this.get(companyId, row!.id);
  }

  async update(
    companyId: string,
    id: string,
    patch: {
      name?: string;
      title?: string | null;
      role?: UserRole;
      status?: "active" | "disabled";
      password?: string | null;
      departments?: { departmentId: string; role: MembershipRole }[];
    },
  ): Promise<Person> {
    const current = await this.get(companyId, id);
    const losesAdmin = current.role === "admin" && ((patch.role && patch.role !== "admin") || patch.status === "disabled");
    if (losesAdmin) await this.assertAnotherAdmin(companyId, id);
    const values: Partial<typeof users.$inferInsert> = { updatedAt: new Date() };
    if (patch.name !== undefined) {
      if (!patch.name.trim()) throw new PeopleError("A name is required");
      values.name = patch.name.trim();
    }
    if (patch.title !== undefined) values.title = patch.title?.trim() || null;
    if (patch.role) values.role = patch.role;
    if (patch.status) values.status = patch.status;
    if (patch.password !== undefined) values.passwordHash = patch.password ? await hashPassword(patch.password) : null;
    await this.handle.db
      .update(users)
      .set(values)
      .where(and(eq(users.companyId, companyId), eq(users.id, id)));
    if (patch.departments) await this.setMemberships(companyId, id, patch.departments);
    // Signing out everywhere is what disabling or a new password means.
    if (patch.status === "disabled" || patch.password !== undefined) await this.deleteUserSessions(id);
    return this.get(companyId, id);
  }

  async remove(companyId: string, id: string): Promise<void> {
    const current = await this.get(companyId, id);
    if (current.role === "admin") await this.assertAnotherAdmin(companyId, id);
    await this.handle.db.delete(users).where(and(eq(users.companyId, companyId), eq(users.id, id)));
  }

  private async assertAnotherAdmin(companyId: string, exceptId: string) {
    const admins = await this.handle.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.companyId, companyId), eq(users.role, "admin"), eq(users.status, "active")));
    if (!admins.some((a) => a.id !== exceptId)) throw new PeopleError("Keep at least one active admin: make someone else an admin first", 409);
  }

  async setMemberships(companyId: string, userId: string, memberships: { departmentId: string; role: MembershipRole }[]): Promise<void> {
    const ids = [...new Set(memberships.map((m) => m.departmentId))];
    if (ids.length) {
      const known = await this.handle.db
        .select({ id: departments.id })
        .from(departments)
        .where(and(eq(departments.companyId, companyId), inArray(departments.id, ids)));
      const missing = ids.filter((id) => !known.some((k) => k.id === id));
      if (missing.length) throw new PeopleError(`Unknown department ${missing.join(", ")}`, 404);
    }
    await this.handle.db.delete(departmentMembers).where(and(eq(departmentMembers.companyId, companyId), eq(departmentMembers.userId, userId)));
    const unique = new Map(memberships.map((m) => [m.departmentId, m.role]));
    if (unique.size) {
      await this.handle.db
        .insert(departmentMembers)
        .values([...unique].map(([departmentId, role]) => ({ companyId, departmentId, userId, role })));
    }
  }

  /** The people of a department, managers first. */
  async departmentPeople(companyId: string, departmentId: string): Promise<(Person & { membership: MembershipRole })[]> {
    const rows = await this.handle.db
      .select({ user: users, role: departmentMembers.role })
      .from(departmentMembers)
      .innerJoin(users, eq(users.id, departmentMembers.userId))
      .where(and(eq(departmentMembers.companyId, companyId), eq(departmentMembers.departmentId, departmentId)));
    const people = await this.toPeople(
      companyId,
      rows.map((r) => r.user),
    );
    return people
      .map((p) => ({ ...p, membership: (rows.find((r) => r.user.id === p.id)?.role ?? "worker") as MembershipRole }))
      .sort((a, b) => (a.membership === b.membership ? a.name.localeCompare(b.name) : a.membership === "manager" ? -1 : 1));
  }

  async recordSignIn(userId: string, provider: string, externalId?: string): Promise<void> {
    await this.handle.db
      .update(users)
      .set({ lastSignInAt: new Date(), authProvider: provider, ...(externalId ? { externalId } : {}) })
      .where(eq(users.id, userId));
  }

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  async createSession(companyId: string, userId: string, ttlMs: number): Promise<{ token: string; expiresAt: Date }> {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + ttlMs);
    await this.handle.db.insert(sessions).values({ id: tokenId(token), companyId, userId, expiresAt });
    // Housekeeping: expired sessions of this person go when they sign in again.
    await this.handle.db.delete(sessions).where(and(eq(sessions.userId, userId), lt(sessions.expiresAt, new Date())));
    return { token, expiresAt };
  }

  /** The signed-in person for a session token, or undefined when it expired, was revoked or the account is disabled. */
  async resolveSession(token: string): Promise<Person | undefined> {
    const [row] = await this.handle.db
      .select({ session: sessions, user: users })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(and(eq(sessions.id, tokenId(token)), gt(sessions.expiresAt, new Date())));
    if (!row || row.user.status !== "active") return undefined;
    if (Date.now() - row.session.lastSeenAt.getTime() > 5 * 60_000) {
      await this.handle.db.update(sessions).set({ lastSeenAt: new Date() }).where(eq(sessions.id, row.session.id));
    }
    return (await this.toPeople(row.user.companyId, [row.user]))[0];
  }

  async deleteSession(token: string): Promise<void> {
    await this.handle.db.delete(sessions).where(eq(sessions.id, tokenId(token)));
  }

  async deleteUserSessions(userId: string): Promise<void> {
    await this.handle.db.delete(sessions).where(eq(sessions.userId, userId));
  }

  private async toPeople(companyId: string, rows: UserRow[]): Promise<Person[]> {
    if (!rows.length) return [];
    const memberships = await this.handle.db
      .select({ userId: departmentMembers.userId, role: departmentMembers.role, departmentId: departments.id, key: departments.key, name: departments.name })
      .from(departmentMembers)
      .innerJoin(departments, eq(departments.id, departmentMembers.departmentId))
      .where(
        and(
          eq(departmentMembers.companyId, companyId),
          inArray(
            departmentMembers.userId,
            rows.map((r) => r.id),
          ),
        ),
      );
    return rows.map((row) => ({
      id: row.id,
      companyId: row.companyId,
      email: row.email,
      name: row.name,
      title: row.title,
      role: row.role === "admin" ? "admin" : "member",
      status: row.status === "disabled" ? "disabled" : "active",
      departments: memberships
        .filter((m) => m.userId === row.id)
        .map((m): Membership => ({ departmentId: m.departmentId, key: m.key, name: m.name, role: m.role === "manager" ? "manager" : "worker" }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      hasPassword: Boolean(row.passwordHash),
      authProvider: row.authProvider,
      lastSignInAt: row.lastSignInAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  /** Check a password sign-in; undefined on any mismatch (same answer for unknown email and wrong password). */
  async checkPassword(companyId: string, email: string, password: string): Promise<UserRow | undefined> {
    const row = await this.findByEmail(companyId, email);
    const ok = await verifyPassword(password, row?.passwordHash);
    return ok && row?.status === "active" ? row : undefined;
  }
}
