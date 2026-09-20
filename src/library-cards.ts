import type { Shelf } from "./library-identity.js";
/** Plain-text Telegram cards and replies. Deadlines come from the row, never a literal. */
const sg = (iso: string | Date, withDate = false) =>
  new Date(iso).toLocaleString("en-SG", {
    timeZone: "Asia/Singapore",
    ...(withDate ? { weekday: "short", day: "numeric", month: "short" } : {}),
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
export const sgDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-SG", {
    timeZone: "Asia/Singapore",
    weekday: "short",
    day: "numeric",
    month: "short",
  });
export function linkCard(expiresAt: string) {
  return `Link your NLB Libby card to this assistant?\n\nApprove to get a one-time 8-digit setup code, shown here for up to 5 minutes. You enter it in Libby on this phone: Menu → Copy To Another Device. After that I can see your loans and holds and, only when you tap a card here, borrow or place holds. I never download books, never see your card PIN, and you can disconnect at any time with /library revoke.\n\nThe code changes about every minute; this message updates. Nothing happens until you tap Start.\nApprove by ${sg(expiresAt)} SGT.`;
}
export function linkProgress(code: string, endsAt: string) {
  const spaced = code.replace(/^(\d{4})(\d{4})$/, "$1 $2");
  return `Linking — step 1 of 2\n\nSetup code: ${spaced}\nIn Libby: Menu → Copy To Another Device → enter this code.\n\nThe code renews about every minute; I update it here. Attempt ends ${sg(endsAt)} SGT.`;
}
export const linkConfirming =
  "Linking — step 2 of 2\n\nLibby accepted the code. Confirming your card…";
export function linkDone(shelf: Shelf) {
  return `Linked to NLB. Shelf now: ${shelf.loans.length} loan${shelf.loans.length === 1 ? "" : "s"}, ${shelf.holds.length} hold${shelf.holds.length === 1 ? "" : "s"}. Send /library any time.`;
}
export function linkFailed(
  reason: "expired" | "aborted" | "failed",
  rotations: number,
) {
  const observed = `The code rotated ${rotations} time${rotations === 1 ? "" : "s"} and Libby never confirmed it; nothing was linked.`;
  if (reason === "aborted") return "Stopped. Nothing was changed.";
  if (reason === "expired")
    return `Linking did not complete in 5 minutes. ${observed}\n\nAlternative: in Libby open Menu → Settings → Copy To Another Device. If Libby shows an 8-digit code there, send me /library code 12345678 within a minute. If it asks you to enter a code instead, tell me. Do not use Recover Your Data on this phone: that path replaces the phone's own Libby data.`;
  return `Linking failed before completion. ${observed} Send /library link to try again.`;
}
export function revokeCard(expiresAt: string) {
  return `Disconnect Libby from this assistant?\n\nI forget my access right away and ask Libby to invalidate my copy. Your loans and holds are not affected. Pending borrow and hold cards will be cancelled. Re-linking later needs a new setup code.\nApprove by ${sg(expiresAt)} SGT.`;
}
export function revokeDone(remote: boolean, expiresAt: string | null) {
  return remote
    ? "Disconnected. Libby invalidated my copy; your loans and holds are unchanged."
    : `Local access removed. Libby's copy could not be confirmed invalidated; it expires by itself${expiresAt ? " by " + sgDate(expiresAt) : " within a week"}.`;
}
export function shelfText(
  shelf: Shelf | null,
  linked: boolean,
  usage: { callsToday: number; dailyCeiling: number },
) {
  if (!linked)
    return "No library card is linked. Send /library link to connect your NLB card from this phone (about a minute).";
  if (!shelf)
    return "Linked, but no shelf snapshot yet. Ask me to check your shelf.";
  const age = Date.now() - new Date(shelf.syncedAt).getTime();
  const lines = [
    `Library — NLB`,
    `Card: linked · shelf checked ${sg(shelf.syncedAt, true)}${age > 6 * 3600000 ? " (older than 6 h)" : ""}`,
    `Loans: ${shelf.capacity.loans.used}${shelf.capacity.loans.limit ? " of " + shelf.capacity.loans.limit : ""} · Holds: ${shelf.capacity.holds.used}${shelf.capacity.holds.limit ? " of " + shelf.capacity.holds.limit : ""} · Library calls today: ${usage.callsToday} of ${usage.dailyCeiling}`,
    "",
    "Loans",
    ...(shelf.loans.length
      ? shelf.loans
          .slice(0, 12)
          .map(
            (l) =>
              `• ${l.title}${l.luckyDay ? " (Lucky Day)" : ""} — ${l.daysLeft === null ? "expiry unknown" : l.daysLeft === 0 ? "expires today" : `${l.daysLeft} day${l.daysLeft === 1 ? "" : "s"} left`}${l.expiresAt ? ` (due ${sgDate(l.expiresAt)})` : ""}`,
          )
      : ["• none"]),
    "",
    "Holds",
    ...(shelf.holds.length
      ? shelf.holds
          .slice(0, 12)
          .map(
            (h) =>
              `• ${h.title} — ${h.ready ? "ready to borrow" : h.estimatedWaitDays === null ? "waiting" : `waiting, about ${h.estimatedWaitDays} days`}${h.suspended ? " (suspended)" : ""}`,
          )
      : ["• none"]),
    "",
    "Numbers are from the last shelf check. Ask me to check your shelf for fresh ones. Loans cannot be returned or renewed here; they expire on their own.",
  ];
  return lines.join("\n");
}
