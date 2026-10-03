import { domainToASCII } from "node:url";
import { isIP } from "node:net";
import { Temporal } from "@js-temporal/polyfill";
import canonicalize from "canonicalize";
import type {
  ServiceManifest,
  SyntheticServiceRecord,
  ServiceRecord,
  ComponentRecord,
} from "../types";
export const validId = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
const label = (value: string) =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.length <= 256 &&
  !value.includes("\0") &&
  !/[\uD800-\uDFFF]/u.test(value);
function hostname(value: string): boolean {
  return (
    typeof value === "string" &&
    value.length <= 253 &&
    domainToASCII(value) === value &&
    value === value.toLowerCase() &&
    !isIP(value) &&
    value.split(".").length > 1 &&
    value
      .split(".")
      .every((part) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part))
  );
}
export function serviceRecord(row: ServiceRecord): ServiceRecord {
  return {
    id: row.id,
    customerId: row.customerId,
    sourceKey: row.sourceKey,
    kind: row.kind,
    name: row.name,
    packageName: row.packageName,
    includedComponents: row.includedComponents,
    attachedServiceId: row.attachedServiceId,
  };
}
export function componentRecord(row: ComponentRecord): ComponentRecord {
  return {
    id: row.id,
    customerId: row.customerId,
    serviceId: row.serviceId,
    kind: row.kind,
    delivery: row.delivery,
    providerLabel: row.providerLabel,
    hostingAccountId: row.hostingAccountId,
    manager: row.manager,
    requestedSetting: row.requestedSetting,
    providerState: row.providerState,
    checkedAt: row.checkedAt ? new Date(row.checkedAt).toISOString() : null,
  };
}
export function manifestRecords(
  manifest: ServiceManifest,
): SyntheticServiceRecord[] {
  return [
    ...manifest.services.map((record) => ({
      recordType: "service" as const,
      record,
    })),
    ...manifest.hostingAccounts.map((record) => ({
      recordType: "hosting_account" as const,
      record,
    })),
    ...manifest.components.map((record) => ({
      recordType: "component" as const,
      record,
    })),
    ...manifest.websites.map((record) => ({
      recordType: "website" as const,
      record,
    })),
    ...manifest.names.map((record) => ({
      recordType: "component_name" as const,
      record,
    })),
    ...manifest.registrations.map((record) => ({
      recordType: "domain_registration" as const,
      record,
    })),
  ];
}
export function immutableRecord(record: SyntheticServiceRecord): string {
  if (record.recordType === "service")
    return (
      canonicalize({
        ...record,
        record: { ...record.record, attachedServiceId: null },
      }) ?? ""
    );
  if (record.recordType === "component")
    return (
      canonicalize({
        ...record,
        record: { ...record.record, requestedSetting: null },
      }) ?? ""
    );
  return canonicalize(record) ?? "";
}
export function validateManifest(
  manifest: ServiceManifest,
  allowRecord: (record: SyntheticServiceRecord) => boolean,
): void {
  if (
    Object.keys(manifest).sort().join(",") !==
      "components,hostingAccounts,names,registrations,services,websites" ||
    Object.values(manifest).some(
      (rows) => !Array.isArray(rows) || rows.length > 10000,
    )
  )
    throw new Error("Invalid service manifest");
  const records = manifestRecords(manifest);
  if (records.some((record) => !allowRecord(record)))
    throw new Error("Service record outside configured synthetic policy");
  const ids = new Set<string>();
  for (const row of [
    ...manifest.services,
    ...manifest.hostingAccounts,
    ...manifest.components,
    ...manifest.websites,
  ]) {
    if (!validId(row.id) || !validId(row.customerId) || ids.has(row.id))
      throw new Error("Invalid service identity");
    ids.add(row.id);
  }
  for (const row of manifest.services) {
    if (
      !label(row.name) ||
      !label(row.sourceKey) ||
      (row.packageName !== null && !label(row.packageName)) ||
      !["hosting", "addon", "domain_registration"].includes(row.kind) ||
      row.includedComponents.some(
        (kind) => !["web", "email", "dns"].includes(kind),
      ) ||
      new Set(row.includedComponents).size !== row.includedComponents.length ||
      (row.kind !== "hosting" && row.includedComponents.length > 0)
    )
      throw new Error("Invalid service record");
    if (row.attachedServiceId !== null) {
      const target = manifest.services.find(
        (value) => value.id === row.attachedServiceId,
      );
      if (
        row.kind !== "addon" ||
        !target ||
        target.customerId !== row.customerId ||
        target.kind === "addon"
      )
        throw new Error("Invalid service attachment");
    }
    if (
      manifest.services.filter((value) => value.attachedServiceId === row.id)
        .length > 100 ||
      manifest.components.filter((value) => value.serviceId === row.id).length >
        100
    )
      throw new Error("Service resource limit exceeded");
    const componentIds = manifest.components
      .filter((value) => value.serviceId === row.id)
      .map((value) => value.id);
    if (
      manifest.websites.filter((value) =>
        componentIds.includes(value.componentId),
      ).length > 100
    )
      throw new Error("Service website limit exceeded");
  }
  for (const row of manifest.hostingAccounts)
    if (![row.label, row.providerKey, row.providerLabel].every(label))
      throw new Error("Invalid hosting account");
  for (const row of manifest.components) {
    const service = manifest.services.find(
      (value) => value.id === row.serviceId,
    );
    const account = manifest.hostingAccounts.find(
      (value) => value.id === row.hostingAccountId,
    );
    if (
      !service ||
      service.kind !== "hosting" ||
      service.customerId !== row.customerId ||
      !["web", "email", "dns"].includes(row.kind) ||
      !["hosted", "external"].includes(row.delivery) ||
      !["staff", "customer"].includes(row.manager) ||
      !label(row.providerLabel) ||
      (row.hostingAccountId !== null &&
        (!account || account.customerId !== row.customerId)) ||
      (row.delivery === "hosted" && !account)
    )
      throw new Error("Invalid service component");
    const outsideControl =
      row.delivery === "external" && row.manager === "customer";
    if (
      outsideControl
        ? row.requestedSetting !== null
        : !["enabled", "disabled"].some(
            (value) => value === row.requestedSetting,
          )
    )
      throw new Error("Invalid component preference");
    if (
      row.providerState === "unknown"
        ? row.checkedAt !== null
        : !["enabled", "disabled"].includes(row.providerState) ||
          !row.checkedAt ||
          !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(
            row.checkedAt,
          ) ||
          Number.isNaN(Date.parse(row.checkedAt)) ||
          new Date(row.checkedAt).toISOString() !== row.checkedAt
    )
      throw new Error("Invalid provider observation");
    if (
      manifest.names.filter((value) => value.componentId === row.id).length >
      100
    )
      throw new Error("Component name limit exceeded");
  }
  const names = new Set<string>();
  for (const row of manifest.names) {
    const component = manifest.components.find(
      (value) => value.id === row.componentId,
    );
    const website = manifest.websites.find(
      (value) => value.id === row.websiteId,
    );
    const key = JSON.stringify([row.componentId, row.hostname]);
    if (
      !component ||
      component.customerId !== row.customerId ||
      component.kind !== row.componentKind ||
      !hostname(row.hostname) ||
      names.has(key) ||
      (row.componentKind === "web"
        ? !website ||
          website.componentId !== row.componentId ||
          website.customerId !== row.customerId
        : row.websiteId !== null || row.isPrimary)
    )
      throw new Error("Invalid component hostname");
    names.add(key);
  }
  for (const row of manifest.websites) {
    const component = manifest.components.find(
      (value) => value.id === row.componentId,
    );
    if (
      !component ||
      component.customerId !== row.customerId ||
      component.kind !== "web" ||
      manifest.names.filter(
        (value) => value.websiteId === row.id && value.isPrimary,
      ).length !== 1
    )
      throw new Error("Website requires one primary hostname");
  }
  for (const row of manifest.registrations) {
    const service = manifest.services.find(
      (value) => value.id === row.serviceId,
    );
    if (
      !service ||
      service.kind !== "domain_registration" ||
      service.customerId !== row.customerId ||
      !hostname(row.registeredName) ||
      !label(row.registrarLabel) ||
      !["staff", "customer"].includes(row.manager) ||
      !["staff", "customer", "unknown"].includes(row.renewalResponsibility)
    )
      throw new Error("Invalid domain registration");
    if (row.expiresOn !== null) {
      try {
        if (
          !/^\d{4}-\d\d-\d\d$/.test(row.expiresOn) ||
          Temporal.PlainDate.from(row.expiresOn).toString() !== row.expiresOn
        )
          throw new Error();
      } catch {
        throw new Error("Invalid registration expiry");
      }
    }
  }
  if (
    manifest.services.some(
      (row) =>
        row.kind === "domain_registration" &&
        manifest.registrations.filter((value) => value.serviceId === row.id)
          .length !== 1,
    )
  )
    throw new Error("Domain registration details missing");
}
