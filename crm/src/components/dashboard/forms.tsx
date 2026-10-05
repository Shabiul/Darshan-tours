"use client";

import { useState, useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  createManualEnquiry, changeEnquiryStage, assignEnquiry, addEnquiryNote,
  updateBookingStatus, assignBookingManager, approveAfterHours, addManualAdjustment,
  recordInspection, addDamageReport, addPayment, markPaymentPaid,
  decideRefund, completeRefund, updateProblemTicket, changeBookingAtPickup, raiseRefund,
} from "@/lib/actions";
import { compressImageFile } from "@/lib/image-compression";
import { VehicleCameraScanner, type CapturedPhoto } from "./VehicleCameraScanner";

function useAction() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState("");
  function run(fn: () => Promise<{ ok?: boolean; error?: string } | void>) {
    setError("");
    startTransition(async () => {
      try {
        const res = await fn();
        if (res && "error" in res && res.error) setError(res.error);
        else router.refresh();
      } catch {
        setError("Something went wrong. Please try again.");
      }
    });
  }
  return { pending, error, run, setError };
}

export function CreateEnquiryForm({ categories }: { categories: Array<{ id: number; name: string }> }) {
  const { pending, error, run } = useAction();
  const [form, setForm] = useState({ name: "", phone: "", email: "", categoryId: "", location: "", pickupDate: "", returnDate: "", passengers: "", source: "Phone call", notes: "" });
  const [errs, setErrs] = useState<Record<string, string>>({});

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const next: Record<string, string> = {};
    if (form.name.trim().length < 2) next.name = "Enter the customer name.";
    if (!/^[+\d][\d\s-]{8,15}$/.test(form.phone.trim())) next.phone = "Enter a valid mobile number.";
    setErrs(next);
    if (Object.keys(next).length > 0) return;
    run(async () => {
      await createManualEnquiry({
        name: form.name.trim(), phone: form.phone.trim(), email: form.email.trim() || undefined,
        categoryId: form.categoryId ? Number(form.categoryId) : null, location: form.location || undefined,
        pickupDate: form.pickupDate || undefined, returnDate: form.returnDate || undefined,
        passengers: form.passengers ? Number(form.passengers) : undefined, source: form.source, notes: form.notes.trim() || undefined,
      });
      setForm({ name: "", phone: "", email: "", categoryId: "", location: "", pickupDate: "", returnDate: "", passengers: "", source: "Phone call", notes: "" });
    });
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="ce-name">Customer name *</label>
          <input id="ce-name" className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} aria-invalid={!!errs.name} />
          {errs.name && <p className="field-error">{errs.name}</p>}
        </div>
        <div>
          <label className="label" htmlFor="ce-phone">Mobile number *</label>
          <input id="ce-phone" className="input" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} aria-invalid={!!errs.phone} />
          {errs.phone && <p className="field-error">{errs.phone}</p>}
        </div>
        <div>
          <label className="label" htmlFor="ce-email">Email</label>
          <input id="ce-email" className="input" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </div>
        <div>
          <label className="label" htmlFor="ce-cat">Vehicle type</label>
          <select id="ce-cat" className="input" value={form.categoryId} onChange={(e) => setForm({ ...form, categoryId: e.target.value })}>
            <option value="">— Select —</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="ce-loc">Pickup location</label>
          <input id="ce-loc" className="input" value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} />
        </div>
        <div>
          <label className="label" htmlFor="ce-pax">Passengers</label>
          <input id="ce-pax" className="input" type="number" min={1} value={form.passengers} onChange={(e) => setForm({ ...form, passengers: e.target.value })} />
        </div>
        <div>
          <label className="label" htmlFor="ce-pickup">Pickup date</label>
          <input id="ce-pickup" className="input" type="date" value={form.pickupDate} onChange={(e) => setForm({ ...form, pickupDate: e.target.value })} />
        </div>
        <div>
          <label className="label" htmlFor="ce-return">Return date</label>
          <input id="ce-return" className="input" type="date" value={form.returnDate} onChange={(e) => setForm({ ...form, returnDate: e.target.value })} />
        </div>
        <div>
          <label className="label" htmlFor="ce-source">Source</label>
          <select id="ce-source" className="input" value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })}>
            {["Phone call", "WhatsApp", "Walk-in", "Referral", "Instagram", "Google", "Other"].map((s) => <option key={s}>{s}</option>)}
          </select>
        </div>
      </div>
      <div>
        <label className="label" htmlFor="ce-notes">Notes</label>
        <textarea id="ce-notes" className="input min-h-20" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
      </div>
      {error && <p className="field-error" role="alert">{error}</p>}
      <button type="submit" disabled={pending} className="btn-primary">{pending ? "Creating…" : "Create enquiry"}</button>
    </form>
  );
}

export function EnquiryStageSelect({ enquiryId, stages, current }: { enquiryId: number; stages: string[]; current: string }) {
  const { pending, run } = useAction();
  return (
    <select className="input w-auto" value={current} disabled={pending} onChange={(e) => run(() => changeEnquiryStage(enquiryId, e.target.value))} aria-label="Change enquiry stage">
      {stages.map((s) => <option key={s}>{s}</option>)}
    </select>
  );
}

export function EnquiryAssignSelect({ enquiryId, staff, current }: { enquiryId: number; staff: Array<{ id: number; name: string }>; current: number | null }) {
  const { pending, run } = useAction();
  return (
    <select className="input w-auto" value={current ?? ""} disabled={pending} onChange={(e) => run(() => assignEnquiry(enquiryId, e.target.value ? Number(e.target.value) : null))} aria-label="Assign staff">
      <option value="">Unassigned</option>
      {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
    </select>
  );
}

export function EnquiryNoteForm({ enquiryId }: { enquiryId: number }) {
  const [note, setNote] = useState("");
  const { pending, error, run } = useAction();
  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (note.trim().length < 2) return;
    run(async () => { await addEnquiryNote(enquiryId, note.trim()); setNote(""); });
  }
  return (
    <form onSubmit={submit} className="space-y-2">
      <textarea className="input min-h-16" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note…" />
      {error && <p className="field-error">{error}</p>}
      <button type="submit" disabled={pending} className="btn-primary px-4 py-2 text-xs">Add note</button>
    </form>
  );
}

export function BookingStatusSelect({ bookingId, statuses, current }: { bookingId: number; statuses: string[]; current: string }) {
  const { pending, run } = useAction();
  return (
    <select className="input w-auto" value={current} disabled={pending} onChange={(e) => run(() => updateBookingStatus(bookingId, e.target.value))} aria-label="Change booking status">
      {statuses.map((s) => <option key={s}>{s}</option>)}
    </select>
  );
}

export function BookingManagerSelect({ bookingId, staff, current }: { bookingId: number; staff: Array<{ id: number; name: string }>; current: number | null }) {
  const { pending, run } = useAction();
  return (
    <select className="input w-auto" value={current ?? ""} disabled={pending} onChange={(e) => run(() => assignBookingManager(bookingId, e.target.value ? Number(e.target.value) : null))} aria-label="Assign manager">
      <option value="">Unassigned</option>
      {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
    </select>
  );
}

export function AfterHoursApproval({ bookingId }: { bookingId: number }) {
  const [note, setNote] = useState("");
  const { pending, run } = useAction();
  return (
    <div className="space-y-2 rounded-xl border border-amber-200 bg-amber-50 p-4">
      <p className="text-sm font-semibold text-amber-800">This booking has an after-hours pickup and needs approval.</p>
      <input className="input" placeholder="Optional note / surcharge explanation" value={note} onChange={(e) => setNote(e.target.value)} />
      <div className="flex gap-2">
        <button type="button" disabled={pending} onClick={() => run(() => approveAfterHours(bookingId, true, note || undefined))} className="btn-primary px-4 py-2 text-xs">Approve</button>
        <button type="button" disabled={pending} onClick={() => run(() => approveAfterHours(bookingId, false, note || undefined))} className="btn-secondary px-4 py-2 text-xs">Decline</button>
      </div>
    </div>
  );
}

const PHOTO_SIDES = ["front", "rear", "left", "right", "odometer", "fuel", "damage"] as const;

export function InspectionForm({ bookingId, kind }: { bookingId: number; kind: "handover" | "return" }) {
  const { pending, error, run } = useAction();
  const [odometer, setOdometer] = useState("");
  const [fuelLevel, setFuelLevel] = useState("Full");
  const [notes, setNotes] = useState("");
  const [capturedPhotos, setCapturedPhotos] = useState<Record<string, CapturedPhoto>>({});
  const [geo, setGeo] = useState<{ lat: number; lng: number; accuracyM: number } | null>(null);
  const [geoStatus, setGeoStatus] = useState<"idle" | "locating" | "ok" | "denied" | "unavailable">("idle");

  // Best-effort location stamp for the inspection. Never blocks the form: a denied
  // or unavailable reading just leaves geo null and the inspection proceeds exactly
  // as it did before this feature existed.
  useEffect(() => {
    if (!("geolocation" in navigator)) {
      setGeoStatus("unavailable");
      return;
    }
    setGeoStatus("locating");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGeo({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracyM: pos.coords.accuracy });
        setGeoStatus("ok");
      },
      () => setGeoStatus("denied"),
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 }
    );
  }, []);

  const handlePhotoCaptured = (photo: CapturedPhoto) => {
    setCapturedPhotos((prev) => ({ ...prev, [photo.side]: photo }));
  };

  const handleRemovePhoto = (side: string) => {
    setCapturedPhotos((prev) => {
      const next = { ...prev };
      delete next[side];
      return next;
    });
  };

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const mandatoryKeys = ["front", "rear", "left", "right", "odometer"];
    const missingKeys = mandatoryKeys.filter((k) => !capturedPhotos[k]?.url);

    if (missingKeys.length > 0) {
      if (!confirm(`Missing scans for: ${missingKeys.join(", ").toUpperCase()}. Are you sure you want to proceed without all vehicle inspection photos & odometer reading?`)) {
        return;
      }
    }

    run(async () => {
      const photoPayload = Object.values(capturedPhotos).map((p) => ({
        side: p.side,
        url: p.url,
        notes: p.notes,
      }));

      const res = await recordInspection({
        bookingId,
        kind,
        odometer: odometer ? Number(odometer) : undefined,
        fuelLevel,
        notes: notes || undefined,
        photos: photoPayload,
        geo,
      });
      return res;
    });
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <p className="text-xs text-ink-400">
        {geoStatus === "locating" && "Locating…"}
        {geoStatus === "ok" && geo && `Location captured (±${Math.round(geo.accuracyM)}m)`}
        {geoStatus === "denied" && "Location permission denied — inspection will proceed without it."}
        {geoStatus === "unavailable" && "Location not available on this device — inspection will proceed without it."}
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label">Odometer reading (km)</label>
          <input className="input" type="number" min={0} value={odometer} onChange={(e) => setOdometer(e.target.value)} placeholder="e.g. 24500" />
        </div>
        <div>
          <label className="label">Fuel level</label>
          <select className="input" value={fuelLevel} onChange={(e) => setFuelLevel(e.target.value)}>
            {["Full", "3/4", "1/2", "1/4", "Empty"].map((f) => <option key={f}>{f}</option>)}
          </select>
        </div>
      </div>

      <div>
        <label className="label">Inspection notes</label>
        <textarea className="input min-h-14" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Existing scratches, clean interior, tire condition, etc." />
      </div>

      {/* Live Camera Scanner & Geotagged Photo Capture */}
      <div className="rounded-xl border border-ink-200 bg-white p-3 shadow-sm">
        <VehicleCameraScanner
          capturedPhotos={capturedPhotos}
          onPhotoCaptured={handlePhotoCaptured}
          onRemovePhoto={handleRemovePhoto}
        />
      </div>

      {error && <p className="field-error">{error}</p>}
      <button type="submit" disabled={pending} className="btn-primary w-full py-2.5 text-xs font-semibold shadow">
        {pending ? "Saving Inspection Record..." : kind === "handover" ? "✓ Record Handover Inspection" : "✓ Record Return Inspection & Calculate Charges"}
      </button>
    </form>
  );
}

export function ManualAdjustmentForm({ bookingId }: { bookingId: number }) {
  const [type, setType] = useState("late_fee_change");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const { pending, error, run } = useAction();
  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!reason.trim() || !amount) return;
    run(async () => {
      await addManualAdjustment({ bookingId, type, amount: Number(amount), reason: reason.trim() });
      setAmount(""); setReason("");
    });
  }
  return (
    <form onSubmit={submit} className="space-y-2">
      <div className="grid gap-2 sm:grid-cols-3">
        <select className="input" value={type} onChange={(e) => setType(e.target.value)}>
          {[["late_fee_change", "Late fee change"], ["late_fee_waiver", "Late fee waiver"], ["price_override", "Price override"], ["discount", "Discount"], ["damage_charge", "Damage charge"], ["other", "Other"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <input className="input" type="number" placeholder="Amount (₹, use negative to reduce)" value={amount} onChange={(e) => setAmount(e.target.value)} />
        <input className="input" placeholder="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
      {error && <p className="field-error">{error}</p>}
      <button type="submit" disabled={pending} className="btn-secondary px-4 py-2 text-xs">Record adjustment</button>
    </form>
  );
}

/** Vehicle swap / date change / detail correction at the counter, before handover.
 * Blank vehicle/date fields mean "keep current" — only what the customer actually
 * wants changed needs to be touched. */
export function ChangeBookingForm({
  bookingId,
  vehicles,
}: {
  bookingId: number;
  vehicles: Array<{ id: number; name: string }>;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ previousTotal: number; newTotal: number; difference: number } | null>(null);

  const [vehicleId, setVehicleId] = useState("");
  const [pickupAt, setPickupAt] = useState("");
  const [returnAt, setReturnAt] = useState("");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [reason, setReason] = useState("");
  // Optional on top of the automatic re-price above — e.g. a negotiated price match
  // or a goodwill discount for the inconvenience of a reassignment. Recorded as its
  // own manual adjustment (positive collects more, negative refunds), same as the
  // Pricing breakdown card's adjustment tool.
  const [priceOverride, setPriceOverride] = useState("");

  function submit(e: React.FormEvent, reassignUnit = false) {
    e.preventDefault();
    setError("");
    setResult(null);
    startTransition(async () => {
      const res = await changeBookingAtPickup({
        bookingId,
        vehicleId: vehicleId ? Number(vehicleId) : undefined,
        pickupAt: pickupAt || undefined,
        returnAt: returnAt || undefined,
        customer: (name || phone) ? { name: name || undefined, phone: phone || undefined } : undefined,
        reason: reason.trim() || undefined,
        reassignUnit,
      });
      if (!res.ok) { setError(res.error); return; }
      if (res.changed) setResult({ previousTotal: res.previousTotal, newTotal: res.newTotal, difference: res.difference });

      if (priceOverride.trim()) {
        const adj = await addManualAdjustment({
          bookingId,
          type: "price_override",
          amount: Number(priceOverride),
          reason: reason.trim() || "Price adjustment on vehicle/date change",
        });
        if (!adj.ok) { setError(adj.error); return; }
        setPriceOverride("");
      }

      router.refresh();
    });
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="btn-secondary px-4 py-2 text-xs">
        Change vehicle / dates / details
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-2 rounded-lg border border-ink-200 p-3">
      <div className="grid gap-2 sm:grid-cols-3">
        <select className="input" value={vehicleId} onChange={(e) => setVehicleId(e.target.value)}>
          <option value="">Keep current vehicle</option>
          {vehicles.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
        </select>
        <div className="flex gap-1.5">
          <input className="input" type="datetime-local" placeholder="New pickup" value={pickupAt} onChange={(e) => setPickupAt(e.target.value)} />
          <button
            type="button"
            title="Set pickup to right now — for a customer taking the vehicle immediately"
            onClick={() => {
              const now = new Date();
              now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
              setPickupAt(now.toISOString().slice(0, 16));
            }}
            className="shrink-0 rounded-lg border border-ink-300 bg-ink-50 px-2.5 text-xs font-semibold text-ink-700 hover:bg-ink-100"
          >
            Now
          </button>
        </div>
        <input className="input" type="datetime-local" placeholder="New return" value={returnAt} onChange={(e) => setReturnAt(e.target.value)} />
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        <input className="input" placeholder="Correct name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
        <input className="input" placeholder="Correct phone (optional)" value={phone} onChange={(e) => setPhone(e.target.value)} />
        <input className="input" placeholder="Reason" value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
      <div>
        <input
          className="input"
          type="number"
          placeholder="Price difference override (₹, optional — negative to refund)"
          value={priceOverride}
          onChange={(e) => setPriceOverride(e.target.value)}
        />
      </div>
      {error && <p className="field-error">{error}</p>}
      {result && (
        <p className="text-xs font-medium text-ink-700">
          New total ₹{result.newTotal.toLocaleString("en-IN")} (was ₹{result.previousTotal.toLocaleString("en-IN")}) —{" "}
          {result.difference > 0 ? `collect ₹${result.difference.toLocaleString("en-IN")} more` :
            result.difference < 0 ? `refund ₹${Math.abs(result.difference).toLocaleString("en-IN")}` :
            "no change to the total"}.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={pending} className="btn-secondary px-4 py-2 text-xs">
          {pending ? "Checking availability…" : "Apply change"}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={(e) => submit(e as unknown as React.FormEvent, true)}
          title="The assigned unit is unavailable (stuck out, needs maintenance) — claim a different unit of the SAME vehicle for these dates."
          className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-2 text-xs font-semibold text-amber-800 hover:bg-amber-100 disabled:opacity-50"
        >
          {pending ? "Checking…" : "Reassign to a different unit"}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="px-4 py-2 text-xs text-ink-500 hover:text-ink-900">
          Cancel
        </button>
      </div>
    </form>
  );
}

export function DamageReportForm({ bookingId }: { bookingId: number }) {
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const { pending, error, run } = useAction();
  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!description.trim()) return;
    run(async () => {
      await addDamageReport({ bookingId, description: description.trim(), chargeAmount: Number(amount) || 0 });
      setDescription(""); setAmount("");
    });
  }
  return (
    <form onSubmit={submit} className="space-y-2">
      <div className="grid gap-2 sm:grid-cols-[1fr_140px]">
        <input className="input" placeholder="Damage description" value={description} onChange={(e) => setDescription(e.target.value)} />
        <input className="input" type="number" placeholder="Charge ₹" value={amount} onChange={(e) => setAmount(e.target.value)} />
      </div>
      {error && <p className="field-error">{error}</p>}
      <button type="submit" disabled={pending} className="btn-secondary px-4 py-2 text-xs">Add damage report</button>
    </form>
  );
}

export function PaymentForm({ bookingId }: { bookingId: number }) {
  const [form, setForm] = useState<{
    amount: string;
    kind: string;
    method: string;
    dueDate: string;
    notes: string;
    status: "Paid" | "Pending";
  }>({ amount: "", kind: "advance", method: "UPI", dueDate: "", notes: "", status: "Paid" });
  const { pending, error, run } = useAction();
  function submit(e: React.FormEvent) {
    e.preventDefault();
    const amount = Number(form.amount);
    if (!amount || amount <= 0) return;
    run(async () => {
      await addPayment({
        bookingId,
        amount,
        kind: form.kind,
        method: form.method,
        dueDate: form.dueDate || undefined,
        notes: form.notes || undefined,
        status: form.status,
      });
      setForm({ ...form, amount: "", notes: "" });
    });
  }
  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-5">
        <div>
          <label className="label">Amount *</label>
          <input className="input" type="number" min={1} value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
        </div>
        <div>
          <label className="label">Status</label>
          <select className="input" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as "Paid" | "Pending" })}>
            <option value="Paid">Paid (Collected)</option>
            <option value="Pending">Pending (Due)</option>
          </select>
        </div>
        <div>
          <label className="label">Kind</label>
          <select className="input" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
            {["advance", "full", "deposit", "extra_charge"].map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Method</label>
          <select className="input" value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })}>
            {["UPI", "Card", "Cash", "Net banking", "Wallet"].map((m) => <option key={m}>{m}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Due date</label>
          <input className="input" type="date" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} />
        </div>
      </div>
      {error && <p className="field-error">{error}</p>}
      <button type="submit" disabled={pending} className="btn-primary px-4 py-2 text-xs">Add payment entry</button>
    </form>
  );
}

export function MarkPaidButton({ id }: { id: number }) {
  const { pending, run } = useAction();
  return (
    <button type="button" disabled={pending} onClick={() => run(() => markPaymentPaid(id))} className="btn-primary px-4 py-2 text-xs">
      {pending ? "…" : "Mark as paid"}
    </button>
  );
}

/** Staff-side counterpart to the customer's own self-service refund request — for a
 * phone/WhatsApp complaint or walk-in where the customer can't or won't use the portal.
 * Lands as "Requested" and goes through the same manager-decide / finance-complete
 * pipeline as any customer-raised refund (see /dashboard/refunds). */
export function RaiseRefundForm({ bookingId, paidAmount }: { bookingId: number; paidAmount: number }) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState(String(paidAmount));
  const [reason, setReason] = useState("");
  const { pending, error, run, setError } = useAction();
  const [refundNo, setRefundNo] = useState("");

  function submit(e: React.FormEvent) {
    e.preventDefault();
    // These used to fail silently (a bare `return`) — from the outside that looked
    // exactly like "submitting doesn't work", with no clue why.
    if (!reason.trim()) { setError("A reason is required."); return; }
    const value = Number(amount);
    if (!amount || !(value > 0)) { setError("Enter a refund amount greater than zero."); return; }
    if (value > paidAmount) {
      setError(`Refund amount can't exceed what was actually paid (₹${paidAmount.toLocaleString("en-IN")}).`);
      return;
    }
    run(async () => {
      const res = await raiseRefund({ bookingId, reason: reason.trim(), amount: value });
      if (res.ok) {
        setRefundNo(res.refundNo);
        setReason("");
        setOpen(false);
      }
      return res;
    });
  }

  if (!open) {
    return (
      <div>
        <button type="button" onClick={() => setOpen(true)} className="btn-secondary px-4 py-2 text-xs">
          Raise Refund
        </button>
        {refundNo && (
          <p className="mt-2 text-xs font-medium text-emerald-700">
            ✓ {refundNo} raised — a manager needs to approve it on the Refunds page before it can be paid out.
          </p>
        )}
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-2 rounded-lg border border-ink-200 p-3">
      <div className="grid gap-2 sm:grid-cols-2">
        <input
          className="input"
          type="number"
          max={paidAmount}
          placeholder={`Refund amount (max ₹${paidAmount.toLocaleString("en-IN")})`}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
        <input className="input" placeholder="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
      {error && <p className="field-error">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={pending} className="btn-primary px-4 py-2 text-xs">
          {pending ? "Raising…" : "Submit refund request"}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="px-4 py-2 text-xs text-ink-500 hover:text-ink-900">
          Cancel
        </button>
      </div>
    </form>
  );
}

export function RefundDecisionForm({ id, requested, maxAmount }: { id: number; requested: number; maxAmount: number }) {
  const [amount, setAmount] = useState(String(Math.min(requested, maxAmount)));
  const [notes, setNotes] = useState("");
  const { pending, error, run, setError } = useAction();

  function decide(decision: "Approved" | "Partially approved" | "Rejected", value: number) {
    if (decision !== "Rejected" && value > maxAmount) {
      setError(`Approved amount can't exceed what was actually paid (₹${maxAmount.toLocaleString("en-IN")}).`);
      return;
    }
    run(() => decideRefund(id, decision, value, notes || undefined));
  }

  return (
    <div className="space-y-2">
      <div className="grid gap-2 sm:grid-cols-2">
        <input className="input" type="number" max={maxAmount} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={`Approved amount (max ₹${maxAmount.toLocaleString("en-IN")})`} />
        <input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Admin notes" />
      </div>
      {error && <p className="field-error">{error}</p>}
      <div className="flex gap-2">
        <button type="button" disabled={pending} onClick={() => decide("Approved", Number(amount))} className="btn-primary px-4 py-2 text-xs">Approve</button>
        <button type="button" disabled={pending} onClick={() => decide("Partially approved", Number(amount))} className="btn-secondary px-4 py-2 text-xs">Partial approve</button>
        <button type="button" disabled={pending} onClick={() => decide("Rejected", 0)} className="btn-secondary px-4 py-2 text-xs">Reject</button>
      </div>
    </div>
  );
}

export function CompleteRefundForm({ id }: { id: number }) {
  const [method, setMethod] = useState("UPI");
  const [ref, setRef] = useState("");
  const { pending, error, run, setError } = useAction();
  function submit(e: React.FormEvent) {
    e.preventDefault();
    // Same silent-return bug as the two refund forms above — a blank reference used
    // to just do nothing, with no indication why.
    if (!ref.trim()) { setError("A transaction reference is required."); return; }
    run(() => completeRefund(id, method, ref.trim()));
  }
  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
      <select className="input w-auto" value={method} onChange={(e) => setMethod(e.target.value)}>
        {["UPI", "Bank transfer", "Card reversal", "Cash"].map((m) => <option key={m}>{m}</option>)}
      </select>
      <input className="input w-auto" placeholder="Transaction reference" value={ref} onChange={(e) => setRef(e.target.value)} />
      {error && <p className="field-error">{error}</p>}
      <button type="submit" disabled={pending} className="btn-primary px-4 py-2 text-xs">Mark refund completed</button>
    </form>
  );
}

export function ProblemTicketForm({
  id, staff, vehicles, currentStatus, currentAssignee, currentReplacement, currentNotes,
}: {
  id: number;
  staff: Array<{ id: number; name: string }>;
  vehicles: Array<{ id: number; name: string }>;
  currentStatus?: string;
  currentAssignee?: number | null;
  currentReplacement?: number | null;
  currentNotes?: string | null;
}) {
  const { pending, error, run } = useAction();
  const [status, setStatus] = useState(currentStatus ?? "");
  const [assignee, setAssignee] = useState(currentAssignee ? String(currentAssignee) : "");
  const [replacement, setReplacement] = useState(currentReplacement ? String(currentReplacement) : "");
  const [notes, setNotes] = useState(currentNotes ?? "");
  function submit(e: React.FormEvent) {
    e.preventDefault();
    run(() => updateProblemTicket(id, {
      status: status || undefined,
      assignedTo: assignee ? Number(assignee) : undefined,
      replacementVehicleId: replacement ? Number(replacement) : undefined,
      resolutionNotes: notes || undefined,
    }));
  }
  return (
    <form onSubmit={submit} className="space-y-2">
      <div className="grid gap-2 sm:grid-cols-3">
        <select className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Change status…</option>
          {["Open", "In progress", "Resolved", "Cancelled"].map((s) => <option key={s}>{s}</option>)}
        </select>
        <select className="input" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
          <option value="">Assign to…</option>
          {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <select className="input" value={replacement} onChange={(e) => setReplacement(e.target.value)}>
          <option value="">Replacement vehicle…</option>
          {vehicles.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
        </select>
      </div>
      <textarea className="input min-h-14" placeholder="Resolution notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
      {error && <p className="field-error">{error}</p>}
      <button type="submit" disabled={pending} className="btn-primary px-4 py-2 text-xs">Update ticket</button>
    </form>
  );
}
