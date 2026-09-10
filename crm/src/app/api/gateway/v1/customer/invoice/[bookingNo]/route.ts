import { NextRequest, NextResponse } from "next/server";
import { requireGatewayKey, bearerCustomer } from "@/lib/gateway-auth";
import { sbSelectOne } from "@/lib/supabase-rest";
import { businessInfo } from "@/lib/settings";
import { generateInvoiceForBooking, getInvoiceForBooking } from "@/lib/invoices";

export async function GET(req: NextRequest, { params }: { params: Promise<{ bookingNo: string }> }) {
  const denied = requireGatewayKey(req);
  if (denied) return denied;
  const customer = await bearerCustomer(req);
  if (!customer) return NextResponse.json({ error: "Please log in first." }, { status: 401 });

  const { bookingNo } = await params;
  const rawRef = String(bookingNo).trim();

  // Never matches the raw sequential primary key — customer PII behind a guessable
  // integer. booking_no is long and non-sequential.
  const filter = /^\d+$/.test(rawRef)
    ? `or=(booking_no.eq.${rawRef},booking_no.eq.BK-${rawRef})`
    : `or=(booking_no.eq.${encodeURIComponent(rawRef)},booking_no.eq.${encodeURIComponent(rawRef.replace(/^BK-/i, ""))})`;

  // The customer/vehicle columns the invoice template prints used to come from a LEFT
  // JOIN; PostgREST returns them as embeds, flattened below to keep the response shape.
  //
  // branches(name) is embedded via the booking's OWN branch_id, not the vehicle's —
  // a booking can legitimately be picked up from a different branch than the
  // vehicle's home branch (branch re-allocation), and branch_id is the real,
  // populated column recording which one the customer actually used. Fall back to
  // the vehicle's branch only for older rows where branch_id was never set.
  const bookingRes = await sbSelectOne<Record<string, any>>(
    "bookings",
    `select=*,customers(name,phone,email,address),vehicles(name,registration_no,branch_id,branches(name)),branches(name)&${filter}`
  );
  if (!bookingRes.ok) return NextResponse.json({ error: bookingRes.error }, { status: 502 });
  const raw = bookingRes.data;
  if (!raw) return NextResponse.json({ error: "Not found." }, { status: 404 });
  // Both sides must be present and equal — a session with an unresolved customerId
  // previously skipped this check and could read any invoice in the system.
  if (!customer.customerId || Number(raw.customer_id) !== customer.customerId) {
    return NextResponse.json({ error: "Not authorised." }, { status: 403 });
  }

  const { customers, vehicles, branches, ...rest } = raw;
  const booking = {
    ...rest,
    customer_name: customers?.name ?? null,
    customer_phone: customers?.phone ?? null,
    customer_email: customers?.email ?? null,
    customer_address: customers?.address ?? null,
    vehicle_name: vehicles?.name ?? null,
    registration_no: vehicles?.registration_no ?? null,
    branch_name: branches?.name ?? vehicles?.branches?.name ?? null,
  };

  let invoice = await getInvoiceForBooking(Number(raw.id));
  if (!invoice) {
    await generateInvoiceForBooking(Number(raw.id));
    invoice = await getInvoiceForBooking(Number(raw.id));
  }

  const photo = raw.vehicle_id
    ? await sbSelectOne<{ url: string }>(
        "vehicle_photos",
        `select=url&vehicle_id=eq.${Number(raw.vehicle_id)}&order=is_primary.desc,id.asc`
      )
    : null;

  return NextResponse.json({
    booking,
    invoice: invoice ?? null,
    photoUrl: photo?.ok ? photo.data?.url ?? null : null,
    business: await businessInfo(),
  });
}
