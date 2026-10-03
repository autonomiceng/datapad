import type {
  Billing,
  BillingOptions,
  BillingReader,
  BillingReaderOptions,
} from "./types";
import { createReader } from "./internal/queries";
import { createRequester } from "./internal/requests";
import { createLifecycle } from "./internal/lifecycle";

export type * from "./types";
/**
 * Construct deployment-scoped local invoice reads; callers supply
 * authorization and deploymentKey must be a bounded identifier.
 */
export function createBillingReader(
  options: BillingReaderOptions,
): BillingReader {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(options.deploymentKey))
    throw new Error("Invalid billing deployment");
  return createReader(options);
}
/**
 * Compose immutable request staging and recoverable provider work; reject
 * missing account ownership or a mismatched deployment.
 */
export function createBilling(options: BillingOptions): Billing {
  if (
    options.deploymentKey !== options.provider.ownership.deploymentKey ||
    !options.provider.ownership.accountId
  )
    throw new Error("Billing provider ownership differs from deployment");
  return {
    ...createBillingReader(options),
    requestInvoice: createRequester(options),
    ...createLifecycle(options),
  };
}

export { createBillingWorkflow } from "./internal/workflow";
export { createSubscriptions } from "./internal/subscriptions";
export type * from "./subscriptions-types";

export { createScheduledBilling } from "./internal/scheduled";
export type * from "./scheduled-types";

export { createPaymentSettings } from "./internal/payment-settings";
export type * from "./payment-settings-types";

export { createCustomerReceipt } from "./internal/customer-receipt";
export { createInvoiceResolutions } from "./internal/resolutions";
export type * from "./resolutions-types";

export { createInvoiceCollections } from "./internal/collection";
export type * from "./collection-types";
