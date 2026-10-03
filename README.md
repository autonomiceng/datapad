# Datapad

An open-source customer support and billing portal for service providers. The authenticated **Customer accounts** demo supports sample profiles, membership and invitations. **Import review** inspects sample customers, services, add-ons, domains and data issues before planning a migration. The [data model](docs/data-model.md) shows import relationships and timestamps; the accepted [service model](docs/service-model.md) describes future packages and independent components. Page Help explains the record types and import terms; the [glossary](CONTEXT.md) keeps that language consistent for contributors and agents.

An import is a saved copy of records from one source. Billing and services remain in the original system. Import review supplies no provisioning, source connectivity or sign-in. The separate invoice sandbox demonstrates manual payment with synthetic customers.

## Start locally

Install [mise](https://mise.jdx.dev/getting-started.html) and Docker with Compose, then run:

```sh
mise trust
mise install
mise run demo
```

The demo installs frozen dependencies, starts scoped PostgreSQL, applies migrations, imports two bundled synthetic fixture files and serves the built viewer. Open the printed loopback URL. Choose an import under **Data as of**, open a customer and inspect their services and data issues. Open **Help** for definitions or **Import details** for record counts. Repeat startup preserves saved imports and safely repeats the import operation. Ctrl+C stops the owned processes and database while retaining demo data.

Use `mise run dev` for frontend reloads with the same synthetic data. Vite proxies `/api` to Bun. Use `mise run demo:destroy` while demo and development tasks are stopped to remove the checkout's disposable demo database.

If you ran a demo before the import-review terminology alignment, stop demo/dev, run `mise run demo:destroy`, then `mise run demo` once. This unreleased format transition replaces the initial migration baseline and fixture keys; reset only the checkout's disposable synthetic demo database. Normal startup preserves imports.

The CLI and server accept only the reviewed shipped fixture contents. Real-data rehearsal needs a separate reviewed data-handling and access-control scope. See [the import-review guide](docs/import-review.md) for the format, import behavior and module architecture.

## Development

Tool versions and tasks live in `mise.toml`; dependencies live in `package.json` and `bun.lock`. Bun runs the backend, React with TanStack Router and Query drives the viewer, and PostgreSQL with Drizzle stores observations. Vite+ supplies frontend tooling; mise owns the shared local and CI task graph. [Architecture decisions](docs/adr/) explain the tradeoffs.

Run `mise run test` for application tests and tooling safeguards. On Linux, `mise run browser:deps` installs Chromium system libraries with administrator privileges. Run `mise run pr:check` before opening or updating a PR. The local gate requires a fetched `origin/main` and a new staged or committed changelog fragment; clean `main` intentionally fails that contribution requirement.

Format intentionally edited files explicitly, for example `mise run format -- README.md`. Every PR adds a benefit-focused release-note fragment. Read [CONTRIBUTING.md](CONTRIBUTING.md) for commands, checks and delivery, and [AGENTS.md](AGENTS.md) for agent guidance.

## Customer accounts

Run `mise run portal:demo` for the [authenticated account demo](docs/accounts-demo.md). Sign in through the local sample inbox, edit a profile as staff, invite a member and check customer access boundaries. Open Services to inspect hosting, registrations, websites and aliases; staff can record independent web/email/DNS preferences and attach or detach add-ons. These operations change portal records without sending provider commands. See the [services guide](docs/services.md). The [account architecture](docs/accounts.md) explains permissions, stable customer identities and preserved invoice history. The demo includes no live billing, external email or production customer data. Google/Microsoft provider sign-in awaits credentialed verification.

## Invoice sandbox

The retained **Invoices** screen displays a synthetic customer, service lines, dates, total and Stripe payment status. Run the [invoice sandbox demo](docs/billing-demo.md) to issue a test invoice, pay through Stripe and verify payment status survives a restart. The ordinary demo keeps billing empty and requires no credentials. [The billing architecture](docs/billing.md) explains persistence, event handling and recovery.

## Billing experiment

The [Stripe billing proof](docs/billing-proof.md) provides operator tooling for testing invoice timing and payment recovery with synthetic sandbox customers. Its local checks run in the PR gate; actual Stripe acceptance requires separate private sandbox configuration. It adds no production billing to the portal.

## Public core and private deployments

The public core contains reusable code, documentation and synthetic examples. Keep business-specific code, branding, configuration and migration mappings in a separate private repository. Store credentials, customer records and database exports outside both repositories. Public builds and checks work without private repositories or provider credentials.

Local tasks bind to loopback and serve synthetic fixtures. Real-data ingestion and production deployment remain outside the current scope.

## License

[MIT](LICENSE). Reused generic stack tooling retains applicable notices; dependencies retain their own licenses and notices.
