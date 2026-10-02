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
mise run pr:check
```

The current gate checks formatting, EditorConfig rules, shell tasks and GitHub Actions, and tests the formatting safeguards. Application tests and a runnable demo will arrive with the first application increment. Tool versions are pinned in `mise.toml`; Node is currently used only to run Prettier.

To format edited files, name them explicitly: `mise run format -- README.md`. The command rejects directories and glob patterns. See [CONTRIBUTING.md](CONTRIBUTING.md) for the complete task contract.

Read [CONTRIBUTING.md](CONTRIBUTING.md) for the review workflow and [AGENTS.md](AGENTS.md) for agent guidance.

## License

[MIT](LICENSE). Dependencies retain their own licenses and notices.
