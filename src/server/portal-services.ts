import canonicalize from "canonicalize";
import type {
  ServiceManifest,
  ServicePolicy,
  SyntheticServiceRecord,
} from "../services/types";

const id = (number: number) =>
  `40000000-0000-4000-8000-${String(number).padStart(12, "0")}`;

export function portalServicePolicy(customerIds: {
  elm: string;
  birch: string;
}): ServicePolicy {
  const { elm, birch } = customerIds;
  const manifest: ServiceManifest = {
    services: [
      {
        id: id(1),
        customerId: elm,
        sourceKey: "elm-hosting",
        kind: "hosting",
        name: "elm.test",
        packageName: "Web, email and DNS",
        includedComponents: ["web", "email", "dns"],
        attachedServiceId: null,
      },
      {
        id: id(2),
        customerId: elm,
        sourceKey: "elm-email",
        kind: "hosting",
        name: "Email hosting",
        packageName: "Email",
        includedComponents: ["email"],
        attachedServiceId: null,
      },
      {
        id: id(3),
        customerId: elm,
        sourceKey: "elm-registration",
        kind: "domain_registration",
        name: "elm-domain.test",
        packageName: null,
        includedComponents: [],
        attachedServiceId: null,
      },
      {
        id: id(4),
        customerId: elm,
        sourceKey: "elm-storage",
        kind: "addon",
        name: "Extra storage",
        packageName: null,
        includedComponents: [],
        attachedServiceId: id(1),
      },
      {
        id: id(5),
        customerId: elm,
        sourceKey: "elm-backups",
        kind: "addon",
        name: "Backup storage",
        packageName: null,
        includedComponents: [],
        attachedServiceId: null,
      },
      {
        id: id(6),
        customerId: birch,
        sourceKey: "birch-hosting",
        kind: "hosting",
        name: "birch.test",
        packageName: "Web hosting",
        includedComponents: ["web"],
        attachedServiceId: null,
      },
      {
        id: id(7),
        customerId: birch,
        sourceKey: "birch-storage",
        kind: "addon",
        name: "Extra storage",
        packageName: null,
        includedComponents: [],
        attachedServiceId: id(6),
      },
    ],
    hostingAccounts: [
      {
        id: id(10),
        customerId: elm,
        providerKey: "sample-plesk",
        providerLabel: "Plesk (sample)",
        label: "Elm hosting account",
      },
      {
        id: id(11),
        customerId: birch,
        providerKey: "sample-plesk",
        providerLabel: "Plesk (sample)",
        label: "Birch hosting account",
      },
    ],
    components: [
      {
        id: id(20),
        customerId: elm,
        serviceId: id(1),
        kind: "web",
        delivery: "hosted",
        providerLabel: "Plesk (sample)",
        hostingAccountId: id(10),
        manager: "staff",
        requestedSetting: "enabled",
        providerState: "enabled",
        checkedAt: "2026-01-15T12:00:00.000Z",
      },
      {
        id: id(21),
        customerId: elm,
        serviceId: id(1),
        kind: "email",
        delivery: "hosted",
        providerLabel: "Plesk (sample)",
        hostingAccountId: id(10),
        manager: "staff",
        requestedSetting: "disabled",
        providerState: "disabled",
        checkedAt: "2026-01-15T12:00:00.000Z",
      },
      {
        id: id(22),
        customerId: elm,
        serviceId: id(1),
        kind: "dns",
        delivery: "hosted",
        providerLabel: "Plesk (sample)",
        hostingAccountId: id(10),
        manager: "staff",
        requestedSetting: "enabled",
        providerState: "enabled",
        checkedAt: "2026-01-15T12:00:00.000Z",
      },
      {
        id: id(23),
        customerId: elm,
        serviceId: id(1),
        kind: "email",
        delivery: "external",
        providerLabel: "External mail provider (sample)",
        hostingAccountId: null,
        manager: "customer",
        requestedSetting: null,
        providerState: "enabled",
        checkedAt: "2026-01-15T12:00:00.000Z",
      },
      {
        id: id(24),
        customerId: elm,
        serviceId: id(1),
        kind: "dns",
        delivery: "external",
        providerLabel: "External DNS provider (sample)",
        hostingAccountId: null,
        manager: "staff",
        requestedSetting: "enabled",
        providerState: "unknown",
        checkedAt: null,
      },
      {
        id: id(25),
        customerId: elm,
        serviceId: id(2),
        kind: "email",
        delivery: "hosted",
        providerLabel: "Plesk (sample)",
        hostingAccountId: id(10),
        manager: "staff",
        requestedSetting: "enabled",
        providerState: "enabled",
        checkedAt: "2026-01-15T12:00:00.000Z",
      },
      {
        id: id(26),
        customerId: birch,
        serviceId: id(6),
        kind: "web",
        delivery: "hosted",
        providerLabel: "Plesk (sample)",
        hostingAccountId: id(11),
        manager: "staff",
        requestedSetting: "enabled",
        providerState: "unknown",
        checkedAt: null,
      },
    ],
    websites: [
      { id: id(30), customerId: elm, componentId: id(20) },
      { id: id(31), customerId: elm, componentId: id(20) },
      { id: id(32), customerId: birch, componentId: id(26) },
    ],
    names: [
      {
        componentId: id(20),
        customerId: elm,
        componentKind: "web",
        websiteId: id(30),
        hostname: "elm.test",
        isPrimary: true,
      },
      {
        componentId: id(20),
        customerId: elm,
        componentKind: "web",
        websiteId: id(30),
        hostname: "www.elm.test",
        isPrimary: false,
      },
      {
        componentId: id(20),
        customerId: elm,
        componentKind: "web",
        websiteId: id(31),
        hostname: "shop.elm.test",
        isPrimary: true,
      },
      {
        componentId: id(21),
        customerId: elm,
        componentKind: "email",
        websiteId: null,
        hostname: "elm.test",
        isPrimary: false,
      },
      {
        componentId: id(22),
        customerId: elm,
        componentKind: "dns",
        websiteId: null,
        hostname: "elm.test",
        isPrimary: false,
      },
      {
        componentId: id(23),
        customerId: elm,
        componentKind: "email",
        websiteId: null,
        hostname: "elm.test",
        isPrimary: false,
      },
      {
        componentId: id(24),
        customerId: elm,
        componentKind: "dns",
        websiteId: null,
        hostname: "delegated.elm.test",
        isPrimary: false,
      },
      {
        componentId: id(25),
        customerId: elm,
        componentKind: "email",
        websiteId: null,
        hostname: "elm-mail.test",
        isPrimary: false,
      },
      {
        componentId: id(26),
        customerId: birch,
        componentKind: "web",
        websiteId: id(32),
        hostname: "birch.test",
        isPrimary: true,
      },
    ],
    registrations: [
      {
        serviceId: id(3),
        customerId: elm,
        registeredName: "elm-domain.test",
        registrarLabel: "Sample registrar",
        manager: "staff",
        expiresOn: "2027-01-15",
        renewalResponsibility: "staff",
      },
    ],
  };
  // Only these two fields are mutable through the reviewed service commands.
  const immutable = (entry: SyntheticServiceRecord) =>
    canonicalize({
      ...entry,
      record:
        entry.recordType === "service"
          ? { ...entry.record, attachedServiceId: null }
          : entry.recordType === "component"
            ? { ...entry.record, requestedSetting: null }
            : entry.record,
    });
  const records: SyntheticServiceRecord[] = [
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
  const approved = new Set(records.map(immutable));
  return { manifest, allowRecord: (record) => approved.has(immutable(record)) };
}
