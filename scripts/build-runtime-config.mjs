import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const config = {
  supabaseUrl: process.env.SUPABASE_URL ?? "",
  supabasePublishableKey: process.env.SUPABASE_PUBLISHABLE_KEY ?? ""
};

await writeFile(
  resolve(import.meta.dirname, "..", "runtime-config.js"),
  `window.TEACHING_PLATFORM_CONFIG = ${JSON.stringify(config, null, 2)};\n`
);
console.log(`Built Teaching Brain runtime config (${config.supabaseUrl ? "Supabase enabled" : "manual fallback"}).`);

