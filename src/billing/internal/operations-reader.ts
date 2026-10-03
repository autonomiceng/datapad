import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type {
  BillingEffectScope,
  BillingOperation,
} from "../operations-contract";

export async function readProviderOperations(
  tx: NodePgDatabase,
  deploymentKey: string,
  now: Date,
  scope?: BillingEffectScope,
): Promise<BillingOperation[]> {
  const result = await tx.execute<{
    kind: BillingEffectScope["kind"];
    id: string;
    customer_id: string;
    invoice_id: string | null;
    customer_label: string;
    label: string;
    state: string;
    reason: string | null;
    created_at: string;
    attempted_at: string | null;
    last_checked_at: string | null;
    next_eligible_at: string | null;
  }>(sql`
    with effects as (
      select 'customer' as kind, c.id, c.customer_id, null::uuid as invoice_id, c.name as customer_label,
        'Billing customer' as label,
        case when c.provider_customer_id is null and c.create_attempted_at<=${new Date(now.getTime() - 23 * 60 * 60 * 1000).toISOString()}::timestamptz then 'needs_review' else 'pending' end as state,
        case when c.provider_customer_id is null and c.create_attempted_at<=${new Date(now.getTime() - 23 * 60 * 60 * 1000).toISOString()}::timestamptz then 'uncertain_customer' else null end as reason,
        c.created_at, c.create_attempted_at as attempted_at, null::timestamptz as last_checked_at, null::timestamptz as next_eligible_at,
        c.provider_customer_id is null as unfinished
      from billing_customers c where c.deployment_key=${deploymentKey}
      union all
      select 'invoice', i.id, c.customer_id, i.id, i.bill_to_name, 'Invoice creation', i.state, i.review_reason,
        i.created_at, i.create_attempted_at, i.last_checked_at, i.next_attempt_at,
        i.issue_requested_at is not null and (i.provider_invoice_id is null or i.state='needs_review')
      from invoices i join billing_customers c on c.id=i.billing_customer_id where i.deployment_key=${deploymentKey}
      union all
      select 'finalize', i.id, c.customer_id, i.id, i.bill_to_name, 'Invoice finalization', i.state, i.review_reason,
        i.created_at, i.finalize_attempted_at, i.last_checked_at, i.next_attempt_at,
        i.issue_requested_at is not null and i.provider_invoice_id is not null and i.provider_status='draft'
      from invoices i join billing_customers c on c.id=i.billing_customer_id where i.deployment_key=${deploymentKey}
      union all
      select 'line', l.id, c.customer_id, i.id, i.bill_to_name, 'Invoice line ' || (l.position+1), i.state, i.review_reason,
        i.created_at, l.create_attempted_at, i.last_checked_at, i.next_attempt_at,
        i.issue_requested_at is not null and i.provider_status='draft' and l.provider_line_id is null
      from invoice_lines l join invoices i on i.id=l.invoice_id join billing_customers c on c.id=i.billing_customer_id where i.deployment_key=${deploymentKey}
      union all
      select 'setup', s.id, s.customer_id, null::uuid, c.name, 'Payment setup',
        case when s.attempts>=5 then 'needs_review' else s.status end, null::text,
        s.accepted_at, s.create_attempted_at, s.last_checked_at, s.next_attempt_at, s.status in ('pending','needs_review')
      from billing_payment_setups s join billing_customers c on c.id=s.billing_customer_id where s.deployment_key=${deploymentKey}
      union all
      select 'resolution', r.id, r.customer_id, r.invoice_id, i.bill_to_name,
        case when r.kind='void' then 'Invoice void' else 'External payment' end,
        r.state, r.review_reason, r.created_at, r.attempted_at, r.last_checked_at, r.next_attempt_at, r.state in ('pending','needs_review')
      from billing_invoice_resolutions r join invoices i on i.id=r.invoice_id where r.deployment_key=${deploymentKey}
      union all
      select 'collection', a.id, a.customer_id, a.invoice_id, i.bill_to_name, 'Invoice collection',
        case when a.state in ('failed','requires_action') then 'needs_review' else a.state end,
        a.reason, a.first_attempted_at, a.first_attempted_at, a.last_checked_at, a.next_attempt_at,
        a.state in ('pending','processing','needs_review','failed','requires_action')
      from billing_payment_attempts a join invoices i on i.id=a.invoice_id where a.deployment_key=${deploymentKey}
    )
    select kind, id, customer_id, invoice_id, customer_label, label, state, reason,
      created_at::text, attempted_at::text, last_checked_at::text, next_eligible_at::text
    from effects where ${scope ? sql`kind=${scope.kind} and id=${scope.effectId}::uuid and customer_id=${scope.customerId}::uuid` : sql`unfinished`}
    order by created_at, kind, id limit 100
  `);
  return result.rows.map((row) => {
    const iso = (value: unknown) =>
      typeof value === "string" ? new Date(value).toISOString() : null;
    const attemptedAt = iso(row.attempted_at),
      nextEligibleAt = iso(row.next_eligible_at);
    const operation: BillingOperation = {
      effect: { kind: row.kind, customerId: row.customer_id, effectId: row.id },
      customerLabel: row.customer_label,
      label: row.label,
      invoiceId: row.invoice_id,
      state:
        row.state === "needs_review"
          ? "needs_review"
          : attemptedAt &&
              now.getTime() >=
                Date.parse(nextEligibleAt ?? attemptedAt) +
                  (nextEligibleAt ? 0 : 30000)
            ? "stalled"
            : "pending",
      reason: row.reason,
      createdAt: new Date(row.created_at).toISOString(),
      attemptedAt,
      lastCheckedAt: iso(row.last_checked_at),
      nextEligibleAt,
      canCheckStatus: attemptedAt !== null || row.invoice_id !== null,
    };
    return operation;
  });
}
