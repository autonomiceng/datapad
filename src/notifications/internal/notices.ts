import canonicalize from "canonicalize";
import { randomUUID } from "node:crypto";
import { Temporal } from "@js-temporal/polyfill";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type {
  FinalizedNoticeInvoice,
  InvoiceNoticeFacts,
} from "../../billing/notice-types";
import type { WorkResult } from "../../billing/work-types";
import type {
  InvoiceNotices,
  InvoiceNoticesOptions,
  NoticeTemplateInput,
} from "../types";
import type {
  InvoiceNoticesResponse,
  NoticeReason,
  NoticeStage,
} from "../contract";
import { renderInvoiceNotice } from "../templates";
import { invoiceNotices } from "./schema";

type Notice = typeof invoiceNotices.$inferSelect;
const stages: NoticeStage[] = ["invoice", "before_due", "due", "overdue"];
const offsets = [-21, -7, 0, 7, 8];
const isUuid = (s: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    s,
  );
const iso = (s: string | null) =>
  s === null ? null : new Date(s).toISOString();
const evidenceFresh = (facts: InvoiceNoticeFacts, now: Date) =>
  facts.observedFrom !== null &&
  facts.observedThrough !== null &&
  Date.parse(facts.observedFrom) <= Date.parse(facts.observedThrough) &&
  Date.parse(facts.observedThrough) <= now.getTime() &&
  now.getTime() - Date.parse(facts.observedFrom) <= 5000;
function schedule(
  invoice: FinalizedNoticeInvoice,
  calendar: InvoiceNoticesOptions["noticeCalendar"],
) {
  const timeZone = invoice.calendar?.timeZone ?? calendar.timeZone;
  try {
    const due = Temporal.PlainDate.from(invoice.dueDate);
    const instants = offsets.map((days) =>
      due
        .add({ days })
        .toPlainDateTime({ hour: calendar.hour })
        .toZonedDateTime(timeZone, { disambiguation: "reject" })
        .toInstant()
        .toString(),
    );
    return { timeZone, instants };
  } catch {
    return { timeZone, instants: null };
  }
}
/** Constructs deployment-scoped durable notices. Composition supplies trusted origin, explicit recipient policy and billing observation; absent billing holds all sends. */
export function createInvoiceNotices(
  options: InvoiceNoticesOptions,
): InvoiceNotices {
  const {
    pool,
    deploymentKey,
    customerAccess,
    billing,
    billingReader,
    smtp,
    audit,
    workerId,
    allowRecipient,
    noticeCalendar,
    portalOrigin,
    wallNow = () => new Date(),
  } = options;
  const businessNow = options.businessNow ?? wallNow;
  const origin = new URL(portalOrigin);
  if (
    !/^[A-Za-z0-9_-]{1,64}$/.test(deploymentKey) ||
    !workerId.trim() ||
    !Number.isInteger(noticeCalendar.hour) ||
    noticeCalendar.hour < 0 ||
    noticeCalendar.hour > 23 ||
    !noticeCalendar.timeZone ||
    !["http:", "https:"].includes(origin.protocol) ||
    origin.origin !== portalOrigin
  )
    throw new Error("Invalid notice configuration");
  const db = drizzle(pool);
  const scope = (id: string) =>
    and(
      eq(invoiceNotices.id, id),
      eq(invoiceNotices.deploymentKey, deploymentKey),
    );
  const rowsFor = (tx: NodePgDatabase, invoiceId: string) =>
    tx
      .select()
      .from(invoiceNotices)
      .where(
        and(
          eq(invoiceNotices.deploymentKey, deploymentKey),
          eq(invoiceNotices.invoiceId, invoiceId),
        ),
      )
      .orderBy(asc(invoiceNotices.createdAt), asc(invoiceNotices.id));
  async function transition(
    tx: NodePgDatabase,
    row: Notice,
    values: Partial<Notice>,
  ) {
    const [updated] = await tx
      .update(invoiceNotices)
      .set(values)
      .where(scope(row.id))
      .returning();
    if (
      updated.state !== row.state ||
      updated.reason !== row.reason ||
      updated.attempts !== row.attempts
    ) {
      const action =
        updated.state === "sending"
          ? "invoice.notice_attempted"
          : updated.state === "accepted"
            ? "invoice.notice_accepted"
            : updated.state === "suppressed"
              ? "invoice.notice_suppressed"
              : updated.state === "needs_review"
                ? "invoice.notice_needs_review"
                : null;
      if (action)
        await audit.recordOperator(tx, {
          operatorId: workerId,
          customerId: row.customerId,
          targetId: row.id,
          action,
          invoiceId: row.invoiceId,
          noticeId: row.id,
          stage: row.stage,
          reason: updated.reason,
          attempts: updated.attempts,
          recipientSource: "billing_contact",
          profileVersion: updated.profileVersion,
        });
    }
    return updated;
  }
  const defer = (tx: NodePgDatabase, row: Notice, reason: NoticeReason) =>
    transition(tx, row, {
      reason,
      nextAttemptAt: new Date(wallNow().getTime() + 30000).toISOString(),
    });
  const review = (tx: NodePgDatabase, row: Notice, reason: NoticeReason) =>
    transition(tx, row, { state: "needs_review", reason, nextAttemptAt: null });
  const suppress = (tx: NodePgDatabase, row: Notice, reason: NoticeReason) =>
    transition(tx, row, { state: "suppressed", reason, nextAttemptAt: null });
  async function localGate(
    tx: NodePgDatabase,
    row: Notice,
    rows: Notice[],
    recipient: string | null | undefined,
  ): Promise<WorkResult | null> {
    if (row.state === "accepted" || row.state === "suppressed")
      return "complete";
    if (row.state === "needs_review") return "needs_review";
    if (row.state === "sending") {
      await review(tx, row, "uncertain_delivery");
      return "needs_review";
    }
    const business = businessNow().getTime();
    if (
      row.stage !== "invoice" &&
      row.windowEndAt &&
      business >= Date.parse(row.windowEndAt)
    ) {
      await suppress(tx, row, "obsolete");
      return "complete";
    }
    const now = wallNow().getTime();
    if (row.nextAttemptAt && Date.parse(row.nextAttemptAt) > now)
      return "retry";
    if (
      row.stage !== "invoice" &&
      (!row.scheduledAt || business < Date.parse(row.scheduledAt))
    )
      return "retry";
    const hold = async (reason: NoticeReason) => {
      // Grow from the obligation's age at its previous retry, without a counter.
      const delay =
        row.reason === reason && row.nextAttemptAt
          ? Math.min(
              3600000,
              Math.max(
                60000,
                2 * (Date.parse(row.nextAttemptAt) - Date.parse(row.createdAt)),
              ),
            )
          : 30000;
      await transition(tx, row, {
        reason,
        nextAttemptAt:
          reason === "initial_notice_needs_review"
            ? null
            : new Date(now + delay).toISOString(),
      });
      return "retry" as const;
    };
    if (row.stage !== "invoice") {
      const first = rows.find((r) => r.stage === "invoice")!;
      if (first.state !== "accepted")
        return hold(
          first.state === "needs_review"
            ? "initial_notice_needs_review"
            : "initial_notice_pending",
        );
      for (const earlier of rows)
        if (
          earlier.state === "pending" &&
          earlier.stage !== "invoice" &&
          earlier.windowEndAt &&
          business >= Date.parse(earlier.windowEndAt)
        )
          await suppress(tx, earlier, "obsolete");
    }
    if (!recipient) {
      if (!row.attempts) return hold("billing_contact_missing");
      await review(tx, row, "billing_contact_changed");
      return "needs_review";
    }
    if (row.recipient && row.recipient !== recipient) {
      await review(tx, row, "billing_contact_changed");
      return "needs_review";
    }
    if (!allowRecipient(recipient)) {
      await review(tx, row, "recipient_not_allowed");
      return "needs_review";
    }
    return null;
  }
  function inputFor(
    row: Pick<Notice, "stage" | "timeZone">,
    facts: Pick<
      InvoiceNoticeFacts,
      | "invoiceId"
      | "billTo"
      | "issuedAt"
      | "dueDate"
      | "currency"
      | "remainingMinor"
      | "collection"
      | "paymentUrl"
      | "verifiedFinalization"
    >,
  ): NoticeTemplateInput | null {
    if (
      !facts.verifiedFinalization ||
      !facts.issuedAt ||
      facts.collection.disposition.kind !== "payable" ||
      facts.remainingMinor === null ||
      !Number.isInteger(facts.remainingMinor) ||
      facts.remainingMinor <= 0 ||
      facts.remainingMinor > 99999999
    )
      return null;
    let paymentUrl = `${origin.origin}/invoices?invoiceId=${encodeURIComponent(facts.invoiceId)}`;
    if (facts.paymentUrl) {
      const url = new URL(facts.paymentUrl);
      if (
        url.protocol !== "https:" ||
        url.hostname !== "invoice.stripe.com" ||
        url.username ||
        url.password ||
        url.port
      )
        return null;
      paymentUrl = url.href;
    }
    return {
      stage: row.stage,
      invoiceId: facts.invoiceId,
      billToName: facts.billTo.legalName,
      issuedAt: facts.issuedAt,
      dueDate: facts.dueDate,
      timeZone: row.timeZone,
      currency: facts.currency,
      remainingMinor: facts.remainingMinor,
      paymentReason: facts.collection.disposition.reason,
      paymentUrl,
    };
  }
  async function materialize(invoice: FinalizedNoticeInvoice) {
    const calendar = schedule(invoice, noticeCalendar);
    await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(invoiceNotices)
        .values(
          stages.map((stage, i) => ({
            id: randomUUID(),
            deploymentKey,
            invoiceId: invoice.invoiceId,
            billingCustomerId: invoice.billingCustomerId,
            customerId: invoice.customerId,
            stage,
            state: calendar.instants
              ? ("pending" as const)
              : ("needs_review" as const),
            reason: calendar.instants ? null : ("calendar_invalid" as const),
            timeZone: calendar.timeZone,
            hour: noticeCalendar.hour,
            scheduledAt: calendar.instants?.[i] ?? null,
            windowEndAt: calendar.instants?.[i + 1] ?? null,
            createdAt: wallNow().toISOString(),
          })),
        )
        .onConflictDoNothing()
        .returning();
      for (const row of inserted)
        if (row.state === "needs_review")
          await audit.recordOperator(tx, {
            operatorId: workerId,
            customerId: row.customerId,
            targetId: row.id,
            action: "invoice.notice_needs_review",
            invoiceId: row.invoiceId,
            noticeId: row.id,
            stage: row.stage,
            reason: row.reason,
            attempts: 0,
            recipientSource: "billing_contact",
            profileVersion: null,
          });
    });
  }
  return {
    async getInvoiceNotices(actor, customerId, invoiceId) {
      if (!isUuid(customerId) || !isUuid(invoiceId))
        return { ok: false, code: "not_found" };
      const access = await db.transaction((tx) =>
        customerAccess.authorizeCustomer(
          tx,
          actor,
          customerId,
          "manage_billing",
          false,
        ),
      );
      if (!access.ok) return access;
      const result = await billingReader.getInvoiceForCustomers(
        [customerId],
        invoiceId,
      );
      if (!result) return { ok: false, code: "not_found" };
      const rows = await rowsFor(db, invoiceId);
      const notices: InvoiceNoticesResponse["notices"] = rows
        .sort((a, b) => stages.indexOf(a.stage) - stages.indexOf(b.stage))
        .map((row) => {
          // The scoped reader has no remaining-balance snapshot. An unstamped
          // preview stays absent instead of treating invoice total as unpaid debt.
          const preview = row.preview;
          return {
            id: row.id,
            stage: row.stage,
            state: row.state,
            reason: row.reason,
            calendar: { timeZone: row.timeZone, hour: row.hour },
            scheduledAt: iso(row.scheduledAt),
            attempts: row.attempts,
            nextAttemptAt: iso(row.nextAttemptAt),
            attemptedAt: iso(row.attemptedAt),
            acceptedAt: iso(row.acceptedAt),
            recipient: row.recipient,
            profileVersion: row.profileVersion,
            preview,
            previewKind: preview ? "stamped" : null,
            messageId: row.messageId,
          };
        });
      return { ok: true, value: { invoiceId, notices } };
    },
    async sweepNotices({
      limit = 100,
      discovery = { after: null, through: null },
      pending = { after: null, through: null },
    } = {}) {
      const valid = (c: NonNullable<typeof pending.after>) =>
        isUuid(c.noticeId) && Number.isFinite(Date.parse(c.createdAt));
      if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 100 ||
        (pending.after && (!pending.through || !valid(pending.after))) ||
        (pending.through && !valid(pending.through))
      )
        throw new RangeError("Invalid notice cursor");
      const paused = await db.transaction(
        async (tx) =>
          (await options.financialEffectGuard.assertMayStart(tx)) === "paused",
      );
      if (billing && !paused) {
        const page = await billing.finalizedNoticePage({ limit, ...discovery });
        for (const invoice of page.invoices) await materialize(invoice);
        discovery = page.next
          ? { after: page.next, through: page.through }
          : { after: null, through: null };
      }
      const eligible = and(
        eq(invoiceNotices.deploymentKey, deploymentKey),
        paused ? sql`${invoiceNotices.attemptedAt} is not null` : undefined,
        sql`(${invoiceNotices.state}='sending' or (${invoiceNotices.state}='pending' and (
          (${invoiceNotices.stage}<>'invoice' and ${invoiceNotices.windowEndAt}<=${businessNow().toISOString()}::timestamptz)
          or ((${invoiceNotices.reason} is null or ${invoiceNotices.reason}<>'initial_notice_needs_review')
            and (${invoiceNotices.nextAttemptAt} is null or ${invoiceNotices.nextAttemptAt}<=${wallNow().toISOString()}::timestamptz)
            and (${invoiceNotices.stage}='invoice' or ${invoiceNotices.scheduledAt}<=${businessNow().toISOString()}::timestamptz))
        )))`,
      );
      const selection = {
        createdAt: invoiceNotices.createdAt,
        noticeId: invoiceNotices.id,
      };
      let through = pending.through;
      if (!through) {
        const [last] = await db
          .select(selection)
          .from(invoiceNotices)
          .where(eligible)
          .orderBy(desc(invoiceNotices.createdAt), desc(invoiceNotices.id))
          .limit(1);
        through = last ?? null;
      }
      if (!through)
        return {
          noticeIds: [],
          discovery,
          pending: { after: null, through: null },
        };
      const rows = await db
        .select(selection)
        .from(invoiceNotices)
        .where(
          and(
            eligible,
            sql`(${invoiceNotices.createdAt},${invoiceNotices.id})<=(${through.createdAt}::timestamptz,${through.noticeId}::uuid)`,
            pending.after
              ? sql`(${invoiceNotices.createdAt},${invoiceNotices.id})>(${pending.after.createdAt}::timestamptz,${pending.after.noticeId}::uuid)`
              : undefined,
          ),
        )
        .orderBy(asc(invoiceNotices.createdAt), asc(invoiceNotices.id))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      return {
        noticeIds: page.map((r) => r.noticeId),
        discovery,
        pending:
          rows.length > limit
            ? { after: page[page.length - 1], through }
            : { after: null, through: null },
      };
    },
    async processNotice(noticeId) {
      if (!isUuid(noticeId)) return "complete";
      const [initial] = await db
        .select()
        .from(invoiceNotices)
        .where(scope(noticeId));
      if (!initial) return "complete";
      if (!billing) return "retry";
      return (
        (await billing.withInvoiceNoticeContext<WorkResult>(
          initial.invoiceId,
          async (context) => {
            const { connection } = context;
            const checkLocal = async (tx: NodePgDatabase) => {
              const profile = await customerAccess.readProfile(
                tx,
                initial.customerId,
                { lock: true },
              );
              const rows = await tx
                .select()
                .from(invoiceNotices)
                .where(
                  and(
                    eq(invoiceNotices.deploymentKey, deploymentKey),
                    eq(invoiceNotices.invoiceId, initial.invoiceId),
                  ),
                )
                .for("update");
              const row = rows.find((r) => r.id === noticeId);
              const result = row
                ? await localGate(tx, row, rows, profile?.profile.billingEmail)
                : "complete";
              return { profile, rows, row, result };
            };
            const preflight = await connection.transaction(checkLocal);
            if (preflight.result !== null) return preflight.result;
            await context.observe();
            for (let inspection = 0; inspection < 2; inspection++) {
              const result = await connection.transaction(
                async (
                  tx,
                ): Promise<
                  | { kind: "done"; result: WorkResult }
                  | { kind: "reinspect" }
                  | { kind: "send"; row: Notice; facts: InvoiceNoticeFacts }
                > => {
                  const {
                    profile,
                    rows,
                    row,
                    result: local,
                  } = await checkLocal(tx);
                  const done = (result: WorkResult) => ({
                    kind: "done" as const,
                    result,
                  });
                  if (local !== null) return done(local);
                  if (!row)
                    throw new Error("Notice disappeared under invoice lock");
                  const facts = await context.recheck(tx);
                  if (
                    facts.customerId !== row.customerId ||
                    facts.billingCustomerId !== row.billingCustomerId
                  )
                    throw new Error("Notice invoice scope mismatch");
                  const disposition = facts.collection.disposition;
                  if (disposition.kind === "suppress") {
                    for (const pending of rows)
                      if (pending.state === "pending")
                        await suppress(tx, pending, disposition.reason);
                    return done("complete");
                  }
                  if (disposition.kind === "defer") {
                    if (disposition.reason === "stale" && inspection === 0)
                      return { kind: "reinspect" };
                    await defer(tx, row, disposition.reason);
                    return done("retry");
                  }
                  if (!facts.verifiedFinalization) {
                    await defer(tx, row, "not_payable");
                    return done("retry");
                  }
                  const business = businessNow().getTime();
                  const recipient = profile!.profile.billingEmail!;
                  const input = inputFor(row, facts);
                  if (!input) {
                    await defer(tx, row, "not_payable");
                    return done("retry");
                  }
                  const preview = renderInvoiceNotice(input);
                  if (
                    row.preview &&
                    (canonicalize(row.templateInput) !== canonicalize(input) ||
                      canonicalize(row.preview) !== canonicalize(preview))
                  ) {
                    await review(tx, row, "content_changed");
                    return done("needs_review");
                  }
                  if (row.attempts >= 3) {
                    await review(tx, row, "retry_exhausted");
                    return done("needs_review");
                  }
                  if (row.stage === "invoice")
                    for (const reminder of rows)
                      if (
                        reminder.stage !== "invoice" &&
                        reminder.state === "pending" &&
                        reminder.scheduledAt &&
                        Date.parse(reminder.scheduledAt) <= business
                      )
                        await suppress(tx, reminder, "obsolete_after_delay");
                  if (
                    (await options.financialEffectGuard.assertMayStart(tx)) ===
                    "paused"
                  )
                    return done("retry");
                  const stamped = await transition(tx, row, {
                    state: "sending",
                    reason: null,
                    attempts: row.attempts + 1,
                    nextAttemptAt: null,
                    attemptedAt: wallNow().toISOString(),
                    recipient: row.recipient ?? recipient,
                    profileVersion: row.profileVersion ?? profile!.version,
                    preview: row.preview ?? preview,
                    templateInput: row.templateInput ?? input,
                    templateVersion: 1,
                    messageId:
                      row.messageId ??
                      `<${deploymentKey}.${row.id}@notices.datapad.test>`,
                  });
                  return { kind: "send", row: stamped, facts };
                },
              );
              if (result.kind === "done") return result.result;
              if (result.kind === "reinspect") {
                await context.observe();
                continue;
              }
              const { row, facts } = result;
              if (!evidenceFresh(facts, wallNow())) {
                await connection.transaction((tx) =>
                  review(tx, row, "evidence_expired_before_send"),
                );
                return "needs_review";
              }
              let outcome: Awaited<ReturnType<typeof smtp.send>>;
              try {
                outcome = await smtp.send({
                  ...row.preview!,
                  recipient: row.recipient!,
                  messageId: row.messageId!,
                });
              } catch {
                outcome = { kind: "uncertain" };
              }
              return connection.transaction(async (tx) => {
                if (outcome.kind === "accepted") {
                  await transition(tx, row, {
                    state: "accepted",
                    reason: null,
                    acceptedAt: wallNow().toISOString(),
                  });
                  return "complete";
                }
                if (outcome.kind === "uncertain") {
                  await review(tx, row, "uncertain_delivery");
                  return "needs_review";
                }
                if (!outcome.transient || row.attempts >= 3) {
                  await review(
                    tx,
                    row,
                    outcome.transient ? "retry_exhausted" : "smtp_rejected",
                  );
                  return "needs_review";
                }
                await transition(tx, row, {
                  state: "pending",
                  reason: "smtp_transient",
                  nextAttemptAt: new Date(
                    wallNow().getTime() + (row.attempts === 1 ? 60000 : 300000),
                  ).toISOString(),
                });
                return "retry";
              });
            }
            return "retry";
          },
        )) ?? "complete"
      );
    },
    async assertSyntheticData() {
      const rows = await db.select().from(invoiceNotices);
      for (const row of rows)
        if (
          row.deploymentKey !== deploymentKey ||
          (row.recipient !== null && !allowRecipient(row.recipient))
        )
          throw new Error("Unexpected notice ownership or recipient");
    },
  };
}
