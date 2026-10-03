import { createApp } from "../src/server/app";
import type { ImportReviewReader } from "../src/import-review";

const offlineRead = async (): Promise<never> => {
  throw new Error("Offline OpenAPI export must not read import review data.");
};
const importReview: ImportReviewReader = {
  listSources: offlineRead,
  listImports: offlineRead,
  listCustomers: offlineRead,
  getCustomer: offlineRead,
  listDataIssues: offlineRead,
};

export async function exportOpenApi(
  portal = false,
  portalOrigin = "http://localhost",
) {
  const app = createApp({
    importReview,
    ...(portal
      ? {
          accounts: {
            routes: {
              origin: portalOrigin,
              access: {
                resolveActor: offlineRead,
                getSession: offlineRead,
                listMembers: offlineRead,
                listInvitations: offlineRead,
                inviteMember: offlineRead,
                acceptInvitation: offlineRead,
                revokeInvitation: offlineRead,
                revokeMember: offlineRead,
              },
              customers: {
                listCustomers: offlineRead,
                getCustomer: offlineRead,
                updateCustomer: offlineRead,
              },
            },
            authHandler: offlineRead,
            authorizeImport: offlineRead,
          },
        }
      : {}),
  });
  const response = await app.handle(
    new Request("http://localhost/api/openapi/json"),
  );
  if (!response.ok)
    throw new Error(`OpenAPI export failed: ${response.status}`);
  return `${JSON.stringify(await response.json(), null, 2)}\n`;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--check"))
    throw new Error("Usage: openapi.ts [--check]");
  for (const portal of [false, true]) {
    const output = await exportOpenApi(portal);
    const artifact = Bun.file(
      new URL(
        portal
          ? "../contracts/portal-openapi.json"
          : "../contracts/openapi.json",
        import.meta.url,
      ),
    );
    if (args.includes("--check")) {
      if (!(await artifact.exists()) || (await artifact.text()) !== output) {
        throw new Error(
          "OpenAPI contract is out of date. Run mise run openapi:generate.",
        );
      }
    } else {
      await Bun.write(artifact, output);
    }
  }
  console.log(
    args.includes("--check")
      ? "OpenAPI contracts are current."
      : "OpenAPI contracts generated.",
  );
}
