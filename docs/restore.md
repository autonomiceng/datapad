# Owned synthetic restore rehearsal

Operators can rehearse a full backup, fresh restore and private read-only inspection of an explicitly approved synthetic portal database. The source keeps running. This tooling grants no billing-staff authority, starts no application worker and never promotes or resumes the restored copy. It makes no production backup, activation or split-brain guarantee.

## Operator inputs

Use the existing portal-billing sandbox run directory. Its private `sandbox.json` supplies deployment provenance; the restore CLI does not read the Stripe secret file. Prepare a 0600 JSON config inside a 0700 directory outside every Git checkout. Each field is required and unknown fields are rejected:

```json
{
  "version": 1,
  "purpose": "owned-synthetic-portal",
  "source": {
    "runDirectory": "/private/synthetic-run",
    "composeProject": "datapad-portal-billing-<run-directory-digest>",
    "composeFile": "/checkout/compose.yaml",
    "checkoutDirectory": "/checkout",
    "databaseUrl": "postgres://example:<approved-password>@127.0.0.1:<source-port>/example",
    "deploymentKey": "<sandbox-deployment-v4-uuid>",
    "revision": "<source-checkout-head-40-hex>"
  }
}
```

The project suffix is the first twelve hex characters of SHA-256 over the absolute run-directory pathname, matching `scripts/local.ts`. Use canonical absolute paths. The CLI verifies the sandbox deployment key, checkout HEAD, Compose project/service/config/working-directory labels, PostgreSQL 18.6 image, named volume, source login and published loopback port. Every stored application `deployment_key` must match the configured deployment. Operator filesystem ownership and approved source database credentials are the authority. Synthetic provenance comes from the existing owned composition and explicit operator scope; arbitrary database content is outside that scope.

Run the entrypoint through the root-maintained mise task:

```sh
mise run restore:rehearse -- --config /private/config/restore.json --output /private/evidence/fresh-rehearsal
```

The output directory must be new, outside Git, with an existing parent. The CLI rejects symlink components and broad permissions. It creates 0700 directories and 0600 files. No source session token is needed. Credentials, source records, session IDs, signed payment URLs and private paths are never printed or included in the human report.

## Snapshot and owned restore

A source READ ONLY REPEATABLE READ transaction exports a snapshot and remains open while the comparison manifest and [`pg_dump --format=custom --snapshot`](https://www.postgresql.org/docs/18/app-pgdump.html) capture it. Table manifests hash canonical objects whose column values are PostgreSQL text with explicit UTC/date settings, preserving bigint precision and nulls. Sorted row digests and row counts cover every non-system ordinary/partitioned/materialized table, including migration, membership revocation, consent, audit, auth and durable job history. Column definitions, constraints and indexes receive a separate schema digest. Raw rows and schema expressions are never persisted in the comparison manifest.

The full archive retains database objects and sequence state. Sequence counters are outside PostgreSQL MVCC snapshot guarantees, so exact counters are archive observations and excluded from snapshot equality. The dump remains the authoritative artifact for those counters. Deployment identities and all financial identities, relationships, statuses, frozen amounts, receipts and attempted-work fields are included in row hashes. Rehearsal does not advance source sequences or modify source rows, roles, grants or processes.

The CLI creates a unique Compose project and volume with fresh database and login credentials. There is no destination URL input. It records the owned container ID, volume and nonce before starting PostgreSQL, verifies the empty destination and its database identity, and restores with [`pg_restore --no-owner --no-privileges --single-transaction --exit-on-error`](https://www.postgresql.org/docs/18/app-pgrestore.html). Source role ownership and grants are never replayed.

After inspection, teardown removes only the saved container ID and volume after checking their ownership labels and mounts. Backup, config, creation receipt and reports remain private for review. A failed check remains recorded; interrupted runs require an operator to verify the saved ownership receipt before cleanup. No restore server remains running after successful rehearsal.

## Separate inspection composition

The rehearsal invokes `scripts/restore/inspect-cli.ts` as a separate process. This entrypoint can also inspect a still-owned rehearsal destination, using only its generated private inspection config and a fresh report directory:

```sh
mise run restore:inspect -- --config /private/evidence/rehearsal/inspection-config.json --output /private/evidence/fresh-inspection
```

Successful rehearsal tears down that destination, so later review uses the retained static report. The inspection command cannot reconnect to a removed destination or authorize a new one from copied sessions.

The fresh inspection login has only CONNECT, schema USAGE and SELECT. It is neither a superuser nor a role/database creator, has no role memberships and cannot bypass row security. Destination PUBLIC privileges and routine execution are revoked before granting reads. A permission probe attempts a zero-row update in an explicit read-write transaction, requires PostgreSQL permission denial and always rolls back. A read-only transaction captures the restored manifest; report composition then runs and a new read-only transaction verifies identical content against both the first read and the source snapshot.

The dependency boundary checks the actual resolved inspection entrypoint graph. It permits only the six inspection files (`inspect-cli`, `inspection`, `check-boundary`, `database`, `ownership`, `private`), Node core, `pg` and `canonicalize`; it rejects unresolved dependencies and restore/archive composition. Inspection imports no application source or provider, SMTP, worker, bootstrap, authentication or migration constructors. No transport is configured or invoked in the actual journey, and the report has no scripts, forms, hosted-payment or mutation links. This evidence comes from the enforced composition and completed read-only journey. No dormant transport counter is used.

Copied pause values are reported as observations beside their limitation. Both paused and unpaused copies remain inert because inspection constructs no effect consumers. Copied jobs, auth rows and grants remain evidence, with no listeners or credentials capable of consuming them.

## Retained evidence and checks

`backup.dump` is the complete archive. `source-manifest.json` contains source table counts, digests and safe aggregate status, currency-specific minor-unit amount and receipt/history counts. `rehearsal-manifest.json` records capture/restore/inspection timestamps, source revision, source database and resource identity digests, archive digest, tool versions, schema/data digests, observed pause state and exit results. Generated Compose and inspection configs contain fresh local credentials and stay owner-only.

`inspection/report.html` is the standalone private human report. `inspection/inspection-manifest.json` has a fresh inspection identity, before/after manifests, permission-denial result and the resolved dependency graph. No raw sessions, tokens, provider URLs or credentials enter these reports or manifests. Destination creation credentials and saved ownership receipts are separate private files.

`mise run test:restore` covers exactly two bounded risk groups: exported-snapshot/full-restore consistency while a tiny owned synthetic source advances, and an actual separate report journey proving unchanged source/restored data, restricted-role write denial, inert jobs/auth and no transport composition even with an observed unpaused row. `mise run check:restore` verifies the inspection dependency graph. Root includes both in the PR gate alongside normal formatting, lint and type checks. The final integrated synthetic portal rehearsal is explicit operator acceptance, separate from these credential-free Docker fixtures.
