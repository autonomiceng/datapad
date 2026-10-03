import { createDatabase } from "../src/server/db/connection";
import { bootstrapSyntheticAccess, createAuditWriter } from "../src/access";
import { bootstrapSyntheticServices } from "../src/services";
import { portalServicePolicy } from "../src/server/portal-services";
import { createCustomerRegistry } from "../src/customers";
import {
  allowPortalProfile,
  portalCustomers,
  portalDeploymentKey,
  portalEmails,
  portalOrganizations,
  portalUsers,
  readPortalConfiguration,
} from "../src/server/portal-demo";

readPortalConfiguration();
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const database = createDatabase(process.env.DATABASE_URL);
try {
  const registry = createCustomerRegistry({
    operatorId: "synthetic-portal-bootstrap",
    allowProfile: allowPortalProfile,
    audit: createAuditWriter(),
  });
  await database.db.transaction(async (tx) => {
    await bootstrapSyntheticAccess(tx, {
      operatorId: "synthetic-portal-bootstrap",
      allowedEmails: portalEmails,
      users: portalUsers,
      organizations: portalOrganizations,
    });
    const customerIds = new Map<string, string>();
    for (const customer of portalCustomers) {
      const record = await registry.ensureCustomer(tx, {
        registryKey: JSON.stringify([portalDeploymentKey, customer.key]),
        initialProfile: {
          displayName: customer.name,
          legalName: customer.name,
          billingEmail: null,
        },
      });
      customerIds.set(customer.key, record.customerId);
      await registry.bindOrganization(tx, {
        customerId: record.customerId,
        organizationId: customer.organizationId,
      });
    }
    const elm = customerIds.get("elm"),
      birch = customerIds.get("birch");
    if (!elm || !birch) throw new Error("Missing sample customer identity");
    await bootstrapSyntheticServices(tx, {
      ...portalServicePolicy({ elm, birch }),
      operatorId: "synthetic-portal-bootstrap",
      bootstrapKey: "synthetic-portal-services-v1",
      audit: createAuditWriter(),
    });
  });
  console.log("Synthetic customer accounts prepared.");
} finally {
  await database.close();
}
