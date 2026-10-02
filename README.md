# Datapad

An open-source customer and billing portal for service providers.

This repository contains the project foundation. The application is not implemented yet. The intended scope covers customer accounts, services, invoices, payments and support, starting with migration from an existing system.

## Public core and private deployments

The public core contains reusable code, documentation and synthetic examples. Keep business-specific code, branding, configuration and migration mappings in a separate private repository. Store credentials, customer records and database exports outside both repositories.

Public builds and checks must work without private repositories or provider credentials. The foundation has no application runtime or deployment requirements yet.

## Development

Install [mise](https://mise.jdx.dev/getting-started.html), then run:

```sh
mise trust
mise install
mise run test
```

This verifies the tool setup. Run `mise run pr:check` on a contribution branch after staging its new changelog fragment, or on a checked-out PR branch that already includes one. Clean `main` intentionally fails the local PR fragment requirement.

The current gate checks formatting, EditorConfig rules, shell tasks, GitHub Actions and changelog fragments, and tests the tooling safeguards. Application tests and a runnable demo will arrive with the first application increment. mise pins Bun, Node and the specialist tools; Bun installs the project-local Vite+ toolchain from `bun.lock`, Node runs its CLI, and Python runs Towncrier and tooling tests.

To format edited files, name them explicitly: `mise run format -- README.md`. The command rejects directories and glob patterns. See [CONTRIBUTING.md](CONTRIBUTING.md) for the complete task contract.

Every PR adds a benefit-focused release-note fragment. Use `mise run changelog:add -- maintenance "Explain the contributor benefit."` for an internal improvement, then stage the generated fragment before running the PR gate. `mise run changelog:preview` prints a read-only draft to stdout. See [CONTRIBUTING.md](CONTRIBUTING.md) for categories and local/CI check contexts.

Read [CONTRIBUTING.md](CONTRIBUTING.md) for the review workflow and [AGENTS.md](AGENTS.md) for agent guidance.

## License

[MIT](LICENSE). Dependencies retain their own licenses and notices.
