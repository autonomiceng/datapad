import nodemailer from "nodemailer";
import { createInvoiceNotices } from "../notifications";
import { createNoticeSmtp } from "./notice-smtp";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import {
  createAccess,
  createAuthentication,
  assertSyntheticAccess,
} from "../access";
import {
  createCustomers,
  assertSyntheticCustomers,
  type Customers,
} from "../customers";
import { createServices, assertSyntheticServices } from "../services";
import { portalServicePolicy } from "./portal-services";
import { createBillingReader } from "../billing";
import { createPortalBilling } from "./portal-billing";
import { createPortalSubscriptions } from "./portal-subscriptions";
import type { BillingHttp } from "./billing-routes";
import {
  allowPortalProfile,
  portalCustomers,
  portalUsers,
  portalOrganizations,
  portalInvitationEmail,
  portalDeploymentKey,
  portalEmails,
  readPortalConfiguration,
} from "./portal-demo";

export async function createPortalRuntime(
  pool: Pool,
  options: {
    calendar?: import("../billing/subscriptions-contract").CalendarPolicy;
    /** Subscription, schedule, collection and notice calendar decisions only. */
    now?: () => Date;
  } = {},
) {
  const configuration = readPortalConfiguration();
  await assertSyntheticAccess(pool, {
    users: [
      ...portalUsers.map((user) => ({
        email: user.email,
        names: [user.name],
        staffRoles: user.staffRoles,
      })),
      {
        email: portalInvitationEmail,
        names: [portalInvitationEmail],
        staffRoles: [],
      },
    ],
    organizations: portalOrganizations,
  });
  await assertSyntheticCustomers(pool, {
    registryKeys: portalCustomers.map((customer) =>
      JSON.stringify([portalDeploymentKey, customer.key]),
    ),
    organizationIds: portalOrganizations.map((organization) => organization.id),
    allowProfile: allowPortalProfile,
  });
  const transport = nodemailer.createTransport(configuration.smtp, {
    from: "Datapad sample <portal@example.test>",
  });
  const send = async (email: string, subject: string, text: string) => {
    if (!portalEmails.includes(email))
      throw new Error("Recipient outside sample accounts.");
    await transport.sendMail({ to: email, subject, text });
  };
  const authentication = createAuthentication({
    pool,
    baseURL: configuration.origin,
    secret: configuration.secret,
    synthetic: true,
    allowedEmails: portalEmails,
    sendMagicLink: ({ email, url }) =>
      send(
        email,
        "Sign in to the Datapad sample portal",
        `Use this link to sign in:\n\n${url}\n\nThis message stays in the local sample inbox.`,
      ),
  });
  let customers: Customers;
  const lockPool = new Pool({ ...pool.options, max: 2 });
  const access = createAccess({
    pool,
    lockPool,
    authentication: authentication.gateway,
    getCustomerTarget: (customerId) => customers.getAccessTarget(customerId),
    getOrganizationTarget: (organizationId) =>
      customers.getOrganizationTarget(organizationId),
    allowInvitation: (email) => portalEmails.includes(email.toLowerCase()),
    signInMethods: ["email_link"],
    synthetic: true,
    baseURL: configuration.origin,
    sendInvitation: ({ email, invitationId }) =>
      send(
        email,
        "Invitation to a Datapad sample customer account",
        `Sign in with this email address, then review your invitation:\n\n${configuration.origin}/invitations/${encodeURIComponent(invitationId)}\n\nAccepting gives you access to the invited sample customer account.`,
      ),
  });
  const reader = createBillingReader({
    pool,
    deploymentKey: configuration.billing?.deploymentKey ?? portalDeploymentKey,
    businessNow: options.now,
  });
  customers = createCustomers({
    pool,
    access: access.policy,
    audit: access.audit,
    providerProfile: reader.providerProfile,
    allowProfile: allowPortalProfile,
  });
  const elm = await customers.getOrganizationTarget("sample-elm");
  const birch = await customers.getOrganizationTarget("sample-birch");
  if (!elm || !birch) throw new Error("Missing sample customer access");
  const servicePolicy = portalServicePolicy({
    elm: elm.customerId,
    birch: birch.customerId,
  });
  await assertSyntheticServices(pool, servicePolicy);
  const services = createServices({
    pool,
    authorizeCustomer: customers.authorizeCustomer.bind(customers),
    audit: access.audit,
    allowRecord: servicePolicy.allowRecord,
    providerLinks: {},
  });
  const subscriptions = await createPortalSubscriptions({
    pool,
    deploymentKey: configuration.billing?.deploymentKey ?? portalDeploymentKey,
    customers,
    access,
    customerIds: { elm: elm.customerId, birch: birch.customerId },
    origin: configuration.origin,
    calendar: options.calendar ?? configuration.calendar,
    now: options.now,
  });
  const portalBilling = await createPortalBilling({
    pool,
    reader,
    customers,
    access,
    configuration: configuration.billing,
    subscriptionPolicy: subscriptions,
    now: options.now,
    customerIds: { elm: elm.customerId, birch: birch.customerId },
    origin: configuration.origin,
  });
  const allowNoticeRecipient = (recipient: string) =>
    portalCustomers.some((customer) => customer.billingEmail === recipient);
  const noticeSmtp = createNoticeSmtp({
    smtp: configuration.smtp,
    allowRecipient: allowNoticeRecipient,
  });
  const invoiceNotices = createInvoiceNotices({
    pool,
    deploymentKey: configuration.billing?.deploymentKey ?? portalDeploymentKey,
    customerAccess: customers,
    billing: portalBilling.invoiceNoticeBilling,
    billingReader: reader,
    smtp: noticeSmtp,
    audit: access.audit,
    workerId: "synthetic-invoice-notices",
    allowRecipient: allowNoticeRecipient,
    noticeCalendar: {
      timeZone: (options.calendar ?? configuration.calendar).timeZone,
      hour: 9,
    },
    portalOrigin: configuration.origin,
    businessNow: options.now,
  });
  await invoiceNotices.assertSyntheticData();
  const billing: BillingHttp = {
    reader,
    webhook: portalBilling.webhook,
    async authorizeRead(headers) {
      const actor = await access.resolveActor(headers);
      if (!actor) return { ok: false, code: "unauthenticated" };
      const scope = await customers.billingScope(actor);
      if (!scope.ok) return scope;
      if (scope.value.kind === "all") return { ok: true, value: reader };
      const ids = scope.value.customerIds;
      return {
        ok: true,
        value: {
          listInvoices: (page) => reader.listInvoicesForCustomers(ids, page),
          getInvoice: (id) => reader.getInvoiceForCustomers(ids, id),
        },
      };
    },
  };

  return {
    notices: { access, notices: invoiceNotices },
    invoiceNotices,
    paymentSettings: portalBilling.paymentSettingsHttp,
    paymentSettingsWork: portalBilling.paymentSettings,
    resolutions: {
      access,
      resolutions: portalBilling.resolutions,
      origin: configuration.origin,
    },
    invoiceResolutions: portalBilling.resolutions,
    invoiceCollections: portalBilling.invoiceCollections,
    subscriptions: subscriptions.http,
    scheduled: {
      access,
      scheduled: portalBilling.scheduled,
      origin: configuration.origin,
    },
    scheduledBilling: portalBilling.scheduled,
    invoiceWorkflow: portalBilling.http,
    commands: portalBilling.commands,
    services: { services, access, origin: configuration.origin },
    billing,
    accounts: {
      routes: { access, customers, origin: configuration.origin },
      authHandler: authentication.handler,
      async authorizeImport(headers: Headers) {
        const actor = await access.resolveActor(headers);
        if (!actor)
          return { ok: false as const, code: "unauthenticated" as const };
        return access.policy.authorizeStaff(
          drizzle(pool),
          actor,
          ["account_administrator", "billing", "support"],
          false,
        );
      },
    },
    inbox: configuration.inbox,
    close: async () => {
      noticeSmtp.close();
      transport.close();
      await lockPool.end();
    },
  };
}
