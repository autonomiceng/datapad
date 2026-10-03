import { Temporal } from "@js-temporal/polyfill";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import type { Access } from "../access";
import { createCustomerRegistry, type Customers } from "../customers";
import {
  createBilling,
  createBillingWorkflow,
  createScheduledBilling,
  createInvoiceResolutions,
  createInvoiceCollections,
  type SyntheticScheduledInvoice,
  type BillingReader,
  type SyntheticInvoicePolicy,
} from "../billing";
import {
  createStripeBillingProvider,
  createStripeEventVerifier,
} from "../stripe";
import { BillingProviderError } from "../billing/provider";
import type {
  VerifiedInvoiceEvent,
  VerifiedPaymentSetupEvent,
} from "../billing/provider";
import type { createPortalSubscriptions } from "./portal-subscriptions";
import type { InvoiceWorkflowHttp } from "./invoice-workflow-routes";
import {
  allowPortalProfile,
  portalCustomers,
  portalDeploymentKey,
} from "./portal-demo";

import { createPortalPaymentSettings } from "./portal-payment-settings";

const sampleLines = [
  { description: "Web hosting", amountMinor: 2300 },
  { description: "Storage add-on", amountMinor: 500 },
  { description: "Consulting", amountMinor: 10000 },
];

export async function createPortalBilling(options: {
  pool: Pool;
  reader: BillingReader;
  customers: Customers;
  access: Access;
  customerIds: Record<"elm" | "birch", string>;
  origin: string;
  subscriptionPolicy: Pick<
    Awaited<ReturnType<typeof createPortalSubscriptions>>,
    "allowSubscription" | "choices" | "calendar"
  >;
  /** Business calendar only. Manual dates and provider effects use wall time. */
  now?: () => Date;
  configuration?: {
    deploymentKey: string;
    apiKey: string;
    signingSecret: string;
  };
}) {
  const {
    pool,
    reader,
    customers,
    access,
    customerIds,
    configuration,
    origin,
    subscriptionPolicy,
    now,
  } = options;
  const allowRequest: SyntheticInvoicePolicy = ({
    request,
    customerId,
    billTo,
  }) => {
    const sample = portalCustomers.find(
      (entry) => customerIds[entry.key as "elm" | "birch"] === customerId,
    );
    if (!sample) return false;
    const names = [sample.name, sample.updatedName];
    return (
      /^staff:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        request.originKey,
      ) &&
      request.customer.key === `customer:${customerId}` &&
      names.includes(request.customer.name) &&
      names.includes(billTo.legalName) &&
      (billTo.billingEmail === null ||
        billTo.billingEmail === sample.billingEmail) &&
      request.currency === "USD" &&
      request.lines.length > 0 &&
      request.lines.length <= sampleLines.length &&
      new Set(request.lines.map((line) => line.description)).size ===
        request.lines.length &&
      request.lines.every(
        (line) =>
          line.originRef === null &&
          sampleLines.some(
            (sampleLine) =>
              sampleLine.description === line.description &&
              sampleLine.amountMinor === line.amountMinor,
          ),
      )
    );
  };
  const allowScheduledRequest = ({
    request,
    customerId,
    billTo,
  }: SyntheticScheduledInvoice) => {
    const sample = portalCustomers.find(
      (entry) => customerIds[entry.key as "elm" | "birch"] === customerId,
    );
    if (!sample) return false;
    const names = [sample.name, sample.updatedName];
    const choices = subscriptionPolicy.choices(customerId);
    const calendar = subscriptionPolicy.calendar;
    return (
      /^scheduled:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        request.originKey,
      ) &&
      request.customer.key === `customer:${customerId}` &&
      names.includes(request.customer.name) &&
      names.includes(billTo.legalName) &&
      (billTo.billingEmail === null ||
        billTo.billingEmail === sample.billingEmail) &&
      request.currency === "USD" &&
      request.calendar.timeZone === calendar.timeZone &&
      request.calendar.issueHour === calendar.issueHour &&
      request.calendar.chargeHour === calendar.chargeHour &&
      request.lines.length > 0 &&
      request.lines.length <= 100 &&
      new Set(request.lines.map((line) => line.originRef)).size ===
        request.lines.length &&
      request.lines.every(
        (line) =>
          line.originRef !== null &&
          choices.some(
            (choice) =>
              choice.label === line.description &&
              choice.amountMinor === line.amountMinor,
          ),
      )
    );
  };
  const storedAccountId = await reader.storedProviderAccountId();
  let provider:
    | Awaited<ReturnType<typeof createStripeBillingProvider>>
    | undefined;
  if (configuration) {
    try {
      provider = await createStripeBillingProvider({
        apiKey: configuration.apiKey,
        deploymentKey: configuration.deploymentKey,
        ...(storedAccountId ? { accountId: storedAccountId } : {}),
      });
    } catch (error) {
      if (
        !(error instanceof BillingProviderError) ||
        error.kind !== "retryable"
      )
        throw error;
      // Local reads and consent reductions use the previously verified stored identity.
    }
  }
  const deploymentKey = configuration?.deploymentKey ?? portalDeploymentKey;
  const accountId = provider?.ownership.accountId ?? storedAccountId;
  const allowMappingName = (customerId: string, name: string) => {
    const sample = portalCustomers.find(
      (entry) => customerIds[entry.key as "elm" | "birch"] === customerId,
    );
    return !!sample && [sample.name, sample.updatedName].includes(name);
  };
  const payments = await createPortalPaymentSettings({
    pool,
    deploymentKey,
    provider: provider ?? null,
    providerOwnership: accountId ? { deploymentKey, accountId } : null,
    customers,
    access,
    allowSubscription: subscriptionPolicy.allowSubscription,
    allowMappingName,
    origin,
  });
  await reader.assertSyntheticPolicy(
    allowRequest,
    accountId ?? undefined,
    allowScheduledRequest,
    (mapping) =>
      payments.validatedMappingIds.has(mapping.id) &&
      mapping.key === `customer:${mapping.customerId}` &&
      allowMappingName(mapping.customerId, mapping.name),
  );
  const billingOptions =
    provider && configuration
      ? {
          pool,
          provider,
          resolutionProvider: provider,
          collectionProvider: provider,
          deploymentKey: configuration.deploymentKey,
          businessNow: now,
          customers: createCustomerRegistry({
            operatorId: "synthetic-portal-invoices",
            audit: access.audit,
            allowProfile: allowPortalProfile,
          }),
        }
      : undefined;
  const commands = billingOptions ? createBilling(billingOptions) : undefined;
  const scheduled =
    provider && configuration
      ? createScheduledBilling({
          pool,
          deploymentKey: configuration.deploymentKey,
          providerOwnership: provider.ownership,
          customerAccess: customers,
          audit: access.audit,
          workerId: "synthetic-scheduled-billing",
          allowSubscription: subscriptionPolicy.allowSubscription,
          allowRequest: allowScheduledRequest,
          now,
        })
      : undefined;
  await scheduled?.assertSyntheticData();
  const resolutions =
    provider && configuration
      ? createInvoiceResolutions({
          pool,
          deploymentKey: configuration.deploymentKey,
          resolutionProvider: provider,
          customerAccess: customers,
          audit: access.audit,
          workerId: "synthetic-invoice-resolutions",
          allowResolution(resolution) {
            if (!Object.values(customerIds).includes(resolution.customerId))
              return false;
            if (resolution.kind === "external_payment")
              return resolution.input.reference === "Sample external payment";
            return (
              resolution.input.reason ===
              (resolution.kind === "void"
                ? "Sample invoice void"
                : "Sample receipt correction")
            );
          },
        })
      : undefined;
  await resolutions?.assertSyntheticData();
  const invoiceCollections =
    provider && configuration
      ? createInvoiceCollections({
          pool,
          deploymentKey: configuration.deploymentKey,
          provider,
          audit: access.audit,
          workerId: "synthetic-invoice-collections",
          businessNow: now,
        })
      : undefined;
  await invoiceCollections?.assertSyntheticData();
  const workflow = billingOptions
    ? createBillingWorkflow({
        ...billingOptions,
        invoiceCollections,
        customerAccess: customers,
        audit: access.audit,
        allowRequest,
      })
    : undefined;
  const http: InvoiceWorkflowHttp = {
    access,
    workflow,
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
      const issueDate = Temporal.Instant.from(new Date().toISOString())
        .toZonedDateTimeISO("UTC")
        .toPlainDate();
      return {
        ok: true,
        value: {
          available: Boolean(workflow),
          lines: sampleLines,
          issueDate: issueDate.toString(),
          dueDate: issueDate.add({ days: 21 }).toString(),
        },
      };
    },
  };
  return {
    paymentSettings: payments.paymentSettings,
    paymentSettingsHttp: payments.http,
    resolutions,
    invoiceCollections,
    scheduled,
    commands,
    http,
    webhook:
      provider && configuration && commands
        ? {
            verifier: createStripeEventVerifier({
              signingSecret: configuration.signingSecret,
              ownership: provider.ownership,
            }),
            acceptSetupEvent: (event: VerifiedPaymentSetupEvent) =>
              payments.paymentSettings.receiveSetupEvent(event),
            acceptEvent: (event: VerifiedInvoiceEvent) =>
              commands.acceptEvent(event),
          }
        : undefined,
  };
}
