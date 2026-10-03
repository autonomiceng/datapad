import { Type, type Static, type TProperties } from "@sinclair/typebox";
import {
  AccountPaginationSchema,
  CustomerRoleSchema,
} from "../access/contract";

const object = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const label = Type.String({ minLength: 1, maxLength: 256 });
export const CustomerProfileSchema = object({
  displayName: label,
  legalName: label,
  billingEmail: Type.Union([
    Type.String({ format: "email", maxLength: 254 }),
    Type.Null(),
  ]),
});
export const CustomerSummarySchema = object({
  id: Type.String({ format: "uuid" }),
  displayName: label,
  role: Type.Union([...CustomerRoleSchema.anyOf, Type.Null()]),
});
export const CustomersResponseSchema = object({
  customers: Type.Array(CustomerSummarySchema, { maxItems: 100 }),
  total: Type.Integer({ minimum: 0 }),
  ...AccountPaginationSchema.properties,
});
export const ProviderProfileStateSchema = Type.Union([
  Type.Literal("not_linked"),
  Type.Literal("unchanged"),
  Type.Literal("pending"),
]);
export const CustomerResponseSchema = object({
  customer: object({
    ...CustomerSummarySchema.properties,
    profile: CustomerProfileSchema,
    version: Type.Integer({ minimum: 1, maximum: 2147483647 }),
    canEditProfile: Type.Boolean(),
    canManageMembers: Type.Boolean(),
    providerProfileState: ProviderProfileStateSchema,
  }),
});
export const UpdateCustomerRequestSchema = object({
  requestId: Type.String({ format: "uuid" }),
  expectedVersion: Type.Integer({ minimum: 1, maximum: 2147483647 }),
  profile: CustomerProfileSchema,
});
export const UpdateCustomerResponseSchema = object({
  outcome: Type.Union([Type.Literal("updated"), Type.Literal("unchanged")]),
  ...CustomerResponseSchema.properties,
});
export type CustomerProfile = Static<typeof CustomerProfileSchema>;
export type CustomersResponse = Static<typeof CustomersResponseSchema>;
export type CustomerResponse = Static<typeof CustomerResponseSchema>;
export type UpdateCustomerRequest = Static<typeof UpdateCustomerRequestSchema>;
export type UpdateCustomerResponse = Static<
  typeof UpdateCustomerResponseSchema
>;

export type ProviderProfileState = Static<typeof ProviderProfileStateSchema>;
