import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./server.ts",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
