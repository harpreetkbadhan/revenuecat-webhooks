import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  accessEndsAtMs,
  appUserIds,
  hasAccess,
  isNewerEvent,
  parseWebhook,
  RevenueCatWebhookError,
  type RevenueCatEvent,
  subscriptionStatusFor,
  verifyAuthorization,
  verifySignature,
} from '../src/index.js';

const event = (fields: Partial<RevenueCatEvent> = {}): RevenueCatEvent => ({
  id: 'evt_1',
  type: 'INITIAL_PURCHASE',
  event_timestamp_ms: 1_700_000_000_000,
  app_user_id: 'user_1',
  original_app_user_id: 'user_1',
  aliases: ['user_1'],
  entitlement_ids: ['premium'],
  expiration_at_ms: 1_800_000_000_000,
  ...fields,
});

describe('verifyAuthorization', () => {
  it('accepts the configured header value', () => {
    expect(verifyAuthorization('Bearer s3cret', 'Bearer s3cret')).toBe(true);
  });

  it('rejects a different, missing or empty value', () => {
    expect(verifyAuthorization('Bearer wrong', 'Bearer s3cret')).toBe(false);
    expect(verifyAuthorization(undefined, 'Bearer s3cret')).toBe(false);
    expect(verifyAuthorization('', 'Bearer s3cret')).toBe(false);
  });

  it('never accepts anything when no secret is configured', () => {
    expect(verifyAuthorization('', '')).toBe(false);
  });
});

describe('verifySignature', () => {
  const secret = 'whsec_test';
  const rawBody = JSON.stringify({ api_version: '1.0', event: event() });
  const now = new Date('2026-01-01T00:00:00Z');
  const t = Math.floor(now.getTime() / 1000);
  const sign = (body: string, timestamp: number) =>
    `t=${timestamp},v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;

  it('accepts a valid signature within the tolerance', () => {
    expect(verifySignature({ rawBody, header: sign(rawBody, t), secret, now })).toBe(true);
    expect(verifySignature({ rawBody, header: sign(rawBody, t).toUpperCase().replace('T=', 't=').replace('V1=', 'v1='), secret, now })).toBe(true);
    expect(
      verifySignature({ rawBody: Buffer.from(rawBody), header: sign(rawBody, t - 60), secret, now }),
    ).toBe(true);
  });

  it('rejects a tampered body or the wrong secret', () => {
    expect(verifySignature({ rawBody: `${rawBody} `, header: sign(rawBody, t), secret, now })).toBe(false);
    expect(verifySignature({ rawBody, header: sign(rawBody, t), secret: 'other', now })).toBe(false);
  });

  it('rejects a timestamp outside the tolerance (replay)', () => {
    expect(verifySignature({ rawBody, header: sign(rawBody, t - 301), secret, now })).toBe(false);
    expect(verifySignature({ rawBody, header: sign(rawBody, t + 301), secret, now })).toBe(false);
    expect(
      verifySignature({ rawBody, header: sign(rawBody, t - 600), secret, now, toleranceSeconds: 900 }),
    ).toBe(true);
  });

  it('rejects a missing or malformed header', () => {
    expect(verifySignature({ rawBody, header: undefined, secret, now })).toBe(false);
    expect(verifySignature({ rawBody, header: 'garbage', secret, now })).toBe(false);
    expect(verifySignature({ rawBody, header: `t=${t},v1=zz`, secret, now })).toBe(false);
  });
});

describe('parseWebhook', () => {
  it('returns the typed body and keeps unknown fields', () => {
    const body = parseWebhook({ api_version: '1.0', event: { ...event(), brand_new_field: 1 } });
    expect(body.event.type).toBe('INITIAL_PURCHASE');
    expect((body.event as unknown as Record<string, unknown>).brand_new_field).toBe(1);
  });

  it('accepts event types it does not know yet', () => {
    expect(parseWebhook({ event: event({ type: 'SOMETHING_NEW' }) }).event.type).toBe('SOMETHING_NEW');
  });

  it('throws RevenueCatWebhookError for a body that is not a webhook', () => {
    expect(() => parseWebhook(null)).toThrow(RevenueCatWebhookError);
    expect(() => parseWebhook({})).toThrow(/event/);
    expect(() => parseWebhook({ event: { ...event(), id: '' } })).toThrow(/event\.id/);
    expect(() => parseWebhook({ event: { ...event(), type: 1 } })).toThrow(/event\.type/);
    expect(() => parseWebhook({ event: { ...event(), event_timestamp_ms: '1' } })).toThrow(
      /event\.event_timestamp_ms/,
    );
  });
});

describe('isNewerEvent', () => {
  const e = event({ id: 'b', event_timestamp_ms: 2000 });

  it('applies the first event', () => {
    expect(isNewerEvent(e, null)).toBe(true);
  });

  it('applies newer events and skips older ones', () => {
    expect(isNewerEvent(e, { id: 'a', timestampMs: 1000 })).toBe(true);
    expect(isNewerEvent(e, { id: 'c', timestampMs: 3000 })).toBe(false);
  });

  it('skips a redelivery but applies another event with the same timestamp', () => {
    expect(isNewerEvent(e, { id: 'b', timestampMs: 2000 })).toBe(false);
    expect(isNewerEvent(e, { id: 'a', timestampMs: 2000 })).toBe(true);
  });
});

describe('appUserIds', () => {
  it('lists every id once, current id first', () => {
    expect(
      appUserIds(event({ app_user_id: 'b', original_app_user_id: 'a', aliases: ['a', 'b', 'c'] })),
    ).toEqual(['b', 'a', 'c']);
  });

  it('copes with missing identity fields', () => {
    expect(appUserIds({ id: 'x', type: 'TEST', event_timestamp_ms: 1 })).toEqual([]);
  });
});

describe('subscriptionStatusFor', () => {
  it.each([
    ['INITIAL_PURCHASE', 'active'],
    ['RENEWAL', 'active'],
    ['UNCANCELLATION', 'active'],
    ['NON_RENEWING_PURCHASE', 'active'],
    ['SUBSCRIPTION_EXTENDED', 'active'],
    ['REFUND_REVERSED', 'active'],
    ['TEMPORARY_ENTITLEMENT_GRANT', 'active'],
    ['CANCELLATION', 'cancelled'],
    ['BILLING_ISSUE', 'billing_issue'],
    ['EXPIRATION', 'expired'],
  ])('%s -> %s', (type, status) => {
    expect(subscriptionStatusFor(event({ type }))).toBe(status);
  });

  it.each(['SUBSCRIPTION_PAUSED', 'PRODUCT_CHANGE', 'TRANSFER', 'TEST', 'SOMETHING_NEW'])(
    '%s changes nothing',
    (type) => {
      expect(subscriptionStatusFor(event({ type }))).toBeNull();
    },
  );

  it('only reports events for the given entitlement', () => {
    expect(subscriptionStatusFor(event(), { entitlementId: 'premium' })).toBe('active');
    expect(subscriptionStatusFor(event(), { entitlementId: 'pro' })).toBeNull();
    expect(subscriptionStatusFor(event({ entitlement_ids: null }), { entitlementId: 'premium' })).toBeNull();
  });

  it('also matches the deprecated single entitlement_id', () => {
    expect(
      subscriptionStatusFor(event({ entitlement_ids: null, entitlement_id: 'premium' }), { entitlementId: 'premium' }),
    ).toBe('active');
  });
});

describe('accessEndsAtMs', () => {
  it('is the expiration for most events, and null only for an explicit lifetime purchase', () => {
    expect(accessEndsAtMs(event({ expiration_at_ms: 5 }))).toBe(5);
    expect(accessEndsAtMs(event({ expiration_at_ms: null }))).toBeNull();
  });

  it('is unknown (undefined) when the payload has no expiration field', () => {
    const { expiration_at_ms: _omitted, ...withoutExpiration } = event();
    expect(accessEndsAtMs(withoutExpiration)).toBeUndefined();
  });

  it('caps a temporary entitlement grant at 24 hours after the event', () => {
    const { expiration_at_ms: _omitted, ...grant } = event({ type: 'TEMPORARY_ENTITLEMENT_GRANT', event_timestamp_ms: 1000 });
    expect(accessEndsAtMs(grant)).toBe(1000 + 24 * 60 * 60 * 1000);
  });

  it('extends a billing issue to the end of the store grace period', () => {
    expect(
      accessEndsAtMs(event({ type: 'BILLING_ISSUE', expiration_at_ms: 5, grace_period_expiration_at_ms: 9 })),
    ).toBe(9);
    expect(
      accessEndsAtMs(event({ type: 'BILLING_ISSUE', expiration_at_ms: 5, grace_period_expiration_at_ms: null })),
    ).toBe(5);
  });
});

describe('hasAccess', () => {
  const now = new Date(1_750_000_000_000);

  it('keeps access until the period ends, also when cancelled or billing failed', () => {
    for (const status of ['active', 'cancelled', 'billing_issue'] as const) {
      expect(hasAccess({ status, expiresAtMs: 1_760_000_000_000 }, now)).toBe(true);
      expect(hasAccess({ status, expiresAtMs: 1_740_000_000_000 }, now)).toBe(false);
    }
  });

  it('treats a purchase without an end (lifetime) as access', () => {
    expect(hasAccess({ status: 'active', expiresAtMs: null }, now)).toBe(true);
  });

  it('fails closed when the end of access is unknown', () => {
    for (const status of ['active', 'cancelled', 'billing_issue'] as const) {
      expect(hasAccess({ status, expiresAtMs: undefined }, now)).toBe(false);
    }
  });

  it('never gives access after expiry or without a subscription', () => {
    expect(hasAccess({ status: 'expired', expiresAtMs: 1_760_000_000_000 }, now)).toBe(false);
    expect(hasAccess(null, now)).toBe(false);
  });
});
