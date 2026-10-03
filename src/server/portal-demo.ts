import type { CustomerProfile } from "../customers/contract";
import type { StaffRole } from "../access/contract";

export const portalDeploymentKey = "synthetic-portal";
export const portalCustomers = [
  {
    key: "elm",
    organizationId: "sample-elm",
    name: "Elm Studio (sample)",
    updatedName: "Elm Studio Updated (sample)",
    billingEmail: "billing-elm@example.test",
  },
  {
    key: "birch",
    organizationId: "sample-birch",
    name: "Birch Works (sample)",
    updatedName: "Birch Works Updated (sample)",
    billingEmail: "billing-birch@example.test",
  },
];
export const portalUsers = [
  {
    id: "sample-staff",
    name: "Sample staff",
    email: "staff@example.test",
    staffRoles: ["account_administrator", "billing", "support"] as StaffRole[],
  },
  {
    id: "sample-elm-admin",
    name: "Elm administrator",
    email: "elm-admin@example.test",
    staffRoles: [] as StaffRole[],
  },
  {
    id: "sample-birch-admin",
    name: "Birch administrator",
    email: "birch-admin@example.test",
    staffRoles: [] as StaffRole[],
  },
  {
    id: "sample-collaborator",
    name: "Shared collaborator",
    email: "collaborator@example.test",
    staffRoles: [] as StaffRole[],
  },
  {
    id: "sample-outsider",
    name: "Sample outsider",
    email: "outsider@example.test",
    staffRoles: [] as StaffRole[],
  },
];
export const portalInvitationEmail = "invitee@example.test";
export const portalEmails = [
  ...portalUsers.map((user) => user.email),
  portalInvitationEmail,
];
export const portalOrganizations = [
  {
    id: "sample-elm",
    name: "Elm Studio (sample)",
    slug: "sample-elm",
    members: [
      { userId: "sample-elm-admin", role: "administrator" as const },
      { userId: "sample-collaborator", role: "member" as const },
    ],
  },
  {
    id: "sample-birch",
    name: "Birch Works (sample)",
    slug: "sample-birch",
    members: [
      { userId: "sample-birch-admin", role: "administrator" as const },
      { userId: "sample-collaborator", role: "member" as const },
    ],
  },
];

export function allowPortalProfile(profile: CustomerProfile): boolean {
  return portalCustomers.some(
    (customer) =>
      [customer.name, customer.updatedName].includes(profile.displayName) &&
      [customer.name, customer.updatedName].includes(profile.legalName) &&
      (profile.billingEmail === null ||
        profile.billingEmail === customer.billingEmail),
  );
}

export function readPortalConfiguration() {
  const origin = process.env.PORTAL_DEMO_ORIGIN;
  const secret = process.env.PORTAL_DEMO_SECRET;
  const smtp = process.env.PORTAL_DEMO_SMTP_URL;
  const inbox = process.env.PORTAL_DEMO_INBOX_URL;
  if (!origin || !secret || secret.length < 32 || !smtp || !inbox)
    throw new Error("Portal demo configuration is incomplete.");
  const base = new URL(origin);
  const mailbox = new URL(inbox);
  const transport = new URL(smtp);
  if (
    !["http:", "https:"].includes(base.protocol) ||
    base.origin !== origin ||
    !["http:", "https:"].includes(mailbox.protocol) ||
    mailbox.origin !== inbox ||
    transport.protocol !== "smtp:" ||
    transport.hostname !== "127.0.0.1" ||
    !transport.port ||
    transport.username ||
    transport.password ||
    transport.search ||
    transport.hash ||
    transport.pathname
  )
    throw new Error(
      "Portal demo requires an explicit origin and loopback mail sink.",
    );
  if (
    Object.keys(process.env).some(
      (key) =>
        (key.startsWith("STRIPE_") || key.startsWith("BILLING_")) &&
        process.env[key],
    )
  )
    throw new Error(
      "Portal account demo cannot load payment-provider configuration.",
    );
  return { origin, secret, smtp, inbox };
}
