import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [
    react(),
    {
      name: "browser-boundary",
      generateBundle() {
        for (const id of this.getModuleIds()) {
          const normalized = id.replaceAll("\\", "/");
          if (
            /\/src\/(server|stripe|worker)\//.test(normalized) ||
            (/\/src\/(import-review|billing|access|customers|services|notifications|support)\//.test(
              normalized,
            ) &&
              !/\/src\/(import-review|billing|access|customers|services|notifications|support)\/contract\.ts$/.test(
                normalized,
              )) ||
            /\/node_modules\/(?:elysia|@elysia|drizzle-orm|pg|pg-pool|pg-protocol|pg-boss|stripe|better-auth|@better-auth|nodemailer)\//.test(
              normalized,
            )
          ) {
            this.error(`Server module reached the browser bundle: ${id}`);
          }
        }
      },
    },
  ],
  server: {
    host: "127.0.0.1",
    proxy: { "/api": process.env.API_ORIGIN ?? "http://127.0.0.1:3000" },
  },
  fmt: {
    printWidth: 80,
    proseWrap: "preserve",
    endOfLine: "lf",
    sortImports: false,
    sortPackageJson: false,
    ignorePatterns: ["bun.lock", "drizzle/meta/**", "contracts/openapi.json"],
  },
  lint: {
    ignorePatterns: ["dist/**", ".scratch/**", "node_modules/**"],
    options: { typeAware: true, typeCheck: true },
    jsPlugins: [{ name: "jsdoc-js", specifier: "eslint-plugin-jsdoc" }],
    overrides: [
      {
        files: [
          "src/{access,customers,services,import-review,billing,notifications,support}/{index,types,provider,audit,bootstrap,inspection,authentication,registry,effect-guard,*-types}.ts",
        ],
        rules: {
          "jsdoc-js/require-jsdoc": [
            "error",
            {
              publicOnly: {
                esm: true,
                cjs: false,
                window: false,
                ancestorsOnly: false,
              },
              enableFixer: false,
              require: {
                FunctionDeclaration: true,
                ArrowFunctionExpression: true,
                FunctionExpression: true,
              },
              contexts: [
                "TSMethodSignature",
                "TSPropertySignature[typeAnnotation.typeAnnotation.type='TSFunctionType']",
                "TSTypeAliasDeclaration[typeAnnotation.type='TSFunctionType']",
              ],
            },
          ],
          "jsdoc-js/require-description": [
            "error",
            { contexts: ["any"], descriptionStyle: "body", exemptedBy: [] },
          ],
        },
      },
      {
        files: [
          "src/billing/internal/{workflow,subscriptions,scheduled,payment-settings,customer-receipt,resolutions,collection,notices}.ts",
          "src/notifications/internal/notices.ts",
        ],
        rules: {
          "jsdoc-js/require-jsdoc": [
            "error",
            {
              enableFixer: false,
              require: { FunctionDeclaration: false },
              contexts: [
                "FunctionDeclaration[id.name=/^create(BillingWorkflow|Subscriptions|ScheduledBilling|PaymentSettings|CustomerReceipt|InvoiceResolutions|InvoiceCollections|InvoiceNoticeBilling|InvoiceNotices)$/]",
              ],
            },
          ],
          "jsdoc-js/require-description": [
            "error",
            { contexts: ["any"], descriptionStyle: "body", exemptedBy: [] },
          ],
        },
      },
    ],
  },
});
