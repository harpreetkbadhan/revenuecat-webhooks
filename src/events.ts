import type { RevenueCatEvent, RevenueCatWebhookBody } from './types.js';

/** Thrown by {@link parseWebhook} when a body is not a RevenueCat webhook. */
export class RevenueCatWebhookError extends Error {
  override name = 'RevenueCatWebhookError';
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Checks the fields every event has (`id`, `type`, `event_timestamp_ms`) and returns
 * the body typed. Everything else passes through untouched, including fields and
 * event types RevenueCat adds later, so a new field never breaks your webhook.
 */
export function parseWebhook(body: unknown): RevenueCatWebhookBody {
  if (!isRecord(body) || !isRecord(body.event)) {
    throw new RevenueCatWebhookError('Expected a JSON object with an `event` object');
  }
  const { id, type, event_timestamp_ms } = body.event;
  if (typeof id !== 'string' || id === '') {
    throw new RevenueCatWebhookError('`event.id` must be a non-empty string');
  }
  if (typeof type !== 'string' || type === '') {
    throw new RevenueCatWebhookError('`event.type` must be a non-empty string');
  }
  if (typeof event_timestamp_ms !== 'number' || !Number.isFinite(event_timestamp_ms)) {
    throw new RevenueCatWebhookError('`event.event_timestamp_ms` must be a number');
  }
  return body as unknown as RevenueCatWebhookBody;
}

/** The last event you applied for a subscriber. */
export interface AppliedEvent {
  id: string;
  timestampMs: number;
}

/**
 * Whether to apply `event` after `last`. RevenueCat delivers at least once and does
 * not promise order, so a retry or a late event must not overwrite newer state.
 * An event applies when it is newer, or has the same timestamp but another id.
 * Two different events in the same millisecond both apply, in arrival order.
 */
export function isNewerEvent(event: RevenueCatEvent, last: AppliedEvent | null | undefined): boolean {
  if (!last) {
    return true;
  }
  if (event.event_timestamp_ms !== last.timestampMs) {
    return event.event_timestamp_ms > last.timestampMs;
  }
  return event.id !== last.id;
}

/**
 * Every App User ID the event names, current one first, without duplicates.
 * RevenueCat recommends matching your users against all of them, since a
 * subscriber may have logged in under several ids.
 */
export function appUserIds(event: RevenueCatEvent): string[] {
  const ids = [event.app_user_id, event.original_app_user_id, ...(event.aliases ?? [])];
  return [...new Set(ids.filter((id): id is string => !!id))];
}

export type SubscriptionStatus = 'active' | 'cancelled' | 'billing_issue' | 'expired';

// Event types that change a subscription's status. Others (SUBSCRIPTION_PAUSED, which
// only revokes access with the EXPIRATION that follows; PRODUCT_CHANGE, which takes
// effect with a later RENEWAL; TRANSFER, which moves ownership; TEST; ...) change nothing.
const STATUS_BY_TYPE: Readonly<Record<string, SubscriptionStatus>> = {
  INITIAL_PURCHASE: 'active',
  RENEWAL: 'active',
  UNCANCELLATION: 'active',
  NON_RENEWING_PURCHASE: 'active',
  SUBSCRIPTION_EXTENDED: 'active',
  REFUND_REVERSED: 'active',
  TEMPORARY_ENTITLEMENT_GRANT: 'active',
  CANCELLATION: 'cancelled',
  BILLING_ISSUE: 'billing_issue',
  EXPIRATION: 'expired',
};

export interface SubscriptionStatusOptions {
  /** Only report events that grant this entitlement. */
  entitlementId?: string;
}

/**
 * The subscription status after `event`, or null when the event does not change it.
 * A cancelled subscription or one with a billing issue keeps access until it expires;
 * use {@link hasAccess} with the event's `expiration_at_ms` to decide.
 */
export function subscriptionStatusFor(
  event: RevenueCatEvent,
  { entitlementId }: SubscriptionStatusOptions = {},
): SubscriptionStatus | null {
  // `entitlement_id` is deprecated but may still be the only one set.
  const granted = [...(event.entitlement_ids ?? []), event.entitlement_id];
  if (entitlementId && !granted.includes(entitlementId)) {
    return null;
  }
  return Object.hasOwn(STATUS_BY_TYPE, event.type) ? (STATUS_BY_TYPE[event.type] ?? null) : null;
}

// RevenueCat grants a temporary entitlement for at most 24 hours.
const TEMPORARY_GRANT_MAX_MS = 24 * 60 * 60 * 1000;

/**
 * When the access this event describes ends, in ms since epoch:
 * - `null` when RevenueCat sends an explicit null (lifetime, non-expiring purchases);
 * - `undefined` when the payload has no expiration at all, so {@link hasAccess} fails
 *   closed instead of treating a missing field as lifetime access.
 * After a BILLING_ISSUE the store may keep access during a grace period that runs past
 * `expiration_at_ms`; that later end is used when present. A TEMPORARY_ENTITLEMENT_GRANT
 * without an expiration lasts the documented maximum of 24 hours.
 */
export function accessEndsAtMs(event: RevenueCatEvent): number | null | undefined {
  const expiration = event.expiration_at_ms;
  if (event.type === 'TEMPORARY_ENTITLEMENT_GRANT' && expiration == null) {
    return event.event_timestamp_ms + TEMPORARY_GRANT_MAX_MS;
  }
  const grace = event.type === 'BILLING_ISSUE' ? (event.grace_period_expiration_at_ms ?? null) : null;
  if (grace === null || expiration == null) {
    return expiration;
  }
  return Math.max(expiration, grace);
}

export interface StoredSubscription {
  status: SubscriptionStatus;
  /** From {@link accessEndsAtMs}: null for lifetime, undefined when unknown (no access). */
  expiresAtMs: number | null | undefined;
}

/**
 * Whether a subscriber has access now. Access lasts until the period ends, also after
 * a cancellation or a failed charge; it ends with an EXPIRATION or the end date.
 * Check this at read time (or in a periodic sweep), so a lost EXPIRATION webhook
 * cannot keep access on forever.
 */
export function hasAccess(subscription: StoredSubscription | null | undefined, now: Date = new Date()): boolean {
  if (!subscription || subscription.status === 'expired') {
    return false;
  }
  if (subscription.expiresAtMs === null) {
    return true; // lifetime
  }
  if (subscription.expiresAtMs === undefined) {
    return false; // end unknown: fail closed
  }
  return subscription.expiresAtMs > now.getTime();
}
