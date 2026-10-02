import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {
    printWidth: 80,
    proseWrap: "preserve",
    endOfLine: "lf",
    sortImports: false,
    sortPackageJson: false,
  },
});
