/**
 * Surfaces a stuck Razorpay webhook where every staff member actually looks — the top
 * of the dashboard on every page load — instead of a log line in Vercel that nobody
 * checks. The health value is written by the hourly /api/sync sweep (see
 * webhookHealth() there); this component only renders what it finds.
 *
 * Deliberately not a dismissible toast: an admin dismissing it for themselves must not
 * hide it from the next person who logs in, and the banner already clears itself the
 * next time /api/sync finds the webhook healthy again — nothing to dismiss.
 */
type WebhookHealth = {
  healthy: boolean;
  inactive: string[];
  lastEventAt: string | null;
  lastCapturedAt: string | null;
  deliveriesStalled: boolean;
  checkedAt: string;
};

export function SystemHealthBanner({ webhookHealth }: { webhookHealth: WebhookHealth | null }) {
  if (!webhookHealth || webhookHealth.healthy) return null;

  const disabled = webhookHealth.inactive.length > 0;
  const message = disabled
    ? "Razorpay's webhook is disabled — payments may stop recording automatically."
    : "Razorpay's webhook is active but nothing has arrived since a payment was captured — check the webhook secret.";

  return (
    <div className="shrink-0 border-b border-red-900/10 bg-red-50 px-4 py-2 text-xs font-semibold text-red-800 sm:px-6">
      ⚠️ {message}
      {" "}
      <span className="font-normal text-red-700">
        {disabled ? "Re-enable it in the Razorpay dashboard." : "Confirm RAZORPAY_WEBHOOK_SECRET in Vercel matches Razorpay's."}
        {" "}Last checked {new Date(webhookHealth.checkedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST.
      </span>
    </div>
  );
}
