import type { Pool } from "pg";
import type { Access } from "../access";
import type { Customers } from "../customers";
import { createCustomerReceipt, createPaymentSettings } from "../billing";
import type {
  BillingProvider,
  PaymentSettingsProvider,
  ProviderOwnership,
} from "../billing/provider";
import type { SubscriptionPolicy } from "../billing/subscriptions-types";
import type { PaymentSettingsHttp } from "./payment-settings-routes";
import { allowPortalProfile } from "./portal-demo";

export async function createPortalPaymentSettings(options: {
  pool: Pool;
  deploymentKey: string;
  provider: (BillingProvider & PaymentSettingsProvider) | null;
  providerOwnership: ProviderOwnership | null;
  customers: Customers;
  access: Access;
  allowSubscription: SubscriptionPolicy;
  allowMappingName: (customerId: string, name: string) => boolean;
  origin: string;
}) {
  const {
    pool,
    deploymentKey,
    provider,
    providerOwnership,
    customers,
    access,
    allowSubscription,
    allowMappingName,
    origin,
  } = options;
  const paymentSettings = createPaymentSettings({
    pool,
    deploymentKey,
    providerOwnership,
    provider,
    customerAccess: customers,
    audit: access.audit,
    allowProfile: allowPortalProfile,
    allowMappingName,
    allowSubscription,
    successUrl: `${origin}/payment-settings/return`,
    cancelUrl: `${origin}/payment-settings/return`,
    ensureCustomerReceipt: provider
      ? createCustomerReceipt({ provider, deploymentKey })
      : async () => {
          throw new Error("Payment provider unavailable.");
        },
  });
  const validatedMappingIds = await paymentSettings.assertSyntheticData();
  const http: PaymentSettingsHttp = { access, paymentSettings, origin };
  return { paymentSettings, http, validatedMappingIds };
}
