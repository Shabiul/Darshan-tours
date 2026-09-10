import { test } from "node:test";
import assert from "node:assert/strict";
import { pickupWindow } from "../src/components/dashboard/BookingsTableWithTabs";

const TODAY = "2026-09-10";

test("no filters selected leaves the window fully open", () => {
  assert.deepEqual(pickupWindow(false, "", "", TODAY), { floor: "", ceil: "" });
});

test("Upcoming alone floors the window at today", () => {
  assert.deepEqual(pickupWindow(true, "", "", TODAY), { floor: TODAY, ceil: "" });
});

test("an explicit range without Upcoming is used verbatim, past dates included", () => {
  assert.deepEqual(pickupWindow(false, "2026-08-01", "2026-08-31", TODAY), {
    floor: "2026-08-01",
    ceil: "2026-08-31",
  });
});

test("Upcoming wins over a From date that has already passed", () => {
  // The whole point of the toggle is "no earlier pickups" — a stale From must not
  // silently reopen the past.
  assert.deepEqual(pickupWindow(true, "2026-08-01", "2026-09-30", TODAY), {
    floor: TODAY,
    ceil: "2026-09-30",
  });
});

test("a future From date narrows further than Upcoming does", () => {
  assert.deepEqual(pickupWindow(true, "2026-09-20", "", TODAY), {
    floor: "2026-09-20",
    ceil: "",
  });
});

test("From equal to today is a no-op against Upcoming", () => {
  assert.deepEqual(pickupWindow(true, TODAY, "", TODAY), { floor: TODAY, ceil: "" });
});

test("a To date alone caps the window without flooring it", () => {
  assert.deepEqual(pickupWindow(false, "", "2026-09-15", TODAY), {
    floor: "",
    ceil: "2026-09-15",
  });
});
