import { createHash, randomUUID } from "node:crypto";
import { and, count, eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type {
  Access,
  AccessOptions,
  AccessResult,
  CustomerAccess,
  HumanActor,
} from "./types";
import type { AccessActionResponse, AccountPagination } from "./contract";
import {
  accessCommands,
  auditEntries,
  invitation,
  member,
  user,
} from "./internal/schema";
import { createPolicy, customerRole } from "./internal/policy";
import { createAuditWriter } from "./audit";
export { createAuditWriter, AuditRequestConflict } from "./audit";
export {
  createAuthentication,
  type AuthenticationOptions,
} from "./authentication";
export {
  bootstrapSyntheticAccess,
  type SyntheticAccessBootstrap,
} from "./bootstrap";
export type {
  Access,
  AccessOptions,
  HumanActor,
  AccessPolicy,
  AccessResult,
} from "./types";

const bounds = (page?: Partial<AccountPagination>) => ({
  limit: Math.min(100, Math.max(1, page?.limit ?? 50)),
  offset: Math.max(0, page?.offset ?? 0),
});
const hash = (input: unknown) =>
  createHash("sha256").update(JSON.stringify(input)).digest("hex");
const requestValid = (id: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    id,
  );
const outcome = (
  row: typeof accessCommands.$inferSelect,
): AccessResult<AccessActionResponse> => ({
  ok: true,
  value: {
    actionId: row.requestId,
    state: row.state,
    invitationId: row.invitationId,
  },
});

export function createAccess(options: AccessOptions): Access {
  if (options.lockPool === options.pool)
    throw new Error("Access requires a separate organization lock pool");
  const db = drizzle(options.pool);
  const policy = createPolicy(options.pool);
  const audit = createAuditWriter();
  const origin = new URL(options.baseURL).origin;
  async function actorFrom(headers: Headers): Promise<HumanActor | null> {
    const current = await options.authentication.getSession(headers);
    return current?.user.emailVerified ? current.actor : null;
  }
  async function commandActor(
    headers: Headers,
    requestId: string,
  ): Promise<AccessResult<HumanActor>> {
    if (!requestValid(requestId)) return { ok: false, code: "invalid_request" };
    if (headers.get("origin") !== origin)
      return { ok: false, code: "forbidden" };
    const actor = await actorFrom(headers);
    return actor
      ? { ok: true, value: actor }
      : { ok: false, code: "unauthenticated" };
  }
  async function withOrganization<T>(
    organizationId: string,
    work: (connection: NodePgDatabase) => Promise<T>,
  ): Promise<T> {
    const client = await options.lockPool.connect();
    let broken = false;
    let held = false;
    const lost = () => {
      broken = true;
    };
    client.on("error", lost);
    try {
      try {
        await client.query("select pg_advisory_lock(hashtextextended($1, 0))", [
          `access:${organizationId}`,
        ]);
        held = true;
      } catch (error) {
        // A lost acquisition receipt cannot prove the server did not obtain the lock.
        broken = true;
        throw error;
      }
      return await work(drizzle(client));
    } finally {
      if (!broken && held) {
        try {
          const released = await client.query<{ unlocked: boolean }>(
            "select pg_advisory_unlock(hashtextextended($1, 0)) as unlocked",
            [`access:${organizationId}`],
          );
          if (released.rows[0]?.unlocked !== true) broken = true;
        } catch {
          broken = true;
        }
      }
      client.off("error", lost);
      client.release(broken);
    }
  }

  async function existing(
    tx: NodePgDatabase,
    requestId: string,
    actor: HumanActor,
    customerId: string,
    action: string,
    inputHash: string,
  ) {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`access-request:${requestId}`},0))`,
    );
    const [row] = await tx
      .select()
      .from(accessCommands)
      .where(eq(accessCommands.requestId, requestId));
    return row
      ? row.actorId === actor.userId &&
        row.customerId === customerId &&
        row.action === action &&
        row.inputHash === inputHash
        ? outcome(row)
        : { ok: false as const, code: "conflict" as const }
      : null;
  }
  async function record(
    tx: NodePgDatabase,
    actor: HumanActor,
    customerId: string,
    requestId: string,
    action: string,
    targetId: string,
    state: string,
    details: Record<string, unknown> = {},
  ) {
    await tx.insert(auditEntries).values({
      id: randomUUID(),
      requestId,
      actorId: actor.userId,
      sessionId: actor.sessionId,
      customerId,
      action: `${action}.${state}`,
      targetId,
      details: { ...details, state },
    });
  }
  async function managed<T>(
    actor: HumanActor,
    customerId: string,
    work: (
      tx: NodePgDatabase,
      organizationId: string,
      permission: CustomerAccess,
    ) => Promise<AccessResult<T>>,
  ): Promise<AccessResult<T>> {
    const target = await options.getCustomerTarget(customerId);
    if (!target) return { ok: false, code: "not_found" };
    if (!target.organizationId) return { ok: false, code: "forbidden" };
    return withOrganization(target.organizationId, (connection) =>
      connection.transaction(async (tx) => {
        const current = await options.getCustomerTarget(customerId);
        if (!current || current.organizationId !== target.organizationId)
          return { ok: false, code: "not_found" };
        const permission = await policy.authorizeCustomer(
          tx,
          actor,
          current,
          "manage_members",
          true,
        );
        return permission.ok
          ? work(tx, target.organizationId!, permission.value)
          : permission;
      }),
    );
  }
  return {
    policy,
    audit,
    resolveActor: actorFrom,
    async getSession(headers) {
      const current = await options.authentication.getSession(headers);
      const scope = current?.user.emailVerified
        ? await policy.readScope(current.actor)
        : null;
      return {
        user:
          scope?.ok && current
            ? {
                id: current.actor.userId,
                name: current.user.name,
                emailVerified: current.user.emailVerified,
              }
            : null,
        staffRoles:
          scope?.ok && scope.value.kind === "staff" ? scope.value.roles : [],
        signInMethods: options.signInMethods,
        synthetic: options.synthetic,
      };
    },
    async listMembers(actor, customerId, page) {
      const target = await options.getCustomerTarget(customerId);
      if (!target) return { ok: false, code: "not_found" };
      const permission = await policy.authorizeCustomer(
        db,
        actor,
        target,
        "read_members",
        false,
      );
      if (!permission.ok) return permission;
      const filter = eq(member.organizationId, target.organizationId!);
      const pagination = bounds(page);
      const [rows, totals] = await Promise.all([
        db
          .select({
            id: member.id,
            userId: member.userId,
            name: user.name,
            email: user.email,
            role: member.role,
          })
          .from(member)
          .innerJoin(user, eq(member.userId, user.id))
          .where(filter)
          .orderBy(user.name, member.id)
          .limit(pagination.limit)
          .offset(pagination.offset),
        db.select({ total: count() }).from(member).where(filter),
      ]);
      return {
        ok: true,
        value: {
          members: rows.flatMap((row) => {
            const role = customerRole(row.role);
            return role ? [{ ...row, role }] : [];
          }),
          total: totals[0]?.total ?? 0,
          ...pagination,
        },
      };
    },
    async listInvitations(actor, customerId, page) {
      const target = await options.getCustomerTarget(customerId);
      if (!target) return { ok: false, code: "not_found" };
      const permission = await policy.authorizeCustomer(
        db,
        actor,
        target,
        "read_members",
        false,
      );
      if (!permission.ok) return permission;
      const filter = eq(invitation.organizationId, target.organizationId!);
      const pagination = bounds(page);
      const [rows, totals] = await Promise.all([
        db
          .select()
          .from(invitation)
          .where(filter)
          .orderBy(invitation.createdAt, invitation.id)
          .limit(pagination.limit)
          .offset(pagination.offset),
        db.select({ total: count() }).from(invitation).where(filter),
      ]);
      return {
        ok: true,
        value: {
          invitations: rows.map((row) => ({
            id: row.id,
            email: row.email,
            role: customerRole(row.role ?? undefined) ?? "member",
            status:
              row.status === "accepted"
                ? ("accepted" as const)
                : row.status === "canceled" || row.status === "rejected"
                  ? ("revoked" as const)
                  : row.expiresAt <= new Date()
                    ? ("expired" as const)
                    : ("pending" as const),
            expiresAt: row.expiresAt.toISOString(),
          })),
          total: totals[0]?.total ?? 0,
          ...pagination,
        },
      };
    },
    async inviteMember(headers, customerId, input) {
      const actor = await commandActor(headers, input.requestId);
      if (!actor.ok) return actor;
      const email = input.email.toLowerCase();
      if (
        !options.allowInvitation(email) ||
        !["administrator", "member"].includes(input.role)
      )
        return { ok: false, code: "invalid_request" };
      const inputHash = hash([customerId, email, input.role]);
      const result = await managed(
        actor.value,
        customerId,
        async (tx, organizationId, permission) => {
          const previous = await existing(
            tx,
            input.requestId,
            actor.value,
            customerId,
            "invitation.create",
            inputHash,
          );
          if (previous) return previous;
          const [recipient] = await tx
            .select()
            .from(user)
            .where(eq(user.email, email));
          if (recipient) {
            const [present] = await tx
              .select()
              .from(member)
              .where(
                and(
                  eq(member.userId, recipient.id),
                  eq(member.organizationId, organizationId),
                ),
              );
            if (present) return { ok: false, code: "conflict" };
          } else
            await tx.insert(user).values({
              id: randomUUID(),
              name: email,
              email,
              emailVerified: false,
              createdAt: new Date(),
              updatedAt: new Date(),
            });
          const pending = await tx
            .select()
            .from(invitation)
            .where(
              and(
                eq(invitation.organizationId, organizationId),
                eq(invitation.email, email),
                eq(invitation.status, "pending"),
              ),
            );
          if (pending.some((row) => row.expiresAt > new Date()))
            return { ok: false, code: "conflict" };
          const id = randomUUID();
          await tx.insert(invitation).values({
            id,
            organizationId,
            email,
            role: input.role === "administrator" ? "admin" : "member",
            status: "pending",
            expiresAt: new Date(Date.now() + 7 * 86400000),
            createdAt: new Date(),
            inviterId: actor.value.userId,
          });
          const [receipt] = await tx
            .insert(accessCommands)
            .values({
              requestId: input.requestId,
              actorId: actor.value.userId,
              customerId,
              action: "invitation.create",
              inputHash,
              invitationId: id,
              targetId: id,
              state: "pending",
            })
            .returning();
          await record(
            tx,
            actor.value,
            customerId,
            input.requestId,
            "invitation.create",
            id,
            "requested",
            { invitedByStaff: permission.staffRoles.length > 0 },
          );
          return outcome(receipt!);
        },
      );
      if (
        !result.ok ||
        result.value.state !== "pending" ||
        !result.value.invitationId
      )
        return result;
      try {
        await options.sendInvitation({
          email,
          invitationId: result.value.invitationId,
          customerId,
        });
      } catch {
        return result;
      }
      return db.transaction(async (tx) => {
        const [receipt] = await tx
          .update(accessCommands)
          .set({ state: "completed", updatedAt: new Date() })
          .where(
            and(
              eq(accessCommands.requestId, input.requestId),
              eq(accessCommands.state, "pending"),
            ),
          )
          .returning();
        if (receipt)
          await record(
            tx,
            actor.value,
            customerId,
            input.requestId,
            "invitation.create",
            receipt.targetId,
            "completed",
          );
        return receipt ? outcome(receipt) : result;
      });
    },
    async revokeInvitation(headers, customerId, invitationId, input) {
      const actor = await commandActor(headers, input.requestId);
      if (!actor.ok) return actor;
      const inputHash = hash([customerId, invitationId]);
      return managed(actor.value, customerId, async (tx, organizationId) => {
        const previous = await existing(
          tx,
          input.requestId,
          actor.value,
          customerId,
          "invitation.revoke",
          inputHash,
        );
        if (previous) return previous;
        const [row] = await tx
          .select()
          .from(invitation)
          .where(
            and(
              eq(invitation.id, invitationId),
              eq(invitation.organizationId, organizationId),
            ),
          )
          .for("update");
        if (!row) return { ok: false, code: "not_found" };
        if (row.status === "accepted") return { ok: false, code: "conflict" };
        await tx
          .update(invitation)
          .set({ status: "canceled" })
          .where(eq(invitation.id, invitationId));
        const [receipt] = await tx
          .insert(accessCommands)
          .values({
            requestId: input.requestId,
            actorId: actor.value.userId,
            customerId,
            action: "invitation.revoke",
            inputHash,
            invitationId,
            targetId: invitationId,
            state: "completed",
          })
          .returning();
        await record(
          tx,
          actor.value,
          customerId,
          input.requestId,
          "invitation.revoke",
          invitationId,
          "completed",
        );
        return outcome(receipt!);
      });
    },
    async revokeMember(headers, customerId, memberId, input) {
      const actor = await commandActor(headers, input.requestId);
      if (!actor.ok) return actor;
      const inputHash = hash([customerId, memberId]);
      return managed(actor.value, customerId, async (tx, organizationId) => {
        const previous = await existing(
          tx,
          input.requestId,
          actor.value,
          customerId,
          "member.revoke",
          inputHash,
        );
        if (previous) return previous;
        const rows = await tx
          .select()
          .from(member)
          .where(eq(member.organizationId, organizationId))
          .orderBy(member.id)
          .for("update");
        const target = rows.find((row) => row.id === memberId);
        if (!target) return { ok: false, code: "not_found" };
        if (
          customerRole(target.role) === "administrator" &&
          rows.filter((row) => customerRole(row.role) === "administrator")
            .length <= 1
        )
          return { ok: false, code: "conflict" };
        await tx.delete(member).where(eq(member.id, memberId));
        const [receipt] = await tx
          .insert(accessCommands)
          .values({
            requestId: input.requestId,
            actorId: actor.value.userId,
            customerId,
            action: "member.revoke",
            inputHash,
            targetId: memberId,
            state: "completed",
          })
          .returning();
        await record(
          tx,
          actor.value,
          customerId,
          input.requestId,
          "member.revoke",
          memberId,
          "completed",
        );
        return outcome(receipt!);
      });
    },
    async acceptInvitation(headers, invitationId, input) {
      const actor = await commandActor(headers, input.requestId);
      if (!actor.ok) return actor;
      const [initial] = await db
        .select()
        .from(invitation)
        .where(eq(invitation.id, invitationId));
      if (!initial) return { ok: false, code: "not_found" };
      return withOrganization(initial.organizationId, async (connection) => {
        // Invitation identity is authoritative; find its customer through a composition-owned reverse mapping.
        const target = await options.getOrganizationTarget(
          initial.organizationId,
        );
        if (!target) return { ok: false, code: "not_found" };
        const inputHash = hash([invitationId]);
        const prepared = await connection.transaction(async (tx) => {
          const session = await options.authentication.getSession(headers);
          if (
            !session ||
            !session.user.emailVerified ||
            session.actor.userId !== actor.value.userId ||
            session.user.email.toLowerCase() !== initial.email.toLowerCase()
          )
            return { ok: false as const, code: "forbidden" as const };
          const previous = await existing(
            tx,
            input.requestId,
            actor.value,
            target.customerId,
            "invitation.accept",
            inputHash,
          );
          if (previous) return previous;
          const [row] = await tx
            .select()
            .from(invitation)
            .where(eq(invitation.id, invitationId))
            .for("update");
          if (
            !row ||
            row.status !== "pending" ||
            row.expiresAt <= new Date() ||
            !options.allowInvitation(row.email)
          )
            return { ok: false as const, code: "conflict" as const };
          const [receipt] = await tx
            .insert(accessCommands)
            .values({
              requestId: input.requestId,
              actorId: actor.value.userId,
              customerId: target.customerId,
              action: "invitation.accept",
              inputHash,
              invitationId,
              targetId: invitationId,
              state: "pending",
            })
            .returning();
          await record(
            tx,
            actor.value,
            target.customerId,
            input.requestId,
            "invitation.accept",
            invitationId,
            "requested",
          );
          return outcome(receipt!);
        });
        if (!prepared.ok || prepared.value.state !== "pending") return prepared;
        const [before] = await connection
          .select()
          .from(invitation)
          .where(eq(invitation.id, invitationId));
        const [priorMembership] = await connection
          .select({ id: member.id })
          .from(member)
          .where(
            and(
              eq(member.organizationId, initial.organizationId),
              eq(member.userId, actor.value.userId),
            ),
          );
        let acceptedMemberId: string | null = null;
        let lostReceipt = false;
        const attempted =
          before?.status === "pending" && before.expiresAt > new Date();
        if (attempted) {
          try {
            const receipt = await options.authentication.acceptInvitation(
              headers,
              invitationId,
            );
            if (receipt.organizationId === initial.organizationId)
              acceptedMemberId = receipt.memberId;
          } catch {
            lostReceipt = true;
            /* Reconcile durable library state below. */
          }
        }
        return connection.transaction(async (tx) => {
          const [accepted] = await tx
            .select()
            .from(invitation)
            .where(eq(invitation.id, invitationId));
          const [membership] = await tx
            .select()
            .from(member)
            .where(
              and(
                eq(member.organizationId, initial.organizationId),
                eq(member.userId, actor.value.userId),
              ),
            );
          const state =
            accepted?.status === "accepted" &&
            membership &&
            membership.role === accepted.role
              ? "completed"
              : accepted?.status === "pending" &&
                  accepted.expiresAt > new Date()
                ? "pending"
                : "needs_review";
          // A lost library response can be linked only when this locked invocation
          // observed no member before acceptance. Older uncertain commands stay unknown.
          const memberId =
            state === "completed" &&
            membership &&
            attempted &&
            !priorMembership &&
            (lostReceipt || acceptedMemberId === membership.id)
              ? membership.id
              : null;
          const [receipt] = await tx
            .update(accessCommands)
            .set({
              state,
              ...(memberId ? { targetId: memberId } : {}),
              updatedAt: new Date(),
            })
            .where(eq(accessCommands.requestId, input.requestId))
            .returning();
          await record(
            tx,
            actor.value,
            target.customerId,
            input.requestId,
            "invitation.accept",
            invitationId,
            state === "pending" ? "uncertain" : state,
            memberId ? { memberId } : {},
          );
          return outcome(receipt!);
        });
      });
    },
  };
}
export {
  assertSyntheticAccess,
  type SyntheticAccessPolicy,
} from "./inspection";
