# Separate purchased entitlements from component state

Accepted for the operational portal; not implemented by the current import-review slice.

Packages may include web, email and DNS while a customer uses only some components or uses external providers. Keep purchased entitlements, requested component settings, confirmed provider state, provider and manager distinct. Treat domain registration and renewal independently. Disabling an included component leaves package pricing unchanged unless an explicit commercial change says otherwise. Preserve component boundaries even when a provider account supplies several services.

A single package-active flag would make mixed providers and independent cancellation unsafe. Separate concepts require explicit relationships and provider-specific change procedures, but avoid coupling billing to availability or deleting retained services. Begin with staff-assisted requests and recorded approval/results. Customer controls follow proven procedures; data deletion, billing cancellation and provider handoff stay explicit actions. See the [service model](../service-model.md) for definitions and examples.
