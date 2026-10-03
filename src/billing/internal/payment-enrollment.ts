import { billingEnrollmentScopes as scopes } from "./payment-scope-schema";
import { and, eq, desc } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Enrollment, EnrollmentScope } from "../payment-settings-contract";
import {
  billingEnrollments as enrollments,
  billingPaymentMethods as methods,
} from "./payment-settings-schema";
export async function currentEnrollment(
  tx: NodePgDatabase,
  deploymentKey: string,
  customerId: string,
) {
  const [row] = await tx
    .select()
    .from(enrollments)
    .where(
      and(
        eq(enrollments.deploymentKey, deploymentKey),
        eq(enrollments.customerId, customerId),
      ),
    )
    .orderBy(desc(enrollments.version))
    .limit(1);
  return row ?? null;
}
export async function enrollmentView(
  tx: NodePgDatabase,
  row: typeof enrollments.$inferSelect,
): Promise<Enrollment> {
  const selected = await tx
    .select()
    .from(scopes)
    .where(eq(scopes.enrollmentId, row.id))
    .orderBy(scopes.subscriptionId);
  return {
    id: row.id,
    version: row.version,
    predecessorId: row.predecessorId,
    decision: row.decision,
    paymentMethodId: row.paymentMethodId,
    acceptedAt: new Date(row.acceptedAt).toISOString(),
    termsVersion: row.termsVersion,
    scopes: selected.map(
      ({
        subscriptionId,
        commercialRevision,
        fromPeriodIndex,
        untilPeriodIndex,
        periodStart,
        dueDate,
        calendar,
      }) => ({
        subscriptionId,
        commercialRevision,
        fromPeriodIndex,
        untilPeriodIndex,
        periodStart,
        dueDate,
        calendar,
      }),
    ),
  };
}
export function covers(
  scope: EnrollmentScope,
  period: {
    subscriptionId: string;
    commercialRevision: number;
    periodIndex: number;
  },
) {
  return (
    scope.subscriptionId === period.subscriptionId &&
    scope.commercialRevision === period.commercialRevision &&
    scope.fromPeriodIndex <= period.periodIndex &&
    (scope.untilPeriodIndex === null ||
      period.periodIndex < scope.untilPeriodIndex)
  );
}
/** Caller holds the shared subscription lock; free billable lines need coverage too. */
export async function freezeEnrollment(
  tx: NodePgDatabase,
  deploymentKey: string,
  customerId: string,
  group: {
    paymentArrangement: "manual" | "automatic";
    totalMinor: number;
    periods: Array<{
      subscriptionId: string;
      commercialRevision: number;
      periodIndex: number;
      billingState: string;
    }>;
  },
  billingCustomerId: string | null,
): Promise<{ enrollmentId: string | null; paymentMethodId: string | null }> {
  const none = { enrollmentId: null, paymentMethodId: null };
  if (
    group.paymentArrangement !== "automatic" ||
    group.totalMinor <= 0 ||
    !billingCustomerId
  )
    return none;
  const row = await currentEnrollment(tx, deploymentKey, customerId);
  if (!row?.paymentMethodId) return none;
  const [method] = await tx
    .select()
    .from(methods)
    .where(
      and(
        eq(methods.id, row.paymentMethodId),
        eq(methods.billingCustomerId, billingCustomerId),
        eq(methods.customerId, customerId),
        eq(methods.deploymentKey, deploymentKey),
      ),
    );
  if (!method) return none;
  const enrollment = await enrollmentView(tx, row);
  const lines = group.periods.filter((p) => p.billingState === "billable");
  if (
    !lines.length ||
    !lines.every((p) => enrollment.scopes.some((s) => covers(s, p)))
  )
    return none;
  return { enrollmentId: row.id, paymentMethodId: row.paymentMethodId };
}
