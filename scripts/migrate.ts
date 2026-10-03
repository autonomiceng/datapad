import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import { createDatabase } from "../src/server/db/connection";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");

const database = createDatabase(url);
try {
  await migrate(database.db, {
    migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
  });
  console.log("Database migrations applied.");
} finally {
  await database.close();
}
