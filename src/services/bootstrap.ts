import { createHash } from "node:crypto";
import canonicalize from "canonicalize";
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { ServiceBootstrapOptions } from "./types";
import {
  services,
  hostingAccounts,
  serviceComponents,
  websites,
  componentNames,
  domainRegistrations,
} from "./internal/schema";
import { validateManifest } from "./internal/validation";
/** Call within a caller-owned transaction so inserts and audit roll back together.
 * The same bootstrap key and manifest replay unchanged; a changed manifest throws. */
export async function bootstrapSyntheticServices(
  tx: NodePgDatabase,
  options: ServiceBootstrapOptions,
): Promise<void> {
  const { manifest, audit, operatorId, bootstrapKey } = options;
  if (!operatorId.trim() || !bootstrapKey.trim() || bootstrapKey.length > 256)
    throw new Error("Service bootstrap identity required");
  validateManifest(manifest, options.allowRecord);
  const manifestDigest = createHash("sha256")
    .update(canonicalize(manifest) ?? "")
    .digest("hex");
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`services-bootstrap:${bootstrapKey}`},0))`,
  );
  const receipt = await audit.getServicesBootstrap(tx, bootstrapKey);
  if (receipt) {
    if (receipt.manifestDigest !== manifestDigest)
      throw new Error("Service bootstrap manifest changed");
    return;
  }
  // Insert possible attachment targets first; every attachment still crosses the composite FK.
  for (const row of [
    ...manifest.services.filter((value) => value.kind !== "addon"),
    ...manifest.services.filter((value) => value.kind === "addon"),
  ]) {
    const attached = manifest.services.find(
      (value) => value.id === row.attachedServiceId,
    );
    await tx.insert(services).values({
      ...row,
      attachedServiceKind:
        attached?.kind === "hosting"
          ? "hosting"
          : attached?.kind === "domain_registration"
            ? "domain_registration"
            : null,
    });
    await audit.recordOperator(tx, {
      operatorId,
      customerId: row.customerId,
      action: "service.created",
      targetId: row.id,
    });
  }
  if (manifest.hostingAccounts.length)
    await tx.insert(hostingAccounts).values(manifest.hostingAccounts);
  if (manifest.components.length)
    await tx.insert(serviceComponents).values(manifest.components);
  if (manifest.websites.length)
    await tx.insert(websites).values(manifest.websites);
  if (manifest.names.length)
    await tx.insert(componentNames).values(manifest.names);
  if (manifest.registrations.length)
    await tx.insert(domainRegistrations).values(manifest.registrations);
  await audit.recordServicesBootstrap(tx, {
    operatorId,
    bootstrapKey,
    manifestDigest,
  });
}
