import Stripe from "stripe";
import {
  BillingProviderError,
  type Lookup,
  type PaymentSettingsProvider,
  type PaymentSetupIntent,
  type ProviderOwnership,
  type ProviderPaymentSetup,
  type ProviderSavedPaymentMethod,
  type VerifiedPaymentSetupEvent,
} from "../billing/provider";

const keys = {
  deployment: "datapad_deployment",
  customer: "datapad_customer",
  setup: "datapad_setup",
};
const review = (reason: "ownership_mismatch" | "provider_conflict") =>
  new BillingProviderError("review", reason);
const objectId = (value: string | { id: string } | null) =>
  typeof value === "string" ? value : (value?.id ?? null);
const uuid = (value: string | undefined) =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

function metadata(intent: PaymentSetupIntent) {
  return {
    [keys.deployment]: intent.deploymentKey,
    [keys.customer]: intent.customerId,
    [keys.setup]: intent.setupId,
  };
}
function matches(
  actual: Stripe.Metadata | null,
  expected: Stripe.Metadata,
): actual is Stripe.Metadata {
  return (
    actual !== null &&
    Object.entries(expected).every(([key, value]) => actual[key] === value)
  );
}
function sessionStatus(
  value: Stripe.Checkout.Session["status"],
): ProviderPaymentSetup["status"] {
  switch (value) {
    case "open":
      return "open";
    case "complete":
      return "complete";
    case "expired":
      return "expired";
    default:
      throw review("provider_conflict");
  }
}
function setupStatus(value: Stripe.SetupIntent["status"]) {
  switch (value) {
    case "succeeded":
      return "succeeded";
    case "processing":
      return "processing";
    case "requires_action":
      return "requires_action";
    case "requires_payment_method":
      return "requires_payment_method";
    case "requires_confirmation":
      return "requires_confirmation";
    case "canceled":
      return "canceled";
    default:
      throw review("provider_conflict");
  }
}
function hostedUrl(value: string | null) {
  if (value === null) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw review("provider_conflict");
  }
  if (
    value.length > 4096 ||
    url.protocol !== "https:" ||
    url.hostname !== "checkout.stripe.com" ||
    url.username ||
    url.password ||
    url.port ||
    url.searchParams.has("client_secret") ||
    value.includes("_secret_")
  )
    throw review("provider_conflict");
  return value;
}
async function safe<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof BillingProviderError) throw error;
    if (error instanceof Stripe.errors.StripeError) {
      if (
        error.type === "StripeConnectionError" ||
        error.type === "StripeAPIError" ||
        error.type === "StripeRateLimitError" ||
        (error.statusCode ?? 0) >= 500
      )
        throw new BillingProviderError("retryable", "provider_conflict");
      throw review("provider_conflict");
    }
    throw new BillingProviderError("retryable", "provider_conflict");
  }
}

/** Composition supplies the same sandbox client whose account it already verified. */
export function createStripePaymentSettingsProvider(options: {
  stripe: Stripe;
  ownership: ProviderOwnership;
  maxPages: number;
}): PaymentSettingsProvider {
  const { stripe, ownership, maxPages } = options;
  function checkIntent(intent: PaymentSetupIntent) {
    if (
      intent.accountId !== ownership.accountId ||
      intent.deploymentKey !== ownership.deploymentKey ||
      !uuid(intent.setupId) ||
      !uuid(intent.customerId) ||
      !intent.providerCustomerId.startsWith("cus_") ||
      intent.currency !== "USD" ||
      !/^datapad_setup_[a-z]{8}$/.test(intent.integrationIdentifier)
    )
      throw review("ownership_mismatch");
  }
  async function checkCustomer(intent: PaymentSetupIntent) {
    checkIntent(intent);
    const customer = await stripe.customers.retrieve(intent.providerCustomerId);
    if (
      customer.deleted ||
      customer.object !== "customer" ||
      customer.id !== intent.providerCustomerId ||
      customer.livemode !== false ||
      !matches(customer.metadata, {
        [keys.deployment]: intent.deploymentKey,
        [keys.customer]: intent.customerId,
      })
    )
      throw review("ownership_mismatch");
  }
  async function snapshot(
    intent: PaymentSetupIntent,
    sessionId: string,
  ): Promise<ProviderPaymentSetup> {
    if (!sessionId.startsWith("cs_test_")) throw review("ownership_mismatch");
    // Create/list responses and expanded resources are never completion proof.
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (
      session.id !== sessionId ||
      session.object !== "checkout.session" ||
      session.livemode !== false ||
      session.mode !== "setup" ||
      objectId(session.customer) !== intent.providerCustomerId ||
      !matches(session.metadata, metadata(intent)) ||
      session.currency !== "usd" ||
      session.success_url !== intent.successUrl ||
      session.cancel_url !== intent.cancelUrl ||
      session.integration_identifier !== intent.integrationIdentifier ||
      session.allowed_payment_method_types?.length !== 1 ||
      session.allowed_payment_method_types[0] !== "card"
    )
      throw review("ownership_mismatch");
    const status = sessionStatus(session.status);
    const checkoutUrl = hostedUrl(session.url);
    let setupIntent: ProviderPaymentSetup["setupIntent"] = null;
    const setupIntentId = objectId(session.setup_intent);
    if (setupIntentId) {
      if (!setupIntentId.startsWith("seti_"))
        throw review("ownership_mismatch");
      const observed = await stripe.setupIntents.retrieve(setupIntentId);
      if (
        observed.id !== setupIntentId ||
        observed.object !== "setup_intent" ||
        observed.livemode !== false ||
        observed.on_behalf_of != null ||
        objectId(observed.customer) !== intent.providerCustomerId ||
        !matches(observed.metadata, metadata(intent))
      )
        throw review("ownership_mismatch");
      const methodId = objectId(observed.payment_method);
      if (methodId && !methodId.startsWith("pm_"))
        throw review("ownership_mismatch");
      if (
        typeof session.setup_intent === "object" &&
        session.setup_intent !== null &&
        objectId(session.setup_intent.payment_method) !== methodId
      )
        throw review("ownership_mismatch");
      const siStatus = setupStatus(observed.status);
      const usage = observed.usage;
      if (usage !== "off_session" && usage !== "on_session")
        throw review("provider_conflict");
      setupIntent = {
        providerSetupIntentId: observed.id,
        deploymentKey: observed.metadata[keys.deployment],
        setupId: observed.metadata[keys.setup],
        providerCustomerId: intent.providerCustomerId,
        livemode: false,
        status: siStatus,
        usage,
        providerPaymentMethodId: methodId,
      };
    } else if (status === "complete") {
      throw review("provider_conflict");
    }
    return {
      ...intent,
      livemode: false,
      providerSessionId: session.id,
      status,
      checkoutUrl,
      setupIntent,
    };
  }
  return {
    ownership,
    createSetup: (intent, effect) =>
      safe(async () => {
        await checkCustomer(intent);
        const session = await stripe.checkout.sessions.create(
          {
            mode: "setup",
            currency: "usd",
            customer: intent.providerCustomerId,
            allowed_payment_method_types: ["card"],
            success_url: intent.successUrl,
            cancel_url: intent.cancelUrl,
            integration_identifier: intent.integrationIdentifier,
            metadata: metadata(intent),
            setup_intent_data: { metadata: metadata(intent) },
          },
          { idempotencyKey: effect.idempotencyKey },
        );
        return snapshot(intent, session.id);
      }),
    retrieveSetup: (intent, sessionId) =>
      safe(async () => {
        await checkCustomer(intent);
        return snapshot(intent, sessionId);
      }),
    findSetup: (intent) =>
      safe(async (): Promise<Lookup<ProviderPaymentSetup>> => {
        await checkCustomer(intent);
        let cursor: string | undefined;
        let candidate: string | undefined;
        const seen = new Set<string>();
        // A bounded incomplete traversal cannot establish absence or uniqueness.
        for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
          const page = await stripe.checkout.sessions.list({
            customer: intent.providerCustomerId,
            limit: 100,
            ...(cursor ? { starting_after: cursor } : {}),
          });
          for (const session of page.data) {
            if (seen.has(session.id)) return { kind: "ambiguous" };
            seen.add(session.id);
            // Same setup identity with altered parameters must fail validation.
            if (
              !matches(session.metadata, {
                [keys.deployment]: intent.deploymentKey,
                [keys.setup]: intent.setupId,
              })
            )
              continue;
            if (candidate) return { kind: "ambiguous" };
            candidate = session.id;
          }
          if (!page.has_more)
            return candidate
              ? { kind: "found", value: await snapshot(intent, candidate) }
              : { kind: "absent" };
          cursor = page.data.at(-1)?.id;
          if (!cursor) return { kind: "ambiguous" };
        }
        return { kind: "ambiguous" };
      }),
    retrieveSavedMethod: (intent, methodId) =>
      safe(async (): Promise<ProviderSavedPaymentMethod> => {
        await checkCustomer(intent);
        if (!methodId.startsWith("pm_")) throw review("ownership_mismatch");
        const observed = await stripe.paymentMethods.retrieve(methodId);
        const customerId = objectId(observed.customer);
        if (
          observed.id !== methodId ||
          observed.object !== "payment_method" ||
          observed.livemode !== false ||
          (customerId !== null && customerId !== intent.providerCustomerId)
        )
          throw review("ownership_mismatch");
        let card: ProviderSavedPaymentMethod["card"] = null;
        if (observed.type === "card") {
          const value = observed.card;
          if (
            !value ||
            !/^[a-z0-9_ -]{1,32}$/i.test(value.brand) ||
            !/^\d{4}$/.test(value.last4) ||
            !Number.isInteger(value.exp_month) ||
            value.exp_month < 1 ||
            value.exp_month > 12 ||
            !Number.isInteger(value.exp_year) ||
            value.exp_year < 2000 ||
            value.exp_year > 9999
          )
            throw review("provider_conflict");
          card = {
            brand: value.brand,
            last4: value.last4,
            expiryMonth: value.exp_month,
            expiryYear: value.exp_year,
          };
        }
        return {
          ...ownership,
          providerPaymentMethodId: observed.id,
          providerCustomerId: customerId,
          livemode: false,
          type: observed.type === "card" ? "card" : "unsupported",
          card,
        };
      }),
  };
}

/** Call only after the shared verifier checks the raw signature, account and mode. */
export function normalizeStripePaymentSetupEvent(
  event: Stripe.Event,
  ownership: ProviderOwnership,
): VerifiedPaymentSetupEvent | null {
  if (event.type !== "checkout.session.completed") return null;
  const session = event.data.object;
  if (
    event.livemode !== false ||
    (event.account && event.account !== ownership.accountId) ||
    event.context ||
    !event.id.startsWith("evt_") ||
    session.object !== "checkout.session" ||
    session.livemode !== false ||
    !session.id.startsWith("cs_test_")
  )
    throw review("ownership_mismatch");
  if (session.mode !== "setup") return null;
  if (session.status !== "complete") throw review("provider_conflict");
  const owned = session.metadata?.[keys.deployment] === ownership.deploymentKey;
  return {
    ...ownership,
    eventId: event.id,
    providerSessionId: session.id,
    setupId:
      owned &&
      uuid(session.metadata?.[keys.customer]) &&
      uuid(session.metadata?.[keys.setup])
        ? session.metadata![keys.setup]
        : null,
  };
}
