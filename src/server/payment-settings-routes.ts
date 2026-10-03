import { Elysia, status, t } from "elysia";
import { accessErrorResponses, accessResponse } from "./access-response";
import type { Access } from "../access/types";
import {
  PaymentSettingsResponseSchema,
  StartPaymentSetupRequestSchema,
  RefreshPaymentSetupRequestSchema,
  PaymentSetupResponseSchema,
  ReplaceEnrollmentRequestSchema,
  ReduceEnrollmentRequestSchema,
  ChangeEnrollmentResponseSchema,
} from "../billing/payment-settings-contract";
import type { PaymentSettings } from "../billing/payment-settings-types";

export interface PaymentSettingsHttp {
  access: Pick<Access, "resolveActor">;
  paymentSettings: Pick<
    PaymentSettings,
    | "getPaymentSettings"
    | "startSetup"
    | "refreshSetup"
    | "replaceEnrollment"
    | "reduceEnrollment"
  >;
  origin: string;
}

const customerParams = t.Object(
  { customerId: t.String({ format: "uuid" }) },
  { additionalProperties: false },
);
const setupParams = t.Object(
  {
    ...customerParams.properties,
    setupId: t.String({ format: "uuid" }),
  },
  { additionalProperties: false },
);
const empty = t.Object({}, { additionalProperties: false });

export function paymentSettingsRoutes(config?: PaymentSettingsHttp) {
  const browserMutation = ({ request }: { request: Request }) => {
    if (!config) return status(503, { code: "unavailable" });
    if (request.headers.get("origin") !== config.origin)
      return status(403, { code: "forbidden" });
    if (
      request.headers
        .get("content-type")
        ?.split(";")[0]
        ?.trim()
        .toLowerCase() !== "application/json"
    )
      return status(422, { code: "invalid_request" });
  };
  return new Elysia({ normalize: false })
    .onRequest(({ set }) => {
      set.headers["cache-control"] = "no-store";
    })
    .onError(({ code }) => {
      if (code === "VALIDATION" || code === "PARSE")
        return status(422, { code: "invalid_request" });
      if (code === "NOT_FOUND") return status(404, { code: "not_found" });
      return status(503, { code: "unavailable" });
    })
    .resolve(async ({ request }) => {
      if (!config) return status(503, { code: "unavailable" });
      const actor = await config.access.resolveActor(request.headers);
      if (!actor) return status(401, { code: "unauthenticated" });
      return { actor, config };
    })
    .get(
      "/api/customers/:customerId/payment-settings",
      async ({ actor, config, params }) =>
        accessResponse(
          await config.paymentSettings.getPaymentSettings(
            actor,
            params.customerId,
          ),
        ),
      {
        params: customerParams,
        query: empty,
        response: {
          200: PaymentSettingsResponseSchema,
          ...accessErrorResponses,
        },
        detail: {
          operationId: "getCustomerPaymentSettings",
          summary: "Read saved cards and automatic payment consent",
        },
      },
    )
    .post(
      "/api/customers/:customerId/payment-setups",
      async ({ actor, config, params, body }) =>
        accessResponse(
          await config.paymentSettings.startSetup(
            actor,
            params.customerId,
            body,
          ),
        ),
      {
        params: customerParams,
        query: empty,
        body: StartPaymentSetupRequestSchema,
        parse: "json",
        beforeHandle: browserMutation,
        response: { 200: PaymentSetupResponseSchema, ...accessErrorResponses },
        detail: {
          operationId: "startCustomerPaymentSetup",
          summary: "Record save permission and start hosted card setup",
        },
      },
    )
    .post(
      "/api/customers/:customerId/payment-setups/:setupId/refresh",
      async ({ actor, config, params }) =>
        accessResponse(
          await config.paymentSettings.refreshSetup(
            actor,
            params.customerId,
            params.setupId,
          ),
        ),
      {
        params: setupParams,
        query: empty,
        body: RefreshPaymentSetupRequestSchema,
        parse: "json",
        beforeHandle: browserMutation,
        response: { 200: PaymentSetupResponseSchema, ...accessErrorResponses },
        detail: {
          operationId: "refreshCustomerPaymentSetup",
          summary: "Verify a customer-scoped local card setup",
        },
      },
    )
    .post(
      "/api/customers/:customerId/automatic-payment-enrollment",
      async ({ actor, config, params, body }) =>
        accessResponse(
          await config.paymentSettings.replaceEnrollment(
            actor,
            params.customerId,
            body,
          ),
        ),
      {
        params: customerParams,
        query: empty,
        body: ReplaceEnrollmentRequestSchema,
        parse: "json",
        beforeHandle: browserMutation,
        response: {
          200: ChangeEnrollmentResponseSchema,
          ...accessErrorResponses,
        },
        detail: {
          operationId: "replaceCustomerAutomaticPaymentEnrollment",
          summary: "Confirm a saved card and selected agreement scope",
        },
      },
    )
    .post(
      "/api/customers/:customerId/automatic-payment-enrollment/reduce",
      async ({ actor, config, params, body }) =>
        accessResponse(
          await config.paymentSettings.reduceEnrollment(
            actor,
            params.customerId,
            body,
          ),
        ),
      {
        params: customerParams,
        query: empty,
        body: ReduceEnrollmentRequestSchema,
        parse: "json",
        beforeHandle: browserMutation,
        response: {
          200: ChangeEnrollmentResponseSchema,
          ...accessErrorResponses,
        },
        detail: {
          operationId: "reduceCustomerAutomaticPaymentEnrollment",
          summary: "Immediately reduce or stop automatic payment consent",
        },
      },
    );
}
