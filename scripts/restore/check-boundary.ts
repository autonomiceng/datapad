import { resolve } from "node:path";
import { command, digest } from "./private";

interface Dependency {
  module: string;
  resolved?: string;
  coreModule?: boolean;
  couldNotResolve?: boolean;
}
interface Graph {
  modules: { source: string; dependencies: Dependency[] }[];
}

export async function inspectionGraph() {
  const root = resolve(import.meta.dir, "../..");
  const graph: Graph = JSON.parse(
    await command([
      resolve(root, "node_modules/.bin/depcruise"),
      "--config",
      resolve(root, ".dependency-cruiser.cjs"),
      "--output-type",
      "json",
      resolve(root, "scripts/restore/inspect-cli.ts"),
    ]),
  );
  const allowedFiles = new Set([
    "inspect-cli.ts",
    "inspection.ts",
    "check-boundary.ts",
    "database.ts",
    "ownership.ts",
    "private.ts",
  ]);
  const edges: string[] = [];
  for (const module of graph.modules) {
    const source = module.source.startsWith(root + "/")
      ? module.source.slice(root.length + 1)
      : module.source;
    if (!source.startsWith("scripts/restore/")) continue;
    if (!allowedFiles.has(source.slice("scripts/restore/".length)))
      throw new Error("Inspection reached forbidden composition.");
    for (const dependency of module.dependencies) {
      const target = dependency.resolved ?? dependency.module;
      const local = target.startsWith(root + "/")
        ? target.slice(root.length + 1)
        : target;
      if (
        dependency.couldNotResolve ||
        !(
          dependency.coreModule ||
          dependency.module.startsWith("node:") ||
          ["pg", "canonicalize"].includes(dependency.module) ||
          (local.startsWith("scripts/restore/") &&
            allowedFiles.has(local.slice("scripts/restore/".length)))
        )
      )
        throw new Error("Inspection dependency boundary rejected an import.");
      edges.push(
        `${source} -> ${dependency.coreModule ? dependency.module : local}`,
      );
    }
  }
  if (
    !edges.some((edge) => edge.startsWith("scripts/restore/inspect-cli.ts -> "))
  )
    throw new Error("Inspection graph missing entrypoint.");
  return {
    edges: edges.sort(),
    hash: digest(edges.sort()),
    transportsConfigured: false as const,
    workersConstructed: false as const,
  };
}

if (import.meta.main) {
  await inspectionGraph();
  console.log("Restore inspection dependency boundary passed.");
}
