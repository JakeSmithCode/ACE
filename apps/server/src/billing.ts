// Stripe VIP billing seam (docs/PHASE2.md §12, DESIGN §8.4) — zero-dep, but the
// WIRE SHAPES are real Stripe: the webhook signature check implements Stripe's
// exact `stripe-signature` scheme (`t=<unix>,v1=HMAC_SHA256(secret, "<t>.<rawBody>")`,
// timestamp-tolerance window, constant-time compare), so pointing a real Stripe
// endpoint at POST /billing/webhook with the real signing secret needs no code
// change — only the checkout-session creation (a Stripe SDK call) is stubbed.
//
// The webhook is the SOURCE OF TRUTH for `account.vipUntil`. VIP gates
// convenience/depth — a scout-report discount, deeper analytics, badges —
// NEVER the sim: the tick resolves identically for everyone (§18 fairness).
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Dev-checkout subscription length (the real horizon comes from Stripe's
 *  `current_period_end` on each webhook). */
export const VIP_DAYS = 30;

/** Build a `stripe-signature` header for a payload — used by tests/demos to act
 *  as Stripe (the real sender signs with the same scheme). */
export function stripeSign(secret: string, payload: string, t: number): string {
  const v1 = createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

/** Verify a `stripe-signature` header against the RAW request body. Tolerance
 *  mirrors Stripe's default 5-minute replay window. */
export function verifyStripeSig(header: string | undefined, payload: string, secret: string, now: number, tolerance = 300): boolean {
  if (!header) return false;
  const parts: Record<string, string> = {};
  for (const kv of header.split(',')) { const i = kv.indexOf('='); if (i > 0) parts[kv.slice(0, i).trim()] = kv.slice(i + 1).trim(); }
  const t = Number(parts.t);
  if (!t || Math.abs(now - t) > tolerance || !parts.v1) return false;
  const want = createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
  const a = Buffer.from(want), b = Buffer.from(parts.v1);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Reduce a Stripe event to the account's new VIP horizon (epoch seconds).
 *  Returns null for events that don't change VIP (ignored, 200 to Stripe).
 *  The account rides `metadata.accountId` (set when the checkout session is
 *  created) with `client_reference_id` as the fallback — both standard Stripe. */
export function vipFromEvent(evt: { type?: string; data?: { object?: Record<string, unknown> } }, now: number): { accountId: string; vipUntil: number } | null {
  const obj = evt?.data?.object;
  if (!obj) return null;
  const meta = obj.metadata as Record<string, unknown> | undefined;
  const accountId = (meta?.accountId ?? obj.client_reference_id) as string | undefined;
  if (!accountId) return null;
  switch (evt.type) {
    case 'checkout.session.completed':
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'invoice.paid':
      return { accountId, vipUntil: Number(obj.current_period_end) || now + VIP_DAYS * 86400 };
    case 'customer.subscription.deleted':
      return { accountId, vipUntil: now };   // Stripe fires this at period end — VIP lapses now
    default:
      return null;
  }
}

/** Is a VIP horizon live at `now`? (Feature checks read this — nothing else.) */
export const vipActive = (vipUntil: number | null | undefined, now: number): boolean => !!vipUntil && vipUntil > now;
