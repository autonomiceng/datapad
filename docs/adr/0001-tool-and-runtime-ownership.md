# Keep one task graph with explicit tool ownership

mise owns pinned tools and the shared local/CI task graph; Bun owns frozen installs, server execution and backend tests, while project-local Vite+ owns formatting, JavaScript lint, integrated type checking and frontend builds. This combines a fast application runtime with maintained frontend tooling without duplicating orchestration in package scripts; Node and specialist non-JavaScript checkers remain available where their compatibility or coverage is needed. The cost is supporting several tools, so required checks stay behind one mise gate and versions remain in manifests.

Dependency-cruiser enforces import boundaries using its supported SWC parser because its default TypeScript parser does not support the pinned TypeScript 7 release. Negative fixtures verify that runtime and type-only boundary violations are detected; Vite+ retains ownership of type checking.
