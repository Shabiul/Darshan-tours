/**
 * High-reliability direct Supabase PostgREST client for web serverless endpoints.
 * Completely bypasses @supabase/supabase-js JWT clock validation checks ('JWT issued at future')
 * by using direct HTTP fetch with service_role secret key headers.
 */

/** Throws when the project URL is unset — never falls back to a literal project host.
 * Callers invoke this inside their try block so it surfaces as a typed failure. */
export function getSupabaseUrl(): string {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) throw new Error("SUPABASE_URL is not configured on the server.");
  return url.replace(/\/$/, "");
}

function getSupabaseCredentials() {
  const url = getSupabaseUrl();
  const key =
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_PUBLISHABLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
    "";
  return { url, key };
}

/** PostgREST behind a proxy can answer with an HTML error page; parsing that as JSON
 * throws "Unexpected token '<'". Check the content type before touching res.json(). */
async function readJson(
  res: Response,
  label: string
): Promise<{ ok: true; json: any } | { ok: false; error: string }> {
  if (!res.headers.get("content-type")?.includes("application/json")) {
    const body = await res.text().catch(() => "");
    console.warn(`Supabase REST non-JSON response [${label}] (${res.status}):`, body.slice(0, 200));
    return { ok: false, error: `Database returned a non-JSON response (${res.status})` };
  }
  return { ok: true, json: await res.json() };
}

export async function supabaseRestInsert<T = Record<string, unknown>>(
  table: string,
  record: Record<string, unknown>
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const maxAttempts = 3;
  let lastError = `Insert into ${table} failed`;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { url, key } = getSupabaseCredentials();
      const res = await fetch(`${url}/rest/v1/${table}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: key,
          Authorization: `Bearer ${key}`,
          Prefer: "return=representation",
        },
        body: JSON.stringify(record),
        cache: "no-store",
      });
      const parsed = await readJson(res, `insert ${table}`);
      if (!parsed.ok) {
        lastError = parsed.error;
        if (attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, attempt * 150));
          continue;
        }
        return parsed;
      }
      const json = parsed.json;
      if (!res.ok) {
        lastError = json?.message || `Insert into ${table} failed (${res.status})`;
        const isTransient =
          lastError.toLowerCase().includes("jwt issued at future") ||
          lastError.toLowerCase().includes("jwt") ||
          res.status === 401 ||
          res.status >= 500;
        if (isTransient && attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, attempt * 150));
          continue;
        }
        console.warn(`Supabase REST insert error [${table}]:`, json);
        return { ok: false, error: lastError };
      }
      const data = Array.isArray(json) ? json[0] : json;
      return { ok: true, data: data as T };
    } catch (err: any) {
      lastError = err?.message || "Network error communicating with database";
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, attempt * 150));
        continue;
      }
      console.error(`Supabase REST insert network exception [${table}]:`, lastError);
      return { ok: false, error: lastError };
    }
  }

  return { ok: false, error: lastError };
}

export async function supabaseRestUpsert<T = Record<string, unknown>>(
  table: string,
  record: Record<string, unknown>
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const maxAttempts = 3;
  let lastError = `Upsert into ${table} failed`;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { url, key } = getSupabaseCredentials();
      const res = await fetch(`${url}/rest/v1/${table}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: key,
          Authorization: `Bearer ${key}`,
          Prefer: "resolution=merge-duplicates,return=representation",
        },
        body: JSON.stringify(record),
        cache: "no-store",
      });
      const parsed = await readJson(res, `upsert ${table}`);
      if (!parsed.ok) {
        lastError = parsed.error;
        if (attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, attempt * 150));
          continue;
        }
        return parsed;
      }
      const json = parsed.json;
      if (!res.ok) {
        lastError = json?.message || `Upsert into ${table} failed (${res.status})`;
        const isTransient =
          lastError.toLowerCase().includes("jwt issued at future") ||
          lastError.toLowerCase().includes("jwt") ||
          res.status === 401 ||
          res.status >= 500;
        if (isTransient && attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, attempt * 150));
          continue;
        }
        console.warn(`Supabase REST upsert error [${table}]:`, json);
        return { ok: false, error: lastError };
      }
      const data = Array.isArray(json) ? json[0] : json;
      return { ok: true, data: data as T };
    } catch (err: any) {
      lastError = err?.message || "Network error communicating with database";
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, attempt * 150));
        continue;
      }
      console.error(`Supabase REST upsert network exception [${table}]:`, lastError);
      return { ok: false, error: lastError };
    }
  }

  return { ok: false, error: lastError };
}

export async function supabaseRestUpdate<T = Record<string, unknown>>(
  table: string,
  query: string,
  patch: Record<string, unknown>
): Promise<{ ok: true; data: T[] } | { ok: false; error: string }> {
  const maxAttempts = 3;
  let lastError = `Update ${table} failed`;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { url, key } = getSupabaseCredentials();
      const res = await fetch(`${url}/rest/v1/${table}?${query}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          apikey: key,
          Authorization: `Bearer ${key}`,
          Prefer: "return=representation",
        },
        body: JSON.stringify(patch),
        cache: "no-store",
      });
      const parsed = await readJson(res, `update ${table}`);
      if (!parsed.ok) {
        lastError = parsed.error;
        if (attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, attempt * 150));
          continue;
        }
        return parsed;
      }
      const json = parsed.json;
      if (!res.ok) {
        lastError = json?.message || `Update ${table} failed (${res.status})`;
        const isTransient =
          lastError.toLowerCase().includes("jwt issued at future") ||
          lastError.toLowerCase().includes("jwt") ||
          res.status === 401 ||
          res.status >= 500;
        if (isTransient && attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, attempt * 150));
          continue;
        }
        console.warn(`Supabase REST update error [${table}]:`, json);
        return { ok: false, error: lastError };
      }
      return { ok: true, data: (Array.isArray(json) ? json : [json]) as T[] };
    } catch (err: any) {
      lastError = err?.message || "Network error communicating with database";
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, attempt * 150));
        continue;
      }
      console.error(`Supabase REST update network exception [${table}]:`, lastError);
      return { ok: false, error: lastError };
    }
  }

  return { ok: false, error: lastError };
}

export async function supabaseRestSelect<T = Record<string, unknown>>(
  table: string,
  query: string
): Promise<T[] | null> {
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { url, key } = getSupabaseCredentials();
      const res = await fetch(`${url}/rest/v1/${table}?${query}`, {
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
        },
        cache: "no-store",
      });
      if (!res.ok) {
        if (attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, attempt * 150));
          continue;
        }
        return null;
      }
      const parsed = await readJson(res, `select ${table}`);
      if (!parsed.ok) {
        if (attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, attempt * 150));
          continue;
        }
        return null;
      }
      return parsed.json as T[];
    } catch (err: any) {
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, attempt * 150));
        continue;
      }
      console.warn(`Supabase REST select error [${table}]:`, err?.message || err);
      return null;
    }
  }

  return null;
}
