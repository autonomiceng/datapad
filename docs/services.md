# Customer services

Services records operational facts for a customer: hosting packages, attached add-ons, independent domain registrations, hosting accounts, websites and web/email/DNS delivery. Commercial subscriptions and invoices remain in billing. Import observations never create an entitlement, confirm delivery or authorize a change.

## Reading and recording preferences

Customer members and administrators read their own service records. Account administrators and support staff may record preferences and attach or detach existing add-ons. Billing staff can read; they cannot make those operational changes. Every command checks current authority in its transaction, including current session and staff grants. Selecting a customer or receiving a UI capability flag grants no permission.

A component's **Requested** setting differs from its **Provider state** and last checked time. Saving a preference sends nothing to a provider. A known mismatch needs staff review; an unknown state reads **Not checked** and has no mismatch warning. A hosted component running without its recorded entitlement also needs review. An included component deliberately left disabled is normal. Future execution needs a separately approved service change.

Provider and manager are independent. Staff may record a preference for staff-managed external delivery. Customer-managed external delivery has no requested setting or preference editor. External email and locally hosted email can be separate records within one package, preserving the local state and entitlement without claiming external delivery disabled anything locally.

Only the reviewed synthetic bootstrap may supply known provider observations in this slice. It records explicit timestamps under the runtime's exact fixture policy. Later non-synthetic creation must start unknown until an actual provider check; an imported Active status cannot establish operational confirmation.

## Identity and relationships

A hosting account is a provider container; it can serve several services belonging to one customer. Sharing that container combines neither preferences nor billing. Websites represent distinct content, with one primary hostname and optional aliases serving the same website. Primary names and aliases are unique within a web component. Email domains and DNS zones exist independently of websites. Hosting needs no registration record, and a domain registration can exist without hosting.

Every service, add-on and domain registration has its own stable service UUID. Registration expiry and renewal responsibility are recorded separately from hosting and commercial renewal scheduling. Unknown expiry stays unknown. The operational service kind `domain_registration` differs from the import observation type `domain`.

An add-on may be attached to a hosting service or domain registration of the same customer, or left unassigned. Attachment and detachment do not change price, invoice history, entitlement or delivery. Composite foreign keys enforce customer and target kind. Attachment ID and kind must both be null or both populated, preventing a partially null reference from bypassing the composite foreign key.

## Module interface

`createServices` receives the database pool, public customer authorization function, transactional audit writer, explicit synthetic record policy and configured provider navigation links. Its four operations are `listServices`, `getService`, `setComponentPreference` and `attachAddon`. Browser schemas live in `src/services/contract.ts`; server and bootstrap types live in `src/services/types.ts`. Other modules use the public service schema reference only for foreign keys and migrations.

Lists are customer-scoped in SQL, ordered by name and ID, with a default of 50 and maximum of 100. Details keep related resources and add-ons under their service. Profile names, provider observations and registration dates remain visible in the browser-safe projection; credentials and raw provider account identifiers do not appear.

Preference commands use the component version. Attach/detach commands use the add-on service version. A changed command increments that version and commits its audit record in the same transaction. A no-op at the current version has no audit event or request reservation. Stale versions and attempts to reuse a recorded mutation request return conflict; clients reload current data. Audit failure rolls back the mutation. Response reads happen after the mutation transaction releases its connection.

| HTTP operation                                                                            | Result                                                  |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `GET /api/customers/:customerId/services`                                                 | Service summaries with scoped count and pagination      |
| `GET /api/customers/:customerId/services/:serviceId`                                      | Components, websites, registration and attached add-ons |
| `PATCH /api/customers/:customerId/services/:serviceId/components/:componentId/preference` | Updated service detail                                  |
| `POST /api/customers/:customerId/addons/:addonId/attach`                                  | Updated add-on detail; null target detaches             |

Transport retains the account routes' current authentication, origin validation, safe errors and no-store responses. No browser endpoint creates records, edits provider facts, buys services or provisions resources.

## Bootstrap and inspection

`bootstrapSyntheticServices(tx, options)` validates an explicit six-array manifest, checks each record against the configured policy, and inserts it with operator audit in the caller transaction. A fixed bootstrap manifest digest is stored through the public audit writer. A transaction advisory lock serializes that bootstrap identity. Repeated bootstrap returns without restoring edited preferences or attachments; changed manifests require explicit operator work.

`assertSyntheticServices(pool, policy)` compares the entire stored set against the reviewed manifest. Immutable names, resources, customer relationships and observations must match exactly. Only permitted preference and attachment changes may differ. The policy validates the complete data, not a label prefix or hostname suffix. No production mode or fixture bypass is added.

The six owned tables are services, hosting accounts, service components, websites, component names and domain registrations. Name rows retain a component-kind discriminator to enforce their typed foreign key: a SQL CHECK cannot inspect another row. The website link and primary flag determine display meaning, without a duplicate role field.

Provider links are ordinary navigation. Startup accepts only an exact configured HTTPS URL without userinfo, query parameters or fragments, indexed by the reviewed provider key. The visible **Open Plesk** link grants no provider session or impersonation capability. No provider request is made by this module.
