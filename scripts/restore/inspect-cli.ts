import { parseArgs } from "node:util";
import { inspectRestore } from "./inspection";

if (import.meta.main) {
  try {
    const { values } = parseArgs({
      options: { config: { type: "string" }, output: { type: "string" } },
      strict: true,
    });
    if (!values.config || !values.output)
      throw new Error("Explicit inspection config and fresh output required.");
    await inspectRestore(values.config, values.output);
    console.log(
      "Synthetic restore inspection passed; private report retained.",
    );
  } catch {
    console.error(
      "Synthetic restore inspection failed; private evidence retained for operator review.",
    );
    process.exitCode = 1;
  }
}
