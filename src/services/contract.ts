import { Type, type Static, type TProperties } from "@sinclair/typebox";
import { AccountPaginationSchema } from "../access/contract";
const object = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const id = Type.String({ format: "uuid" });
const label = Type.String({ minLength: 1, maxLength: 256 });
const hostname = Type.String({ minLength: 1, maxLength: 253 });
export const ServiceKindSchema = Type.Union([
  Type.Literal("hosting"),
  Type.Literal("addon"),
  Type.Literal("domain_registration"),
]);
export const ComponentKindSchema = Type.Union([
  Type.Literal("web"),
  Type.Literal("email"),
  Type.Literal("dns"),
]);
export const RequestedSettingSchema = Type.Union([
  Type.Literal("enabled"),
  Type.Literal("disabled"),
]);
export const ServiceManagerSchema = Type.Union([
  Type.Literal("staff"),
  Type.Literal("customer"),
]);
export const ServiceSummarySchema = object({
  id,
  kind: ServiceKindSchema,
  name: label,
  packageName: Type.Union([label, Type.Null()]),
  version: Type.Integer({ minimum: 1, maximum: 2147483647 }),
  attachedService: Type.Union([object({ id, name: label }), Type.Null()]),
});
export const ServicesResponseSchema = object({
  services: Type.Array(ServiceSummarySchema, { maxItems: 100 }),
  total: Type.Integer({ minimum: 0 }),
  ...AccountPaginationSchema.properties,
});
export const ServiceComponentSchema = object({
  id,
  kind: ComponentKindSchema,
  delivery: Type.Union([Type.Literal("hosted"), Type.Literal("external")]),
  providerLabel: label,
  manager: ServiceManagerSchema,
  requestedSetting: Type.Union([
    Type.Literal("enabled"),
    Type.Literal("disabled"),
    Type.Null(),
  ]),
  providerState: Type.Union([RequestedSettingSchema, Type.Literal("unknown")]),
  checkedAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
  version: Type.Integer({ minimum: 1, maximum: 2147483647 }),
  reviewReason: Type.Union([
    Type.Literal("requested_state_differs"),
    Type.Literal("running_without_entitlement"),
    Type.Null(),
  ]),
  domains: Type.Array(hostname, { maxItems: 100 }),
});
export const ServiceResponseSchema = object({
  service: object({
    ...ServiceSummarySchema.properties,
    canManage: Type.Boolean(),
    includedComponents: Type.Array(ComponentKindSchema, {
      maxItems: 3,
      uniqueItems: true,
    }),
    hostingAccounts: Type.Array(
      object({
        id,
        label,
        providerLabel: label,
        loginUrl: Type.Union([
          Type.String({ format: "uri", maxLength: 2048 }),
          Type.Null(),
        ]),
      }),
      { maxItems: 100 },
    ),
    components: Type.Array(ServiceComponentSchema, { maxItems: 100 }),
    websites: Type.Array(
      object({
        id,
        componentId: id,
        primaryHostname: hostname,
        aliases: Type.Array(hostname, { maxItems: 100 }),
      }),
      { maxItems: 100 },
    ),
    registration: Type.Union([
      object({
        registeredName: hostname,
        registrarLabel: label,
        manager: ServiceManagerSchema,
        expiresOn: Type.Union([Type.String({ format: "date" }), Type.Null()]),
        renewalResponsibility: Type.Union([
          Type.Literal("customer"),
          Type.Literal("staff"),
          Type.Literal("unknown"),
        ]),
      }),
      Type.Null(),
    ]),
    addons: Type.Array(ServiceSummarySchema, { maxItems: 100 }),
  }),
});
export const SetComponentPreferenceRequestSchema = object({
  requestId: id,
  expectedVersion: Type.Integer({ minimum: 1, maximum: 2147483647 }),
  requestedSetting: RequestedSettingSchema,
});
export const AttachAddonRequestSchema = object({
  requestId: id,
  expectedVersion: Type.Integer({ minimum: 1, maximum: 2147483647 }),
  attachedServiceId: Type.Union([id, Type.Null()]),
});
export type ServiceKind = Static<typeof ServiceKindSchema>;
export type ComponentKind = Static<typeof ComponentKindSchema>;
export type RequestedSetting = Static<typeof RequestedSettingSchema>;
export type ServiceManager = Static<typeof ServiceManagerSchema>;
export type ServiceSummary = Static<typeof ServiceSummarySchema>;
export type ServicesResponse = Static<typeof ServicesResponseSchema>;
export type ServiceResponse = Static<typeof ServiceResponseSchema>;
export type SetComponentPreferenceRequest = Static<
  typeof SetComponentPreferenceRequestSchema
>;
export type AttachAddonRequest = Static<typeof AttachAddonRequestSchema>;
