import { createDatabase } from "../src/server/db/connection";
import { bootstrapSyntheticAccess, createAuditWriter } from "../src/access";
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
    for (const customer of portalCustomers) {
      const record = await registry.ensureCustomer(tx, {
        registryKey: JSON.stringify([portalDeploymentKey, customer.key]),
        initialProfile: {
          displayName: customer.name,
          legalName: customer.name,
          billingEmail: null,
        },
      });
      await registry.bindOrganization(tx, {
        customerId: record.customerId,
        organizationId: customer.organizationId,
      });
    }
  });
  console.log("Synthetic customer accounts prepared.");
} finally {
  await database.close();
}
