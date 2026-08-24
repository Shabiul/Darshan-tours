import { createClient } from "@supabase/supabase-js";
import path from "node:path";
import fs from "node:fs";

function loadEnv(envPath: string) {
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx > 0) {
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim();
        if (!process.env[key]) {
          process.env[key] = val;
        }
      }
    }
  }
}

loadEnv(path.join(process.cwd(), ".env"));
loadEnv(path.join(process.cwd(), ".env.local"));

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SECRET_KEY =
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_PUBLISHABLE_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

const supabase = SUPABASE_URL && SUPABASE_SECRET_KEY ? createClient(SUPABASE_URL, SUPABASE_SECRET_KEY) : null;

async function removeBalenoAutomatic() {
  console.log("🚗 Removing Baleno Automatic unit...");

  if (supabase) {
    // 1. Deactivate or delete unit 1102 (BALENO-002 / KA 18 MB 6673 / Baleno Automatic)
    const delRes = await supabase
      .from("vehicle_units")
      .update({ active: 0, status: "unavailable", notes: "Baleno Automatic (Deactivated)" })
      .or("id.eq.1102,unit_identifier.eq.BALENO-002,registration_no.eq.KA 18 MB 6673");
    console.log("  ✓ Supabase vehicle_units update result:", delRes.error ? delRes.error : "success");

    // 2. Update Maruti Baleno total_units = 1 in vehicles table
    const vRes = await supabase
      .from("vehicles")
      .update({ total_units: 1 })
      .or("id.eq.11,slug.eq.maruti-baleno-manual");
    console.log("  ✓ Supabase vehicles table update result:", vRes.error ? vRes.error : "success");
  } else {
    console.log("  ⚠️ Supabase credentials not found in env, skipped live DB execution.");
  }
}

removeBalenoAutomatic().catch(console.error);
