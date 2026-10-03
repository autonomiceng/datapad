import { Temporal } from "@js-temporal/polyfill";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import type { Access } from "../access";
import type { Customers } from "../customers";
import { createSubscriptions, type SubscriptionPolicy } from "../billing";
import type {
  CalendarPolicy,
  SubscriptionOptionsResponse,
} from "../billing/subscriptions-contract";
import type { SubscriptionHttp } from "./subscription-routes";
import { portalServicePolicy } from "./portal-services";

const cancellationReasons = [
  "Customer requested cancellation",
  "Cancellation confirmed",
  "Continue the agreement",
];
export async function createPortalSubscriptions(options: {
  pool: Pool;
  deploymentKey: string;
  customers: Customers;
  access: Access;
  customerIds: { elm: string; birch: string };
  origin: string;
  calendar?: CalendarPolicy;
  now?: () => Date;
}): Promise<{
  http: SubscriptionHttp;
  allowSubscription: SubscriptionPolicy;
  choices: (customerId: string) => SubscriptionOptionsResponse["choices"];
  calendar: CalendarPolicy;
}> {
  const { pool, deploymentKey, customers, access, customerIds, origin } =
    options;
  const calendar = options.calendar ?? {
    timeZone: "UTC",
    issueHour: 9,
    chargeHour: 9,
  };
  const manifest = portalServicePolicy(customerIds).manifest;
  const choices = (
    customerId: string,
  ): SubscriptionOptionsResponse["choices"] => {
    if (!Object.values(customerIds).includes(customerId)) return [];
    const records = manifest.services.filter(
      (service) => service.customerId === customerId,
    );
    const hosting = records.find((service) =>
      service.sourceKey.endsWith("-hosting"),
    );
    const storage = records.find((service) =>
      service.sourceKey.endsWith("-storage"),
    );
    const terms = [
      ...(hosting
        ? [
            { serviceId: hosting.id, label: "Web hosting", amountMinor: 2300 },
            { serviceId: hosting.id, label: "Web hosting", amountMinor: 2500 },
            { serviceId: hosting.id, label: "Web hosting", amountMinor: 0 },
          ]
        : []),
      ...(storage
        ? [{ serviceId: storage.id, label: "Storage add-on", amountMinor: 500 }]
        : []),
      { serviceId: null, label: "Consulting", amountMinor: 10000 },
      { serviceId: null, label: "Consulting", amountMinor: 12000 },
    ];
    return terms.flatMap((term) =>
      ([1, 3, 6, 12, 24, 36] as const).flatMap((intervalMonths) =>
        (["manual", "automatic"] as const).map((paymentArrangement) => ({
          ...term,
          intervalMonths,
          paymentArrangement,
        })),
      ),
    );
  };
  const allowSubscription: SubscriptionPolicy = (subscription) =>
    (subscription.cancellationReason === null ||
      cancellationReasons.includes(subscription.cancellationReason)) &&
    subscription.calendar.timeZone === calendar.timeZone &&
    subscription.calendar.issueHour === calendar.issueHour &&
    subscription.calendar.chargeHour === calendar.chargeHour &&
    choices(subscription.customerId).some(
      (choice) =>
        choice.serviceId === subscription.serviceId &&
        choice.label === subscription.label &&
        choice.amountMinor === subscription.amountMinor &&
        choice.intervalMonths === subscription.intervalMonths &&
        choice.paymentArrangement === subscription.paymentArrangement,
    );
  const subscriptions = createSubscriptions({
    pool,
    deploymentKey,
    authorizeCustomer: customers.authorizeCustomer.bind(customers),
    audit: access.audit,
    calendar,
    allowSubscription,
    now: options.now,
  });
  await subscriptions.assertSyntheticData();
  const http: SubscriptionHttp = {
    subscriptions,
    access,
    origin,
    async readOptions(actor, customerId) {
      const authorization = await customers.authorizeCustomer(
        drizzle(pool),
        actor,
        customerId,
        "manage_billing",
        false,
      );
      if (!authorization.ok) return authorization;
      const anchor = Temporal.Instant.from(
        (options.now?.() ?? new Date()).toISOString(),
      )
        .toZonedDateTimeISO(calendar.timeZone)
        .toPlainDate()
        .add({ months: 1 })
        .toString();
      return {
        ok: true,
        value: {
          choices: choices(customerId),
          cancellationReasons,
          calendar,
          periodAnchorDate: anchor,
          dueAnchorDate: anchor,
        },
      };
    },
  };
  return { http, allowSubscription, choices, calendar };
}
