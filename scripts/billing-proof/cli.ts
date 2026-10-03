import Stripe from "stripe";
import { parseArgs } from "node:util";
import {
  createManifest,
  Probe,
  ProofError,
  safeError,
  type Manifest,
} from "./core.ts";
import { atomicWrite, openRun, readConfig } from "./store.ts";
import { renderReport } from "./report.ts";

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      config: { type: "string" },
      "run-dir": { type: "string" },
      "start-date": { type: "string" },
      to: { type: "string" },
      "interrupt-after-invoice": { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(
      "billing:proof <init|prepare|advance|collect|refresh|void> --config PRIVATE_ENV --run-dir PRIVATE_DIRECTORY [--start-date YYYY-MM-DD] [--to ISO_INSTANT] [--interrupt-after-invoice]",
    );
    return;
  }
  const command = positionals[0];
  if (
    positionals.length !== 1 ||
    !["init", "prepare", "advance", "collect", "refresh", "void"].includes(
      command,
    ) ||
    !values.config ||
    !values["run-dir"]
  )
    throw new ProofError(
      "Specify one command, --config and --run-dir. Use --help for the operator interface.",
    );
  if (
    (values.to && command !== "advance") ||
    (values["start-date"] && command !== "init") ||
    (values["interrupt-after-invoice"] && command !== "prepare")
  )
    throw new ProofError(
      "Command-specific flags were used with the wrong command.",
    );
  const key = await readConfig(values.config);
  const stripe = new Stripe(key, {
    apiVersion: "2026-09-30.endive",
    maxNetworkRetries: 0,
    timeout: 30_000,
  });
  const run = await openRun(values["run-dir"]);
  let manifest: Manifest | undefined;
  try {
    manifest = await run.read();
    if (!manifest) {
      if (command !== "init")
        throw new ProofError("No manifest found. Run init first.");
      manifest = createManifest(
        values["start-date"] ?? new Date().toISOString().slice(0, 10),
      );
    } else if (
      values["start-date"] &&
      values["start-date"] !== manifest.groups[0].readyDate
    )
      throw new ProofError("Existing run start date is immutable.");
    const current = manifest;
    const save = () =>
      atomicWrite(
        run.directory,
        "manifest.json",
        `${JSON.stringify(current, null, 2)}\n`,
      );
    await save();
    const probe = new Probe(
      stripe,
      current,
      save,
      values["interrupt-after-invoice"],
    );
    if (command === "init") await probe.setup();
    else if (command === "prepare") await probe.prepare();
    else if (command === "refresh") await probe.refresh();
    else if (command === "collect") await probe.collect();
    else if (command === "void") await probe.voidExample();
    else {
      if (
        !values.to ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$/.test(
          values.to,
        )
      )
        throw new ProofError(
          "Advance requires --to with an explicit ISO instant including timezone.",
        );
      await probe.advance(Date.parse(values.to) / 1000);
    }
    await save();
    console.log(
      `Completed ${command}. Private report updated. This is sandbox evidence, not a production billing capability.`,
    );
  } finally {
    try {
      if (manifest)
        await atomicWrite(run.directory, "report.html", renderReport(manifest));
    } finally {
      await run.release();
    }
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(safeError(error));
    process.exitCode = 1;
  });
}
