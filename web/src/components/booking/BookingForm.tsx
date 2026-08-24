"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { formatINR, formatDate, formatTimeLabel, waLink, getLiveClockMinPickup, compute25HourAutoReturn } from "@/lib/utils";
import { saveBookingDraft, getDraft, submitBooking, getAvailableVehicles, getQuoteEstimate, getVehicleById } from "@/lib/booking-actions";
import { RazorpayCheckout } from "./RazorpayCheckout";
import { InlineInvoiceCard } from "./InlineInvoiceCard";
import type { Vehicle } from "@/lib/data";
import { calculateRentalQuoteFromStrings, istInstantFrom } from "@/lib/pricing";
import { computeRentalDays, toCanonicalIstIso } from "@/lib/rental-clock";
import { compressImageFile } from "@/lib/image-compression";

type Category = { id: number; name: string; kind: string; icon: string | null };
type Quote = Awaited<ReturnType<typeof getQuoteEstimate>>;

const STEP_LABELS = ["Rental period", "Choose vehicle", "Your details", "Documents", "Review & confirm", "Payment"];
const STANDARD_PICKUP_TIME = "08:00";
const DEFAULT_TERMS = [
  "Valid original Driving Licence & Government ID (Aadhaar/Passport) mandatory for vehicle handover.",
  "Included drive limit per day. Driving beyond this limit is charged per KM.",
  "Fuel policy: Return the vehicle with the same fuel level as provided at pickup.",
  "Security deposit is paid in cash at pickup (not online) and is fully refundable upon safe vehicle return inspection.",
  "Returning after the standard 8:00 AM drop time adds one full additional rental day at that day's rate.",
  "In case of any accident or damages, notify the owner immediately and do not do anything on your own.",
];

function todayISO() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}

function combineIso(dateStr: string, timeStr: string) {
  return toCanonicalIstIso(dateStr, timeStr) || `${dateStr}T${timeStr}:00+05:30`;
}

function parseDateParts(dateStr: string): { year: number; month: number; day: number; dateObj: Date } | null {
  if (!dateStr) return null;
  const clean = dateStr.includes("T") ? dateStr.split("T")[0] : dateStr;
  const parts = clean.split(/[-/.]/).map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) return null;

  let y: number, m: number, d: number;
  if (parts[0] > 1000) {
    // YYYY-MM-DD
    y = parts[0];
    m = parts[1];
    d = parts[2];
  } else if (parts[2] > 1000) {
    // DD-MM-YYYY
    y = parts[2];
    m = parts[1];
    d = parts[0];
  } else {
    y = parts[0];
    m = parts[1];
    d = parts[2];
  }
  const dateObj = new Date(y, m - 1, d);
  return { year: y, month: m, day: d, dateObj };
}

function getDayOfWeek(dateStr: string): number {
  const p = parseDateParts(dateStr);
  if (!p) return -1;
  return p.dateObj.getDay(); // 0=Sun, 1=Mon, ..., 5=Fri, 6=Sat
}

function getDayName(dateStr: string): string {
  const day = getDayOfWeek(dateStr);
  if (day < 0 || day > 6) return "";
  const names = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  return names[day] ?? "";
}

function addDaysISO(dateStr: string, numDays: number): string {
  const p = parseDateParts(dateStr);
  if (!p) return dateStr;
  const d = new Date(p.year, p.month - 1, p.day);
  d.setDate(d.getDate() + numDays);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const date = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${date}`;
}

function maxDobISO() {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 18);
  return d.toISOString().slice(0, 10);
}

function formatDlNumber(val: string): string {
  const clean = val.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (clean.length <= 4) return clean;
  return `${clean.slice(0, 4)} ${clean.slice(4, 15)}`;
}

/**
 * The client-side quote. It no longer does any pricing arithmetic of its own — the maths
 * lives in @/lib/pricing (which mirrors the CRM), so what the form shows is what the CRM
 * charges. The previous local copy invented a ₹50 weekend hike, a Sunday-return extra
 * day and a `weekendMinDays: 1`, and folded the deposit into the payable total.
 */
function computeClientQuote(
  vehicle: Vehicle | null | undefined,
  pickupDateStr: string | null,
  pickupTimeStr: string | null,
  returnDateStr: string | null,
  returnTimeStr: string | null
) {
  if (!vehicle) return null;
  return calculateRentalQuoteFromStrings(vehicle, pickupDateStr, pickupTimeStr, returnDateStr, returnTimeStr);
}

function formatDisplayDate(dateStr: string | null | undefined): string {
  if (!dateStr) return "—";
  const parts = parseDateParts(dateStr);
  if (!parts) return dateStr;
  return parts.dateObj.toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Kolkata",
  });
}

export function BookingForm({
  categories,
  businessWhatsapp,
  terms,
  initialVehicles = [],
  branches = [],
}: {
  categories: Category[];
  businessWhatsapp: string;
  terms: string[];
  initialVehicles?: Vehicle[];
  branches?: Array<{ id: number; name: string; city?: string | null; address?: string | null; phone?: string | null; active?: number; blocked?: number }>;
}) {
  const router = useRouter();
  const search = useSearchParams();
  // If the user already provided search query details and selected a vehicle,
  // take them directly to Step 3 (Customer Details) to proceed seamlessly.
  const initialStep = useMemo(() => {
    if (search.get("resume")) return 1;
    const explicitStep = Number(search.get("step"));
    if (explicitStep && explicitStep >= 1 && explicitStep <= 5) return explicitStep;
    if (search.get("vehicle")) {
      if (search.get("pickup") && search.get("return")) {
        return 3;
      }
      return 2;
    }
    return 1;
  }, [search]);

  const [step, setStep] = useState(initialStep);
  const [token, setToken] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [lastSaved, setLastSaved] = useState<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [categoryKind, setCategoryKind] = useState(search.get("kind") ?? "");
  const branchParam = search.get("branch") || search.get("branchId") || search.get("location");
  const initialLoc = branchParam === "1" || (branchParam && branchParam.toUpperCase().includes("SAKLESH")) ? "SAKLESHPURA" : "HASSAN";
  const [location, setLocation] = useState(initialLoc);

  const selectedBranchId = useMemo(() => {
    return location.toUpperCase().includes("SAKLESH") ? 1 : 2;
  }, [location]);

  const activeBranch = useMemo(() => {
    return branches.find((b) => Number(b.id) === selectedBranchId) ?? null;
  }, [branches, selectedBranchId]);

  const isSelectedBranchBlocked = useMemo(() => {
    return activeBranch ? Number((activeBranch as any).blocked) === 1 : false;
  }, [activeBranch]);

  const liveClock = useMemo(() => getLiveClockMinPickup(), []);

  const initialPickup = search.get("pickup") ?? liveClock.minPickupDate;
  const initialPickupTime = search.get("pickupTime") ?? STANDARD_PICKUP_TIME;

  const initialAutoReturn = compute25HourAutoReturn(initialPickup, initialPickupTime);
  const initialReturnDate = search.get("return") ?? initialAutoReturn.returnDate;
  const initialReturnTime = search.get("returnTime") ?? initialAutoReturn.returnTime;

  const [pickupDate, setPickupDate] = useState(initialPickup);
  const [pickupTime, setPickupTime] = useState(initialPickupTime);
  const [returnDate, setReturnDate] = useState(initialReturnDate);
  const [returnTime, setReturnTime] = useState(initialReturnTime);
  const [passengers, setPassengers] = useState("");

  const isFriday = useMemo(() => getDayOfWeek(pickupDate) === 5, [pickupDate]);
  const isSaturday = useMemo(() => getDayOfWeek(pickupDate) === 6, [pickupDate]);
  const isSundayReturn = useMemo(() => getDayOfWeek(returnDate) === 0, [returnDate]);
  const pickupDayLabel = useMemo(() => getDayName(pickupDate), [pickupDate]);
  const returnDayLabel = useMemo(() => getDayName(returnDate), [returnDate]);

  const minReturnDate = useMemo(() => {
    return pickupDate;
  }, [pickupDate]);

  const pickupAt = combineIso(pickupDate, pickupTime);
  const returnAt = combineIso(returnDate, returnTime);

  // 08:00 → 08:00 IST day counting, shared with the CRM. A drop after 08:00 adds one
  // whole charged day; nothing else does.
  const days = useMemo(() => {
    const p = istInstantFrom(pickupDate, pickupTime);
    const r = istInstantFrom(returnDate, returnTime);
    if (!p || !r) return 1;
    return computeRentalDays({ pickupAt: p, returnAt: r, pickupTimeHM: pickupTime, returnTimeHM: returnTime }).days;
  }, [pickupDate, pickupTime, returnDate, returnTime]);

  // Day count for a candidate return date, using the same rental clock that prices the
  // booking — so a "2 Days" badge on a drop-off option can never disagree with the
  // amount the customer is actually charged.
  const daysForReturn = (candidateReturnDate: string): number => {
    const p = istInstantFrom(pickupDate, pickupTime);
    const r = istInstantFrom(candidateReturnDate, returnTime);
    if (!p || !r) return 1;
    return computeRentalDays({ pickupAt: p, returnAt: r, pickupTimeHM: pickupTime, returnTimeHM: returnTime }).days;
  };

  const [vehicleId, setVehicleId] = useState<number | null>(search.get("vehicle") ? Number(search.get("vehicle")) : null);
  const [availableVehicles, setAvailableVehicles] = useState<Vehicle[]>(initialVehicles);
  const [loadingVehicles, setLoadingVehicles] = useState(false);
  const [quote, setQuote] = useState<Quote | null>(null);

  const [contact, setContact] = useState({ name: "", phone: "", email: "", address: "", dob: "", emergencyContact: "" });
  const [documents, setDocuments] = useState<Record<string, { url: string; number?: string; expiry?: string }>>({});
  const [uploading, setUploading] = useState<string | null>(null);
  const [uploadErrors, setUploadErrors] = useState<Record<string, string>>({});
  const [termsAccepted, setTermsAccepted] = useState(false);

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ bookingId: number; bookingNo: string } | null>(null);
  const [paid, setPaid] = useState(false);

  const handlePickupDateChange = (newDate: string) => {
    const validDate = newDate < liveClock.minPickupDate ? liveClock.minPickupDate : newDate;
    setPickupDate(validDate);
    const validTime = liveClock.getValidPickupTime(pickupTime, validDate);
    setPickupTime(validTime);

    const auto = compute25HourAutoReturn(validDate, validTime);
    setReturnDate(auto.returnDate);
    setReturnTime(auto.returnTime);
  };

  const handlePickupTimeChange = (newTime: string) => {
    const validTime = liveClock.getValidPickupTime(newTime, pickupDate);
    setPickupTime(validTime);

    const auto = compute25HourAutoReturn(pickupDate, validTime);
    setReturnDate(auto.returnDate);
    setReturnTime(auto.returnTime);
  };

  const handleReturnDateChange = (newReturnDate: string) => {
    const targetDate = newReturnDate < minReturnDate ? minReturnDate : newReturnDate;
    setReturnDate(targetDate);

    // A Sunday drop cannot be earlier than 09:00. Moving the date onto a Sunday
    // would otherwise leave an already-selected 07:00/08:00 in state even though
    // the option is no longer listed, submitting a time the counter won't accept.
    if (getDayOfWeek(targetDate) === 0 && returnTime < "09:00") {
      setReturnTime("09:00");
      return;
    }

    const isSameDay = pickupDate && targetDate && pickupDate === targetDate;
    if (isSameDay && returnTime <= pickupTime) {
      const validReturnHour = Math.min(23, parseInt(pickupTime.split(":")[0], 10) + 1);
      setReturnTime(`${String(validReturnHour).padStart(2, "0")}:00`);
    }
  };

  // Resume from a draft token in the URL, or restore from sessionStorage/localStorage.
  useEffect(() => {
    const resumeToken = search.get("resume");
    if (resumeToken) {
      getDraft(resumeToken).then((draft) => {
        if (!draft) return;
        setToken(resumeToken);
        setCategoryKind(String(draft.categoryId ?? categoryKind));
        setLocation(draft.location ?? "");
        if (draft.pickupAt) {
          const [d, t] = draft.pickupAt.split("T");
          setPickupDate(d ?? todayISO());
          setPickupTime(t ?? STANDARD_PICKUP_TIME);
        }
        if (draft.returnAt) {
          const [rd, rt] = draft.returnAt.split("T");
          setReturnDate(rd ?? todayISO());
          setReturnTime(rt ?? STANDARD_PICKUP_TIME);
        }
        setPassengers(draft.passengers ? String(draft.passengers) : "");
        setVehicleId(draft.vehicleId);
        setContact(draft.contact as typeof contact);
        setStep(draft.step || 1);
      });
      return;
    }

    // URL params are the primary source. For anything NOT in URL, try sessionStorage search context first, then localStorage draft.
    try {
      const cached = sessionStorage.getItem("darshh_search_context");
      if (cached) {
        const ctx = JSON.parse(cached);
        if (!search.get("pickup") && ctx.pickupDate) setPickupDate(ctx.pickupDate);
        if (!search.get("pickupTime") && ctx.pickupTime) setPickupTime(ctx.pickupTime);
        if (!search.get("return") && ctx.returnDate) setReturnDate(ctx.returnDate);
        if (!search.get("returnTime") && ctx.returnTime) setReturnTime(ctx.returnTime);
        if (!search.get("kind") && ctx.kind) setCategoryKind(ctx.kind);
        if (!search.get("location") && ctx.location) setLocation(ctx.location);
      }
    } catch {}

    const local = localStorage.getItem("darshh_booking_draft");
    if (local) {
      try {
        const draft = JSON.parse(local);
        if (!search.get("kind") && draft.categoryKind) setCategoryKind(draft.categoryKind);
        if (draft.location) setLocation(draft.location);
        if (!search.get("pickup") && draft.pickupDate) setPickupDate(draft.pickupDate);
        if (!search.get("pickupTime") && draft.pickupTime) setPickupTime(draft.pickupTime);
        if (!search.get("return") && draft.returnDate) setReturnDate(draft.returnDate);
        if (!search.get("returnTime") && draft.returnTime) setReturnTime(draft.returnTime);
        if (draft.passengers) setPassengers(draft.passengers);
        if (!search.get("vehicle") && draft.vehicleId) setVehicleId(draft.vehicleId);
        if (draft.contact) setContact(draft.contact);
      } catch {
        // ignore corrupt draft
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Autosave (localStorage instantly, server debounced) whenever key fields change.
  useEffect(() => {
    if (result || step === 6) return;
    localStorage.setItem("darshh_booking_draft", JSON.stringify({ categoryKind, location, pickupDate, pickupTime, returnDate, returnTime, passengers, vehicleId, contact }));
    if (!contact.name && !contact.phone && !vehicleId) return;
    setSaveStatus("saving");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try {
        const res = await saveBookingDraft({
          token, categoryId: null, vehicleId, pickupAt: pickupAt || null, returnAt: returnAt || null,
          location, passengers: passengers ? Number(passengers) : null, step, contact,
        });
        setToken(res.token);
        setSaveStatus("saved");
        setLastSaved(new Date().toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" }));
      } catch {
        setSaveStatus("error");
      }
    }, 1600);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categoryKind, location, pickupDate, pickupTime, returnDate, returnTime, passengers, vehicleId, contact, step, result]);

  // Load available vehicles for step 2 vehicle picker.
  const vehiclesFetchedRef = useRef(false);
  useEffect(() => {
    if (step === 2 || (!vehiclesFetchedRef.current && vehicleId)) {
      vehiclesFetchedRef.current = true;
      setLoadingVehicles(true);
      getAvailableVehicles(null, pickupAt || null, returnAt || null, location || null)
        .then((res) => { if (res && res.length > 0) setAvailableVehicles(res); })
        .finally(() => setLoadingVehicles(false));
    }
  }, [step, pickupAt, returnAt, vehicleId, location]);

  // Live quote when vehicle + dates are known.
  useEffect(() => {
    if (!vehicleId || !pickupAt || !returnAt) { setQuote(null); return; }
    getQuoteEstimate(vehicleId, pickupAt, returnAt).then(setQuote);
  }, [vehicleId, pickupAt, returnAt]);

  // Fetched independently of the availability list, so the vehicle summary still
  // shows correctly even when arriving directly on a later step (resume link, etc.).
  const [fetchedVehicle, setFetchedVehicle] = useState<Vehicle | null>(null);
  useEffect(() => {
    if (!vehicleId) { setFetchedVehicle(null); return; }
    getVehicleById(vehicleId).then(setFetchedVehicle);
  }, [vehicleId]);

  // Resolve selectedVehicle: initialVehicles (instant SSR), then availableVehicles, then fetchedVehicle
  const selectedVehicle = useMemo(() => {
    const numId = Number(vehicleId);
    if (!numId || isNaN(numId)) return undefined;
    return initialVehicles.find((v) => Number(v.id) === numId)
      ?? availableVehicles.find((v) => Number(v.id) === numId)
      ?? (Number(fetchedVehicle?.id) === numId ? fetchedVehicle : undefined);
  }, [vehicleId, initialVehicles, availableVehicles, fetchedVehicle]);

  const clientQuote = useMemo(() => {
    return computeClientQuote(selectedVehicle, pickupDate, pickupTime, returnDate, returnTime);
  }, [selectedVehicle, pickupDate, pickupTime, returnDate, returnTime]);

  const activeQuote = clientQuote ?? quote;

  // The ONLY figure that may be charged online. The security deposit is cash at pickup.
  const payNowAmount = activeQuote?.payableNow ?? 0;
  const depositAtPickup = activeQuote?.depositPayableAtPickup ?? activeQuote?.depositAmount ?? 0;

  // Only the DRIVER's three documents are mandatory. Pillion documents remain
  // available to upload — a customer travelling with a passenger can provide them —
  // but they must never block a booking, since most rides are solo.
  const kycComplete = Boolean(
    (documents.licence?.url || documents.driver_licence?.url) &&
    (documents.govt_id?.url || documents.driver_govt_id?.url) &&
    documents.driver_photo?.url
  );

  // Guard against direct deep links or skipped steps when a vehicle is unavailable or branch is blocked
  useEffect(() => {
    // Once booking is submitted, in payment step, or in submission transit, never kick back
    if (result || submitting || step < 3 || step > 5) return;

    if (isSelectedBranchBlocked) {
      setStep(1);
      setErrors((prev) => ({
        ...prev,
        location: `Bookings are temporarily suspended at ${activeBranch?.name || "this branch"}. Please choose another branch.`,
      }));
    } else if (selectedVehicle) {
      const isVehicleUnavailable =
        selectedVehicle.status === "unavailable" ||
        selectedVehicle.status === "blocked" ||
        selectedVehicle.status === "maintenance" ||
        selectedVehicle.status === "inactive" ||
        selectedVehicle.status === "archived" ||
        Number(selectedVehicle.active) === 0;

      if (isVehicleUnavailable) {
        setStep(2);
        setErrors((prev) => ({
          ...prev,
          vehicle: "The selected vehicle is currently unavailable. Please choose another vehicle.",
        }));
      }
    }
  }, [step, isSelectedBranchBlocked, selectedVehicle, activeBranch, result, submitting]);

  function validateStep(n: number): boolean {
    const e: Record<string, string> = {};
    if (n === 1) {
      if (!pickupDate) e.pickupDate = "Please select a pickup date.";
      if (isSelectedBranchBlocked) e.location = `Bookings are temporarily suspended at ${activeBranch?.name || "this branch"}. Please choose another branch.`;
      if (days < 1) e.days = "Minimum 1 day.";
      if (activeQuote?.belowWeekendMinimum) e.days = `Weekend bookings need at least ${activeQuote.weekendMinDays} days.`;
    }
    if (n === 2) {
      if (!vehicleId) {
        e.vehicle = "Please select a vehicle.";
      } else {
        const isVehicleUnavailable =
          !selectedVehicle ||
          selectedVehicle.status === "unavailable" ||
          selectedVehicle.status === "blocked" ||
          selectedVehicle.status === "maintenance" ||
          selectedVehicle.status === "inactive" ||
          selectedVehicle.status === "archived" ||
          Number(selectedVehicle.active) === 0;

        const isOutOfStock =
          isSelectedBranchBlocked ||
          isVehicleUnavailable ||
          (selectedVehicle.available_units !== undefined && selectedVehicle.available_units <= 0);

        if (isOutOfStock) {
          e.vehicle = "The selected vehicle is currently unavailable or the branch is temporarily blocked. Please choose another vehicle or branch.";
        }
      }
    }
    if (n === 3) {
      if (contact.name.trim().length < 2) e.name = "Enter your full name.";
      if (!/^[+\d][\d\s-]{8,15}$/.test(contact.phone.trim())) e.phone = "Enter a valid mobile number.";
    }
    if (n === 4) {
      if (!kycComplete) {
        e.documents = "Please upload the Driver Licence, Driver Government ID and Driver Passport Photo before proceeding.";
      }
      const dlNum = documents.licence?.number?.trim() ?? "";
      if (!dlNum) {
        e.licenceNumber = "Please enter your driver licence number.";
      } else if (!/^[A-Z]{2}\d{2} \d{11}$/.test(dlNum)) {
        e.licenceNumber = "Driver licence number must be in format: XX00 00000000000 (e.g. KA04 12345678901 — 2 capital letters, 2 digits, space, 11 digits).";
      }
      const dlExpiry = documents.licence?.expiry ?? "";
      if (!dlExpiry) {
        e.licenceExpiry = "Please enter your driver licence expiry date.";
      } else if (dlExpiry < returnDate) {
        e.licenceExpiry = "Your driver's licence expires before or during your return date. A licence valid throughout the rental duration is required.";
      }
    }
    if (n === 5 && !termsAccepted) e.terms = "Please accept the terms and conditions to continue.";
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  function next() {
    if (!validateStep(step)) return;
    setStep((s) => Math.min(s + 1, 6));
  }
  function back() { setStep((s) => Math.max(s - 1, 1)); }

  async function upload(kind: string, file: File) {
    setUploading(kind);
    setUploadErrors((e) => ({ ...e, [kind]: "" }));
    try {
      const compressed = await compressImageFile(file, 1600, 0.8);
      const fd = new FormData();
      fd.append("file", compressed);
      const res = await fetch("/api/upload", { method: "POST", body: fd });
      const contentType = res.headers.get("content-type") ?? "";
      if (!contentType.includes("application/json")) {
        throw new Error(`Upload server returned an unexpected response (${res.status}). Please try again.`);
      }
      const data = await res.json();
      if (!res.ok || !data?.path) {
        throw new Error(data?.error || "Upload failed. Please try again or use a smaller image.");
      }
      setDocuments((d) => ({ ...d, [kind]: { ...d[kind], url: data.path } }));
    } catch (err) {
      // A silent failure here previously left the customer staring at an "Upload"
      // button with no explanation and no document on file — this is the fix.
      setUploadErrors((e) => ({ ...e, [kind]: err instanceof Error ? err.message : "Upload failed. Please try again." }));
    } finally {
      setUploading(null);
    }
  }

  async function submit() {
    if (!validateStep(5) || !vehicleId) return;

    if (isSelectedBranchBlocked) {
      setSubmitError(`Bookings are temporarily suspended at ${activeBranch?.name || "this branch"}. Please select another branch.`);
      return;
    }

    if (
      !selectedVehicle ||
      selectedVehicle.status === "unavailable" ||
      selectedVehicle.status === "blocked" ||
      selectedVehicle.status === "maintenance" ||
      selectedVehicle.status === "inactive" ||
      selectedVehicle.status === "archived" ||
      Number(selectedVehicle.active) === 0 ||
      (selectedVehicle.available_units !== undefined && selectedVehicle.available_units <= 0)
    ) {
      setSubmitError("The selected vehicle is currently unavailable for booking. Please choose another vehicle.");
      return;
    }

    setSubmitting(true);
    setSubmitError("");
    const res = await submitBooking({
      token: token ?? "",
      vehicleId, pickupAt, returnAt, location, passengers: passengers ? Number(passengers) : null,
      contact, termsAccepted,
      documents: Object.entries(documents).filter(([, v]) => v.url).map(([kind, v]) => ({ kind, url: v.url, number: v.number, expiry: v.expiry })),
    });
    setSubmitting(false);
    if (!res.ok || !res.bookingId) { setSubmitError(res.error ?? "Something went wrong."); return; }
    localStorage.removeItem("darshh_booking_draft");
    setResult({ bookingId: res.bookingId, bookingNo: res.bookingNo! });
    setStep(6);
  }

  const resumeLink = token ? `${typeof window !== "undefined" ? window.location.origin : ""}/booking?resume=${token}` : "";

  if (step === 6 && result) {
    return (
      <div className="mx-auto max-w-xl">
        {!paid ? (
          <div className="card p-6 sm:p-8">
            <h2 className="font-display text-2xl font-semibold text-ink-900">Booking received — {result.bookingNo}</h2>
            <p className="mt-2 text-sm text-ink-600">Complete your online payment now to confirm your vehicle reservation instantly.</p>
            <p className="mt-1 text-sm text-ink-600">
              Pay now online: <strong>{formatINR(payNowAmount)}</strong> · Security deposit (cash at pickup, refundable): <strong>{formatINR(depositAtPickup)}</strong>
            </p>
            <div className="mt-6">
              <RazorpayCheckout
                bookingId={result.bookingId}
                amountDue={payNowAmount}
                customerName={contact.name}
                customerPhone={contact.phone}
                customerEmail={contact.email}
                quote={activeQuote}
                onPaid={() => setPaid(true)}
                onPayLater={() => setPaid(true)}
              />
            </div>
          </div>
        ) : (
          <div>
            <div className="text-center">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100 text-2xl text-emerald-700">✓</div>
              <h2 className="mt-4 font-display text-2xl font-semibold text-ink-900">You&apos;re all set!</h2>
              <p className="mt-1.5 text-xs text-ink-600">Your booking number is <strong>{result.bookingNo}</strong>. Here is your official payment tax invoice.</p>
              <div className="mt-4 flex flex-col gap-2.5 sm:flex-row sm:justify-center">
                <Link href={`/track/${result.bookingNo}`} className="btn-primary py-2 px-4 text-xs font-bold bg-brand-500 text-ink-950 shadow-sm">
                  Track Booking Status 📍
                </Link>
                <a href={waLink(businessWhatsapp, `Hi, this is regarding my booking ${result.bookingNo}`)} target="_blank" rel="noopener noreferrer" className="btn-secondary py-2 text-xs">Message us on WhatsApp 💬</a>
                <Link href="/customer/portal" className="btn-secondary py-2 text-xs">Customer Portal ↗</Link>
              </div>
            </div>

            {/* Official Itemized Tax Invoice Card with Download / Save PDF Option */}
            <InlineInvoiceCard
              bookingNo={result.bookingNo}
              bookingId={result.bookingId}
              customerName={contact.name}
              customerPhone={contact.phone}
              customerEmail={contact.email}
              quote={activeQuote}
              amountPaid={payNowAmount}
            />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl">
      {/* Progress */}
      <ol className="mb-8 flex flex-wrap items-center gap-2 text-xs font-semibold text-ink-400">
        {STEP_LABELS.slice(0, 5).map((label, i) => (
          <li key={label} className={`rounded-full px-3 py-1.5 ${step === i + 1 ? "bg-brand-500 text-ink-950" : step > i + 1 ? "bg-emerald-100 text-emerald-700" : "bg-ink-100"}`}>
            {i + 1}. {label}
          </li>
        ))}
      </ol>

      <div className="mb-4 text-xs text-ink-400" aria-live="polite">
        {saveStatus === "saving" && "Saving…"}
        {saveStatus === "saved" && `Draft saved${lastSaved ? ` at ${lastSaved}` : ""}`}
        {saveStatus === "error" && "Unable to save — your progress is still kept on this device."}
        {resumeLink && saveStatus === "saved" && (
          <button type="button" className="ml-2 font-semibold text-brand-700 hover:underline" onClick={() => navigator.clipboard?.writeText(resumeLink)}>
            Copy resume link
          </button>
        )}
      </div>

      {/* Persistent reminder of what's being booked */}
      {step >= 3 && selectedVehicle && (
        <div className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-ink-100 bg-white p-3.5 shadow-sm">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-ink-900">{selectedVehicle.name}</p>
            <p className="truncate text-xs text-ink-500">{days} day{days > 1 ? "s" : ""} · {formatDate(pickupAt)} → {formatDate(returnAt)}</p>
          </div>
          <button type="button" onClick={() => setStep(2)} className="shrink-0 text-xs font-semibold text-brand-700 hover:underline">Change</button>
        </div>
      )}

      <div className="card p-6 sm:p-8">
        {step === 1 && (
          <div className="space-y-4">
            <h2 className="font-display text-xl font-semibold text-ink-900">When and what do you need?</h2>
            <p className="text-sm text-ink-500">
              The rental day runs 8:00 AM to 8:00 AM. Picking up before 8:00 AM adds a ₹250
              early-pickup fee; returning after 8:00 AM is charged as one additional full day.
              Included drive limit is 100&nbsp;km/day (Bikes &amp; Scooters) / 300&nbsp;km/day
              (Cars &amp; Tempo). Extra KM is ₹4/km for bikes &amp; scooters, ₹8/km for cars.
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="label">Vehicle type</label>
                <select className="input" value={categoryKind} onChange={(e) => setCategoryKind(e.target.value)}>
                  <option value="">Any type</option>
                  {Array.from(new Map(categories.map((c) => [c.kind, c])).values()).map((c) => <option key={c.kind} value={c.kind}>{c.name}</option>)}
                </select>
              </div>
              <div>
                <label className="label">Pickup &amp; Return Branch</label>
                <select
                  className="input font-semibold text-ink-900"
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                >
                  <option value="HASSAN">
                    📍 Hassan Branch (BM Road){branches.find((b) => Number(b.id) === 2 && Number((b as any).blocked) === 1) ? " 🔒 (Temporarily Blocked)" : ""}
                  </option>
                  <option value="SAKLESHPURA">
                    📍 Sakleshpura Branch (Main Road){branches.find((b) => Number(b.id) === 1 && Number((b as any).blocked) === 1) ? " 🔒 (Temporarily Blocked)" : ""}
                  </option>
                </select>
                {isSelectedBranchBlocked && (
                  <div className="mt-2 rounded-xl border border-rose-300 bg-rose-50 p-3 text-xs text-rose-900 flex items-center gap-2">
                    <span className="shrink-0 text-base">⚠️</span>
                    <p className="font-semibold">
                      {activeBranch?.name || "This branch"} is temporarily blocked for new bookings. Please select another branch.
                    </p>
                  </div>
                )}
                {errors.location && <p className="field-error">{errors.location}</p>}
              </div>

              <div>
                <div className="flex items-center justify-between">
                  <label className="label">Pickup date *</label>
                  {pickupDayLabel && (
                    <span className={`text-[11px] font-bold px-2 py-0.5 rounded ${isFriday ? "bg-amber-100 text-amber-800 border border-amber-300" : isSaturday ? "bg-blue-100 text-blue-800 border border-blue-300" : "bg-ink-100 text-ink-700"}`}>
                      {pickupDayLabel}
                    </span>
                  )}
                </div>
                <input
                  className="input"
                  type="date"
                  min={liveClock.minPickupDate}
                  value={pickupDate}
                  onChange={(e) => handlePickupDateChange(e.target.value)}
                  aria-invalid={!!errors.pickupDate}
                />
                {errors.pickupDate && <p className="field-error">{errors.pickupDate}</p>}
              </div>
              <div>
                <label className="label">Pickup time</label>
                <select className="input" value={pickupTime} onChange={(e) => handlePickupTimeChange(e.target.value)}>
                  {Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, "0")}:00`).map((t) => {
                    const disabled = liveClock.isTimeDisabled(t, pickupDate);
                    return (
                      <option key={t} value={t} disabled={disabled} className={disabled ? "opacity-30 text-ink-300 bg-ink-50" : ""}>
                        {t === "08:00" ? "8:00 AM (Standard)" : t < "08:00" ? `${formatTimeLabel(t)} (+₹250 Early Pickup)` : formatTimeLabel(t)} {disabled ? " (Passed)" : ""}
                      </option>
                    );
                  })}
                </select>
              </div>

              {/* Friday pickup — the customer chooses which day they bring it back.
                  This used to be a single checkbox that forced a Monday return, with no
                  way to drop on Saturday or Sunday. Day counts below are computed by the
                  same rental clock that prices the booking, so the badge can never
              {/* Friday pickup — customer chooses Saturday or Sunday drop-off */}
              {isFriday && (
                <div className="sm:col-span-2 rounded-xl border border-brand-200 bg-brand-50/70 p-4 shadow-xs">
                  <span className="text-xs font-bold uppercase tracking-wider text-brand-900 block mb-2.5">
                    Select Drop-off Day:
                  </span>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    {[
                      { label: "Saturday Drop-off", date: addDaysISO(pickupDate, 1), accent: "brand" as const, desc: "Standard Drop (Weekend Package: Fri + Sat + Sun)" },
                      { label: "Sunday Drop-off", date: addDaysISO(pickupDate, 2), accent: "amber" as const, desc: "Standard Drop (Weekend Package: Fri + Sat + Sun)" },
                    ].map((opt) => {
                      const selected = returnDate === opt.date;
                      const optDays = daysForReturn(opt.date);
                      return (
                        <button
                          key={opt.label}
                          type="button"
                          onClick={() => handleReturnDateChange(opt.date)}
                          className={`flex flex-col items-start p-3 rounded-xl border text-left transition cursor-pointer ${
                            selected
                              ? opt.accent === "amber"
                                ? "border-amber-500 bg-white ring-2 ring-amber-500 shadow-sm"
                                : "border-brand-600 bg-white ring-2 ring-brand-500 shadow-sm"
                              : "border-ink-200 bg-white/70 hover:bg-white hover:border-brand-300"
                          }`}
                        >
                          <div className="flex items-center gap-1.5 w-full justify-between">
                            <span className="text-xs font-bold text-ink-950">{opt.label}</span>
                            <span
                              className={`rounded px-2 py-0.5 text-[10px] font-extrabold uppercase text-ink-950 ${
                                opt.accent === "amber" ? "bg-amber-500" : "bg-brand-500"
                              }`}
                            >
                              {optDays} {optDays === 1 ? "Day" : "Days"}
                            </span>
                          </div>
                          <span className="text-[11px] text-ink-600 mt-1">
                            {formatDate(opt.date)} · {opt.desc}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  <p className="mt-2.5 text-[11px] text-ink-600">
                    Saturday and Sunday are charged at weekend rates. Returning after 8:00 AM on your
                    drop day adds one more full day.
                  </p>
                </div>
              )}

              {/* Saturday Drop-off Options (Same-day Saturday or Sunday) */}
              {isSaturday && (
                <div className="sm:col-span-2 rounded-xl border border-brand-200 bg-brand-50/70 p-4 shadow-xs">
                  <span className="text-xs font-bold uppercase tracking-wider text-brand-900 block mb-2.5">
                    Select Drop-off Day:
                  </span>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    {[
                      { label: "Saturday Drop-off (Same Day)", date: pickupDate, accent: "brand" as const, desc: "Standard Drop (Weekend Package: Sat + Sun)" },
                      { label: "Sunday Drop-off", date: addDaysISO(pickupDate, 1), accent: "amber" as const, desc: "Standard Drop (Weekend Package: Sat + Sun)" },
                    ].map((opt) => {
                      const selected = returnDate === opt.date;
                      const optDays = daysForReturn(opt.date);
                      return (
                        <button
                          key={opt.label}
                          type="button"
                          onClick={() => handleReturnDateChange(opt.date)}
                          className={`flex flex-col items-start p-3 rounded-xl border text-left transition cursor-pointer ${
                            selected
                              ? opt.accent === "amber"
                                ? "border-amber-500 bg-white ring-2 ring-amber-500 shadow-sm"
                                : "border-brand-600 bg-white ring-2 ring-brand-500 shadow-sm"
                              : "border-ink-200 bg-white/70 hover:bg-white hover:border-amber-300"
                          }`}
                        >
                          <div className="flex items-center gap-1.5 w-full justify-between">
                            <span className="text-xs font-bold text-ink-950">{opt.label}</span>
                            <span
                              className={`rounded px-2 py-0.5 text-[10px] font-extrabold uppercase text-ink-950 ${
                                opt.accent === "amber" ? "bg-amber-500" : "bg-brand-500"
                              }`}
                            >
                              {optDays} Days (Weekend)
                            </span>
                          </div>
                          <span className="text-[11px] text-ink-600 mt-1">
                            {formatDate(opt.date)} · {opt.desc}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  <p className="mt-2.5 text-[11px] text-ink-600">
                    Saturday bookings lock the 2-day weekend package (Saturday + Sunday) at weekend rates.
                  </p>
                </div>
              )}

              <div>
                <div className="flex items-center justify-between">
                  <label className="label">Drop date (Return date) *</label>
                  {returnDayLabel && (
                    <span className="text-[11px] font-bold px-2 py-0.5 rounded bg-ink-100 text-ink-700">
                      {returnDayLabel}
                    </span>
                  )}
                </div>
                <input
                  className="input"
                  type="date"
                  min={minReturnDate}
                  value={returnDate}
                  onChange={(e) => handleReturnDateChange(e.target.value)}
                  aria-invalid={!!errors.returnDate}
                />
                {errors.returnDate && <p className="field-error">{errors.returnDate}</p>}
              </div>
              <div>
                <label className="label">
                  Drop time (Return time)
                  <span className="ml-2 text-[10px] font-bold text-ink-600 bg-ink-100 px-2 py-0.5 rounded">
                    Standard: 8:00 AM
                  </span>
                </label>
                <select className="input" value={returnTime} onChange={(e) => setReturnTime(e.target.value)}>
                  {Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, "0")}:00`)
                    .filter((t) => {
                      // Staff won't accept a vehicle return between midnight and 7 AM.
                      // On Sundays the counter opens later, so nothing before 9 AM.
                      if (t < (isSundayReturn ? "09:00" : "07:00")) {
                        return false;
                      }
                      const isSameDay = pickupDate && returnDate && pickupDate === returnDate;
                      if (isSameDay) {
                        return t > pickupTime;
                      }
                      return true;
                    })
                    .map((t) => {
                      const isSameDay = pickupDate && returnDate && pickupDate === returnDate;
                      const isStandard = t === "08:00";
                      const isLate = !isSameDay && t > "08:00";

                      return (
                        <option key={t} value={t}>
                          {isStandard
                            ? "8:00 AM (Standard Drop)"
                            : isLate
                            ? `${formatTimeLabel(t)} (+1 Day Extra Charge)`
                            : formatTimeLabel(t)}
                        </option>
                      );
                    })}
                </select>
                {!(pickupDate && returnDate && pickupDate === returnDate) && returnTime > "08:00" && (
                  <p className="mt-1 text-[11px] font-semibold text-amber-800">
                    ⚡ Drop after standard 8:00 AM: 1 day extra charge will be included.
                  </p>
                )}
              </div>

              <div>
                <label className="label">Passengers (optional)</label>
                <input className="input" type="number" min={1} value={passengers} onChange={(e) => setPassengers(e.target.value)} />
              </div>
            </div>
            <p className="text-xs text-ink-500 font-medium">
              Calculated Duration: {days} day{days > 1 ? "s" : ""} · Standard Daily Limit: 100 km/day (Bikes/Scooters) / 300 km/day (Cars &amp; Tempo) · Extra KM: ₹4/km (Bikes &amp; Scooters) / ₹8/km (Cars)
            </p>
            <p className="mt-2.5 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs font-semibold text-amber-900 shadow-xs">
              <strong>NOTE:</strong> Standard pickup is 8:00 AM and standard drop-off is 8:00 AM. Returning the vehicle after the standard 8:00 AM drop-off time will be billed as a full additional day charge.
            </p>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-4">
            <h2 className="font-display text-xl font-semibold text-ink-900">Choose your vehicle</h2>
            <p className="text-sm text-ink-500">{days} day{days > 1 ? "s" : ""}, from {formatDate(pickupAt)} to {formatDate(returnAt)}.</p>

            <div className="flex gap-2 border-b border-ink-100 pb-3 overflow-x-auto">
              <button
                type="button"
                onClick={() => setCategoryKind("")}
                className={`rounded-full px-3.5 py-1.5 text-xs font-semibold transition cursor-pointer ${!categoryKind ? "bg-ink-900 text-white" : "bg-ink-100 text-ink-700 hover:bg-ink-200"}`}
              >
                All Vehicles ({availableVehicles.length})
              </button>
              {categories.map((c) => {
                const count = availableVehicles.filter((v) => {
                  const vKind = (v.category_kind || "").toLowerCase().trim();
                  const vSlug = (v.category_slug || "").toLowerCase().trim();
                  const target = c.kind.toLowerCase().trim();
                  if (target === "scooter" || target === "scooters") return vKind === "scooter" || vSlug === "scooters";
                  if (target === "bike" || target === "bikes") return vKind === "bike" || vSlug === "bikes";
                  if (target === "car" || target === "cars") return vKind === "car" || vSlug === "cars";
                  if (target === "van" || target === "tempo-traveller") return vKind === "van" || vSlug === "tempo-traveller";
                  return vKind === target || vSlug === target;
                }).length;
                return (
                  <button
                    type="button"
                    key={c.id}
                    onClick={() => setCategoryKind(c.kind)}
                    className={`rounded-full px-3.5 py-1.5 text-xs font-semibold transition cursor-pointer ${categoryKind === c.kind ? "bg-ink-900 text-white" : "bg-ink-100 text-ink-700 hover:bg-ink-200"}`}
                  >
                    {c.name} ({count})
                  </button>
                );
              })}
            </div>

            {loadingVehicles && <p className="text-sm text-ink-400">Checking availability…</p>}
            {!loadingVehicles && availableVehicles.length === 0 && <p className="text-sm text-ink-400">No vehicles available for this period. Try different dates.</p>}
            {(() => {
              const vehiclesToDisplay = categoryKind
                ? availableVehicles.filter((v) => {
                    const vKind = (v.category_kind || "").toLowerCase().trim();
                    const vSlug = (v.category_slug || "").toLowerCase().trim();
                    const target = categoryKind.toLowerCase().trim();
                    if (target === "scooter" || target === "scooters") return vKind === "scooter" || vSlug === "scooters";
                    if (target === "bike" || target === "bikes") return vKind === "bike" || vSlug === "bikes";
                    if (target === "car" || target === "cars") return vKind === "car" || vSlug === "cars";
                    if (target === "van" || target === "tempo-traveller") return vKind === "van" || vSlug === "tempo-traveller";
                    return vKind === target || vSlug === target;
                  })
                : availableVehicles;

              return (
                <div className="grid gap-3 sm:grid-cols-2">
                  {vehiclesToDisplay.length === 0 ? (
                    <p className="sm:col-span-2 text-sm text-ink-400 py-6 text-center">
                      No vehicles found in this category for {location === "SAKLESHPURA" ? "Sakleshpura Branch" : "Hassan Branch"}.
                    </p>
                  ) : (
                    vehiclesToDisplay.map((v) => {
                    const isSelected = Number(vehicleId) === Number(v.id);
                    const vQuote = computeClientQuote(v, pickupDate, pickupTime, returnDate, returnTime);
                    const isVehicleUnavailable =
                      v.status === "unavailable" ||
                      v.status === "blocked" ||
                      v.status === "maintenance" ||
                      v.status === "inactive" ||
                      v.status === "archived" ||
                      Number(v.active) === 0;

                    const isOutOfStock =
                      isSelectedBranchBlocked ||
                      isVehicleUnavailable ||
                      (v.available_units !== undefined && v.available_units <= 0);

                    // The vehicle's own weekend rate — many vehicles genuinely charge the
                    // same on weekends, so this is often 0 and no badge is shown.
                    const weekendDiff = Number(v.weekend_rate_24h ?? v.rate_24h) - Number(v.rate_24h);

                    return (
                      <button
                        type="button"
                        key={v.id}
                        disabled={isOutOfStock}
                        onClick={() => {
                          if (!isOutOfStock) setVehicleId(v.id);
                        }}
                        className={`rounded-xl border p-4 text-left transition relative ${
                          isOutOfStock
                            ? "border-ink-100 bg-ink-50/70 opacity-60 cursor-not-allowed"
                            : isSelected
                            ? "border-brand-600 bg-brand-50/80 ring-2 ring-brand-500 shadow-sm cursor-pointer"
                            : "border-ink-100 bg-white hover:border-ink-300 cursor-pointer"
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <p className="font-semibold text-ink-900">{v.name}</p>
                            {isSelected && (
                              <span className="inline-flex items-center gap-1 rounded-full bg-brand-600 px-2 py-0.5 text-[10px] font-bold text-white shadow-xs">
                                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
                                Selected
                              </span>
                            )}
                          </div>
                          <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold shadow-xs ${
                            isOutOfStock
                              ? "bg-rose-100 text-rose-900 border border-rose-300"
                              : (v.available_units ?? v.total_units) <= 1
                              ? "bg-amber-100 text-amber-900 border border-amber-300"
                              : "bg-emerald-100 text-emerald-900 border border-emerald-300"
                          }`}>
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" className="shrink-0" aria-hidden><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" /></svg>
                            {isOutOfStock ? (isSelectedBranchBlocked ? "Branch Blocked" : "Unavailable") : `${v.available_units ?? v.total_units} Left`}
                          </span>
                        </div>
                        <div className="mt-1 flex items-center gap-1.5 flex-wrap">
                          <span className="inline-flex items-center gap-1 font-semibold text-brand-800 bg-brand-50 border border-brand-200/80 rounded px-1.5 py-0.2 text-[10px]">
                            🏢 {v.branch_name || (location === "SAKLESHPURA" ? "Sakleshpura Branch" : "Hassan Branch")}
                          </span>
                        </div>
                        <p className="mt-1.5 text-xs text-ink-500">{v.transmission} · {v.fuel_type} · {v.included_km >= 999 ? "Unlimited KM" : `${v.included_km} km/day (Extra KM: ₹${(v.category_kind === "bike" || v.category_kind === "scooter") ? 4 : v.extra_km_rate ?? 8}/km)`}</p>

                        <div className="mt-3 flex items-end justify-between border-t border-ink-100/80 pt-2.5">
                          <div>
                            {vQuote ? (
                              <div>
                                <p className="font-display text-lg font-bold text-ink-900">
                                  {formatINR(vQuote.baseAmount)}
                                  <span className="text-xs font-normal text-ink-500"> for {vQuote.days} day{vQuote.days > 1 ? "s" : ""}</span>
                                </p>
                                <p className="text-[11px] text-ink-500 font-medium">
                                  Pay now online: {formatINR(vQuote.payableNow)} (incl. GST)
                                </p>
                                <p className="text-[11px] text-ink-500 font-medium">
                                  Security deposit (cash at pickup, refundable): {formatINR(vQuote.depositPayableAtPickup)}
                                </p>
                              </div>
                            ) : (
                              <div className="flex items-baseline gap-2 flex-wrap">
                                <p className="font-display text-lg font-bold text-ink-900">
                                  {formatINR(v.rate_24h)}<span className="text-xs font-normal text-ink-500">/day</span>
                                </p>
                              </div>
                            )}
                          </div>

                          {vQuote && vQuote.weekendDaysCount > 0 ? (
                            <span className="text-[10px] font-bold text-amber-800 bg-amber-100 px-2 py-0.5 rounded">
                              +₹{weekendDiff} Weekend Rate
                            </span>
                          ) : (
                            <span className="text-[10px] font-medium text-ink-500 bg-ink-100 px-2 py-0.5 rounded">
                              Standard Rate
                            </span>
                          )}
                        </div>
                      </button>
                    );
                  }))}
                </div>
              );
            })()}
            {errors.vehicle && <p className="field-error">{errors.vehicle}</p>}
            {activeQuote && selectedVehicle && (
              <div className="rounded-xl border border-brand-200 bg-brand-50 p-4 text-sm">
                <div className="flex items-center justify-between">
                  <p className="font-semibold text-ink-900">
                    {selectedVehicle.name} — pay now online: {formatINR(activeQuote.payableNow)}
                  </p>
                  {activeQuote.weekendDaysCount && activeQuote.weekendDaysCount > 0 ? (
                    <span className="text-[10px] font-bold text-amber-800 bg-amber-100 px-2 py-0.5 rounded">
                      Weekend Rate Applied ({activeQuote.weekendDaysCount} day{activeQuote.weekendDaysCount > 1 ? "s" : ""})
                    </span>
                  ) : null}
                </div>
                <p className="mt-1 text-ink-600">
                  {activeQuote.days} day{activeQuote.days > 1 ? "s" : ""} ({formatINR(activeQuote.baseAmount)})
                  {activeQuote.offSchedulePickupFee > 0 && <> + early pickup surcharge {formatINR(activeQuote.offSchedulePickupFee)}</>}
                  {" "}+ GST {formatINR(activeQuote.gstAmount)}
                  {activeQuote.gatewayFeeAmount > 0 && <> + gateway fee {formatINR(activeQuote.gatewayFeeAmount)}</>}.
                </p>
                <p className="mt-1 font-medium text-emerald-800">
                  Security deposit (cash at pickup, refundable): {formatINR(depositAtPickup)} — not charged online.
                </p>
                {activeQuote.lateDrop && (
                  <p className="mt-1 text-amber-800">
                    Drop is after 8:00 AM, so one extra full rental day is included above.
                  </p>
                )}
                {activeQuote.belowWeekendMinimum && (
                  <p className="mt-2 font-medium text-red-700">Weekend bookings need a minimum of {activeQuote.weekendMinDays} days for this vehicle — please add more days on the previous step.</p>
                )}
              </div>
            )}
          </div>
        )}

        {step === 3 && (
          <div className="space-y-4">
            <h2 className="font-display text-xl font-semibold text-ink-900">Your details</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="label">Full name *</label>
                <input className="input" placeholder="As on your driving licence" value={contact.name} onChange={(e) => setContact({ ...contact, name: e.target.value })} aria-invalid={!!errors.name} />
                {errors.name && <p className="field-error">{errors.name}</p>}
              </div>
              <div>
                <label className="label">Mobile number *</label>
                <input className="input" type="tel" placeholder="10-digit mobile number" value={contact.phone} onChange={(e) => setContact({ ...contact, phone: e.target.value })} aria-invalid={!!errors.phone} />
                <p className="mt-1 text-xs text-ink-400">We'll send your booking confirmation here on WhatsApp.</p>
                {errors.phone && <p className="field-error">{errors.phone}</p>}
              </div>
              <div>
                <label className="label">Email</label>
                <input className="input" type="email" placeholder="you@example.com" value={contact.email} onChange={(e) => setContact({ ...contact, email: e.target.value })} />
              </div>
              <div>
                <label className="label">Date of birth</label>
                <input className="input" type="date" max={maxDobISO()} value={contact.dob} onChange={(e) => setContact({ ...contact, dob: e.target.value })} />
              </div>
              <div className="sm:col-span-2">
                <label className="label">Address</label>
                <input className="input" placeholder="Where you're staying or your home address" value={contact.address} onChange={(e) => setContact({ ...contact, address: e.target.value })} />
              </div>
              <div>
                <label className="label">Emergency contact</label>
                <input className="input" type="tel" placeholder="A number we can call if needed" value={contact.emergencyContact} onChange={(e) => setContact({ ...contact, emergencyContact: e.target.value })} />
              </div>
            </div>
          </div>
        )}

        {step === 4 && (
          <div className="space-y-4">
            <h2 className="font-display text-xl font-semibold text-ink-900">Driving licence &amp; documents</h2>
            <p className="text-sm text-ink-500">
              The driver&rsquo;s three documents are required for handover verification. Pillion
              documents are optional — add them only if someone is riding with you.
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              {[
                ["licence", "Driver Driving licence photo *"],
                ["driver_govt_id", "Driver Government ID (Aadhaar/Passport) *"],
                ["driver_photo", "Driver Passport Size Photo *"],
                ["pillion_id", "Pillion ID Proof (Aadhaar/Passport) — optional"],
                ["pillion_photo", "Pillion Passport Size Photo — optional"],
              ].map(([kind, label]) => (
                <label key={kind} className="flex cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-ink-200 bg-ink-50 p-5 text-center text-sm text-ink-500 hover:border-brand-500">
                  {documents[kind]?.url ? <span className="font-semibold text-emerald-700">✓ {label.replace(" *", "")} uploaded</span> : <span>{uploading === kind ? "Uploading…" : `Upload ${label}`}</span>}
                  {uploadErrors[kind] && (
                    <span className="text-xs font-medium text-red-600">{uploadErrors[kind]} Tap to retry.</span>
                  )}
                  <input
                    type="file"
                    accept="image/*,application/pdf"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) {
                        upload(kind, file).catch(console.error);
                        e.target.value = "";
                      }
                    }}
                  />
                </label>
              ))}
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="label">Driver Licence number *</label>
                <input
                  className="input font-mono uppercase"
                  placeholder="e.g. KA04 12345678901"
                  maxLength={16}
                  value={documents.licence?.number ?? ""}
                  onChange={(e) => {
                    const val = formatDlNumber(e.target.value);
                    setDocuments((d) => ({ ...d, licence: { ...d.licence, url: d.licence?.url ?? "", number: val } }));
                  }}
                  aria-invalid={!!errors.licenceNumber}
                />
                <p className="mt-1 text-xs text-ink-400">Format: 2 letters, 2 digits, space, 11 digits (e.g. KA04 12345678901)</p>
                {errors.licenceNumber && <p className="field-error">{errors.licenceNumber}</p>}
              </div>
              <div>
                <label className="label">Driver Licence expiry date *</label>
                <input
                  className="input"
                  type="date"
                  min={todayISO()}
                  value={documents.licence?.expiry ?? ""}
                  onChange={(e) => setDocuments((d) => ({ ...d, licence: { ...d.licence, url: d.licence?.url ?? "", expiry: e.target.value } }))}
                  aria-invalid={!!errors.licenceExpiry}
                />
                {errors.licenceExpiry && <p className="field-error">{errors.licenceExpiry}</p>}
              </div>
            </div>
            {errors.documents && <p className="field-error">{errors.documents}</p>}
          </div>
        )}

        {step === 5 && (
          <div className="space-y-5">
            <h2 className="font-display text-xl font-semibold text-ink-900">Review & confirm</h2>
            
            {/* Booking Summary */}
            <div className="space-y-2.5 text-sm">
              <div className="flex justify-between border-b border-ink-100 pb-2">
                <span className="text-ink-500">Vehicle</span>
                <span className="font-medium text-ink-900">
                  {selectedVehicle ? `${selectedVehicle.name} (${selectedVehicle.category_name ?? selectedVehicle.category_kind})` : "—"}
                  <button type="button" onClick={() => setStep(2)} className="ml-2 text-xs text-brand-700 hover:underline">Edit</button>
                </span>
              </div>
              <div className="flex justify-between border-b border-ink-100 pb-2">
                <span className="text-ink-500">Pickup</span>
                <span className="font-medium text-ink-900">
                  {formatDisplayDate(pickupDate)}, {formatTimeLabel(pickupTime)}
                  <button type="button" onClick={() => setStep(1)} className="ml-2 text-xs text-brand-700 hover:underline">Edit</button>
                </span>
              </div>
              <div className="flex justify-between border-b border-ink-100 pb-2">
                <span className="text-ink-500">Return (Drop)</span>
                <span className="font-medium text-ink-900">
                  {formatDisplayDate(returnDate)}, {formatTimeLabel(returnTime)}
                  <button type="button" onClick={() => setStep(1)} className="ml-2 text-xs text-brand-700 hover:underline">Edit</button>
                </span>
              </div>
              <div className="flex justify-between border-b border-ink-100 pb-2">
                <span className="text-ink-500">Location</span>
                <span className="font-medium text-ink-900">
                  {location === "SAKLESHPURA" ? "Sakleshpura" : "Hassan (Main Branch)"}
                  <button type="button" onClick={() => setStep(1)} className="ml-2 text-xs text-brand-700 hover:underline">Edit</button>
                </span>
              </div>
              <div className="flex justify-between border-b border-ink-100 pb-2">
                <span className="text-ink-500">Customer</span>
                <span className="font-medium text-ink-900">
                  {contact.name || "—"} · {contact.phone || "—"}
                  <button type="button" onClick={() => setStep(3)} className="ml-2 text-xs text-brand-700 hover:underline">Edit</button>
                </span>
              </div>
              {contact.email && (
                <div className="flex justify-between border-b border-ink-100 pb-2">
                  <span className="text-ink-500">Email</span>
                  <span className="font-medium text-ink-900">{contact.email}</span>
                </div>
              )}
              {documents.licence?.number && (
                <div className="flex justify-between border-b border-ink-100 pb-2">
                  <span className="text-ink-500">Driving Licence</span>
                  <span className="font-mono font-medium text-ink-900">{documents.licence.number}</span>
                </div>
              )}
            </div>

            {/* Dedicated Price Breakup Box */}
            <div className="rounded-xl border border-brand-200 bg-brand-50/40 p-4 space-y-2.5 text-sm shadow-xs">
              <div className="flex items-center justify-between border-b border-brand-200/80 pb-2">
                <span className="font-semibold text-ink-900">Price breakup</span>
                <div className="flex items-center gap-2">
                  {activeQuote && activeQuote.weekendDaysCount && activeQuote.weekendDaysCount > 0 ? (
                    <span className="text-[11px] font-bold text-amber-800 bg-amber-100 px-2 py-0.5 rounded">
                      Weekend Rate Applied ({activeQuote.weekendDaysCount} day{activeQuote.weekendDaysCount > 1 ? "s" : ""})
                    </span>
                  ) : null}
                  <span className="text-xs font-semibold text-brand-800 bg-brand-100 px-2.5 py-0.5 rounded-full">
                    {activeQuote?.days || days} Day{((activeQuote?.days || days) > 1) ? "s" : ""} Duration
                  </span>
                </div>
              </div>
              <div className="flex justify-between text-ink-700">
                <span>Base rental rate ({activeQuote?.days || days} day{((activeQuote?.days || days) > 1) ? "s" : ""})</span>
                <span className="font-semibold text-ink-900">{formatINR(activeQuote?.baseAmount ?? 0)}</span>
              </div>
              {activeQuote && activeQuote.offSchedulePickupFee > 0 && (
                <div className="flex justify-between text-amber-800">
                  <span>Early pickup surcharge (before 8:00 AM, one-off)</span>
                  <span className="font-semibold">{formatINR(activeQuote.offSchedulePickupFee)}</span>
                </div>
              )}
              {activeQuote?.lateDrop && (
                <p className="text-[11px] font-medium text-amber-800">
                  Drop after 8:00 AM — one extra full rental day is included in the {activeQuote.days} days above.
                </p>
              )}
              {activeQuote && activeQuote.gstAmount > 0 && (
                <div className="flex justify-between text-ink-700">
                  <span>GST ({activeQuote.gstPct}%)</span>
                  <span className="font-medium text-ink-900">{formatINR(activeQuote.gstAmount)}</span>
                </div>
              )}
              {activeQuote && activeQuote.gatewayFeeAmount > 0 && (
                <div className="flex justify-between text-ink-700">
                  <span>Payment gateway fee</span>
                  <span className="font-medium text-ink-900">{formatINR(activeQuote.gatewayFeeAmount)}</span>
                </div>
              )}
              <div className="flex justify-between border-t border-brand-200 pt-2.5 text-base font-bold text-ink-900">
                <span>Pay now online</span>
                <span className="text-lg text-brand-700">{formatINR(payNowAmount)}</span>
              </div>
              <div className="flex justify-between text-sm font-semibold text-emerald-800">
                <span>Security deposit (cash at pickup, refundable)</span>
                <span>{formatINR(depositAtPickup)}</span>
              </div>
              <p className="text-[11px] text-ink-500">
                The security deposit is <strong>not</strong> collected online. You pay it in cash when you collect the
                vehicle, and it is returned in full after the return inspection.
              </p>
            </div>

            {/* Terms & Conditions */}
            <div className="rounded-xl border border-ink-100 bg-ink-50 p-4 text-sm text-ink-600">
              <p className="font-semibold text-ink-900">Terms & conditions</p>
              <ul className="mt-2 max-h-44 space-y-1.5 overflow-y-auto pr-2">
                {(() => {
                  const baseTerms = (terms && terms.length > 0) ? [...terms] : [...DEFAULT_TERMS];
                  if (!baseTerms.some((t) => t.toLowerCase().includes("accident") || t.toLowerCase().includes("damages"))) {
                    baseTerms.push("In case of any accident or damages, notify the owner immediately and do not do anything on your own.");
                  }
                  return baseTerms
                    .filter((t) => !t.toLowerCase().includes("cancellation"))
                    .map((t) => {
                      let text = t;
                      if (t.toLowerCase().includes("driving beyond this limit") || t.toLowerCase().includes("drive limit")) {
                        const extraKmRate = (selectedVehicle?.category_kind === "bike" || selectedVehicle?.category_kind === "scooter") ? 4 : (selectedVehicle?.extra_km_rate ?? 8);
                        const kmLimit = selectedVehicle?.included_km ?? (selectedVehicle?.category_kind === "car" ? 300 : 100);
                        text = `Included drive limit is ${kmLimit >= 999 ? "Unlimited" : `${kmLimit} km`} per day. Driving beyond this limit is charged at ₹${extraKmRate}/KM.`;
                      }
                      return (
                        <li key={t} className="flex gap-2"><span aria-hidden className="text-brand-600 font-bold">•</span><span>{text}</span></li>
                      );
                    });
                })()}
              </ul>
            </div>

            <label className="flex items-start gap-2 text-sm text-ink-700 cursor-pointer">
              <input type="checkbox" checked={termsAccepted} onChange={(e) => setTermsAccepted(e.target.checked)} className="mt-0.5 h-4 w-4 accent-brand-600" />
              <span>I have read and accept the terms and conditions and fuel policy.</span>
            </label>
            {errors.terms && <p className="field-error">{errors.terms}</p>}

            {submitError && <p className="field-error" role="alert">{submitError}</p>}
          </div>
        )}

        <div className="mt-8 flex justify-between">
          {step > 1 ? <button type="button" onClick={back} className="btn-secondary">Back</button> : <span />}
          {step < 5 && <button type="button" onClick={next} className="btn-primary">Continue</button>}
          {step === 5 && <button type="button" onClick={submit} disabled={submitting} className="btn-primary">{submitting ? "Submitting…" : "Confirm booking"}</button>}
        </div>
      </div>
    </div>
  );
}
