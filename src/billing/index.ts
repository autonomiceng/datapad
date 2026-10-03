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
export function createBillingReader(
  options: BillingReaderOptions,
): BillingReader {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(options.deploymentKey))
    throw new Error("Invalid billing deployment");
  return createReader(options);
}
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
