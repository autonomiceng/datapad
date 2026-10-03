// Schema-only foreign-key seam. Runtime consumers use the billing facade.
export { invoices, billingCustomers } from "./internal/invoice-schema";
