import type { Pool } from "pg";
import { createBilling, createBillingReader } from "../billing";
import {
  createStripeBillingProvider,
  createStripeEventVerifier,
} from "../stripe";
import { demoInvoice } from "./billing-demo";

export async function createBillingRuntime(pool: Pool) {
  const values = [
    process.env.BILLING_DEPLOYMENT_KEY,
    process.env.BILLING_ISSUE_DATE,
    process.env.STRIPE_SECRET_KEY,
    process.env.STRIPE_WEBHOOK_SECRET,
  ];
  if (values.every((value) => !value)) {
    const reader = createBillingReader({ pool, deploymentKey: "local-demo" });
    await reader.assertSyntheticData([]);
    return {
      reader,
      commands: undefined,
      webhook: undefined,
      request: undefined,
    };
  }
  const [deploymentKey, issueDate, apiKey, signingSecret] = values;
  if (
    !deploymentKey ||
    !issueDate ||
    !apiKey ||
    !signingSecret ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      deploymentKey,
    ) ||
    !apiKey.startsWith("sk_test_") ||
    !signingSecret.startsWith("whsec_")
  )
    throw new Error("Incomplete or invalid sandbox billing configuration.");
  const request = demoInvoice(issueDate);
  const provider = await createStripeBillingProvider({ apiKey, deploymentKey });
  const billing = createBilling({ pool, provider, deploymentKey });
  await billing.assertSyntheticData([request], provider.ownership.accountId);
  return {
    reader: billing,
    commands: billing,
    request,
    webhook: {
      verifier: createStripeEventVerifier({
        signingSecret,
        ownership: provider.ownership,
      }),
      acceptEvent: (
        event: import("../billing/provider").VerifiedInvoiceEvent,
      ) => billing.acceptEvent(event),
    },
  };
}
