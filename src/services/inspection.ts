import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import type { ServiceManifest, ServicePolicy } from "./types";
import {
  services,
  hostingAccounts,
  serviceComponents,
  websites,
  componentNames,
  domainRegistrations,
} from "./internal/schema";
import {
  serviceRecord,
  componentRecord,
  manifestRecords,
  immutableRecord,
  validateManifest,
} from "./internal/validation";
export async function assertSyntheticServices(
  pool: Pool,
  policy: ServicePolicy,
): Promise<void> {
  validateManifest(policy.manifest, policy.allowRecord);
  const db = drizzle(pool);
  const [serviceRows, accounts, components, sites, names, registrations] =
    await Promise.all([
      db.select().from(services),
      db.select().from(hostingAccounts),
      db.select().from(serviceComponents),
      db.select().from(websites),
      db.select().from(componentNames),
      db.select().from(domainRegistrations),
    ]);
  const actual: ServiceManifest = {
    services: serviceRows.map(serviceRecord),
    hostingAccounts: accounts,
    components: components.map(componentRecord),
    websites: sites.map((row) => ({
      id: row.id,
      customerId: row.customerId,
      componentId: row.componentId,
    })),
    names,
    registrations: registrations.map((row) => ({
      serviceId: row.serviceId,
      customerId: row.customerId,
      registeredName: row.registeredName,
      registrarLabel: row.registrarLabel,
      manager: row.manager,
      expiresOn: row.expiresOn,
      renewalResponsibility: row.renewalResponsibility,
    })),
  };
  validateManifest(actual, policy.allowRecord);
  const expected = manifestRecords(policy.manifest)
    .map(immutableRecord)
    .sort((left, right) => left.localeCompare(right));
  const found = manifestRecords(actual)
    .map(immutableRecord)
    .sort((left, right) => left.localeCompare(right));
  if (JSON.stringify(expected) !== JSON.stringify(found))
    throw new Error("Service database contains unapproved records");
}
