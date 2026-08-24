import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { requireGatewayKey, bearerCustomer } from "@/lib/gateway-auth";
import { sbSelectOne } from "@/lib/supabase-rest";

const MIME: Record<string, string> = { jpeg: "image/jpeg", jpg: "image/jpeg", png: "image/png", webp: "image/webp", pdf: "application/pdf" };

/** Where the upload routes put a local copy. Resolved here rather than imported from the
 * old SQLite module, which this route no longer depends on. */
function uploadsDir(): string {
  if (!process.env.VERCEL) {
    try {
      const localDir = path.resolve(process.cwd(), "data", "uploads");
      fs.mkdirSync(localDir, { recursive: true });
      fs.accessSync(localDir, fs.constants.W_OK);
      return localDir;
    } catch {
      // fall through to tmp
    }
  }
  const tmpDir = path.resolve(os.tmpdir(), "darshan-crm-data", "uploads");
  fs.mkdirSync(tmpDir, { recursive: true });
  return tmpDir;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const denied = requireGatewayKey(req);
  if (denied) return denied;
  const customer = await bearerCustomer(req);
  if (!customer) return NextResponse.json({ error: "Not authorised." }, { status: 401 });

  const { name } = await params;
  if (!/^[a-f0-9]{16,64}\.[a-z]{3,4}$/i.test(name)) return NextResponse.json({ error: "Invalid file name." }, { status: 400 });
  if (!customer.customerId) return NextResponse.json({ error: "Not authorised." }, { status: 403 });

  // Ownership is checked against Supabase. `file_path` may hold either the legacy
  // `/api/files/<name>` path or a Supabase Storage URL ending in the same name, so the
  // match is on the suffix.
  const owns = await sbSelectOne<{ file_path: string }>(
    "customer_documents",
    `select=file_path&customer_id=eq.${customer.customerId}&file_path=like.${encodeURIComponent(`*${name}`)}`
  );
  if (!owns.ok) return NextResponse.json({ error: "Could not verify access to this file." }, { status: 502 });
  if (!owns.data) return NextResponse.json({ error: "Not authorised." }, { status: 403 });

  // Stored in Supabase Storage: hand back the object rather than looking on local disk,
  // which on a serverless lambda holds only files uploaded by that same instance.
  if (/^https?:\/\//i.test(owns.data.file_path)) {
    const upstream = await fetch(owns.data.file_path, { cache: "no-store" }).catch(() => null);
    if (!upstream || !upstream.ok) return NextResponse.json({ error: "Not found." }, { status: 404 });
    const ext = name.split(".").pop() ?? "";
    return new NextResponse(await upstream.arrayBuffer(), {
      headers: { "Content-Type": upstream.headers.get("content-type") ?? MIME[ext] ?? "application/octet-stream" },
    });
  }

  const uploadDir = uploadsDir();
  const filePath = path.resolve(uploadDir, name);
  if (!filePath.startsWith(uploadDir) || !fs.existsSync(filePath)) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const ext = name.split(".").pop() ?? "";
  const buf = fs.readFileSync(filePath);
  return new NextResponse(buf, { headers: { "Content-Type": MIME[ext] ?? "application/octet-stream" } });
}
