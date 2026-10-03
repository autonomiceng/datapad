import type { CustomerProfile } from "./contract";
export function validateProfile(profile: CustomerProfile): boolean {
  return (
    Object.keys(profile).sort().join(",") ===
      "billingEmail,displayName,legalName" &&
    [profile.displayName, profile.legalName].every(
      (value) =>
        typeof value === "string" &&
        value.trim().length > 0 &&
        value.length <= 256 &&
        !value.includes("\0") &&
        !/[\uD800-\uDFFF]/u.test(value),
    ) &&
    (profile.billingEmail === null ||
      (typeof profile.billingEmail === "string" &&
        profile.billingEmail.length <= 254 &&
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile.billingEmail) &&
        !profile.billingEmail.includes("\0")))
  );
}
export function profileOf(row: CustomerProfile): CustomerProfile {
  return {
    displayName: row.displayName,
    legalName: row.legalName,
    billingEmail: row.billingEmail,
  };
}
