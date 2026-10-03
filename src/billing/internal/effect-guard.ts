import { eq } from "drizzle-orm";
import type { FinancialEffectGuard } from "../effect-guard";
import { billingEffectControls } from "./operations-schema";

export class FinancialEffectsPaused extends Error {}

/** Construct the fail-closed deployment guard. Each invocation, including replay, must commit this check with its first stamp before dispatch. */
export function createFinancialEffectGuard(
  deploymentKey: string,
): FinancialEffectGuard {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(deploymentKey))
    throw new Error("Invalid billing deployment");
  return {
    async assertMayStart(tx) {
      const [control] = await tx
        .select()
        .from(billingEffectControls)
        .where(eq(billingEffectControls.deploymentKey, deploymentKey))
        .for("share");
      return control && !control.paused ? "allowed" : "paused";
    },
  };
}
