/**
 * Types for RevenueCat webhook payloads.
 *
 * Source: https://www.revenuecat.com/docs/integrations/webhooks/event-types-and-fields
 * RevenueCat adds fields and event types without changing the API version, so the
 * unions below stay open (`string & {}`) and unknown fields are kept.
 */

/** Event types documented by RevenueCat. New ones may arrive at any time. */
export type KnownRevenueCatEventType =
  | 'TEST'
  | 'INITIAL_PURCHASE'
  | 'RENEWAL'
  | 'CANCELLATION'
  | 'UNCANCELLATION'
  | 'NON_RENEWING_PURCHASE'
  | 'SUBSCRIPTION_PAUSED'
  | 'EXPIRATION'
  | 'BILLING_ISSUE'
  | 'PRODUCT_CHANGE'
  | 'SUBSCRIPTION_EXTENDED'
  | 'REFUND_REVERSED'
  | 'INVOICE_ISSUANCE'
  | 'TRANSFER'
  | 'TEMPORARY_ENTITLEMENT_GRANT'
  | 'VIRTUAL_CURRENCY_TRANSACTION'
  | 'EXPERIMENT_ENROLLMENT'
  | 'PURCHASE_REDEEMED'
  | 'SUBSCRIBER_ALIAS'
  | 'PRICE_INCREASE_CONSENT_REQUIRED'
  | 'PRICE_INCREASE_CONSENT_APPROVED';

export type RevenueCatEventType = KnownRevenueCatEventType | (string & {});

export type RevenueCatStore =
  | 'AMAZON'
  | 'APP_STORE'
  | 'MAC_APP_STORE'
  | 'PADDLE'
  | 'PLAY_STORE'
  | 'PROMOTIONAL'
  | 'RC_BILLING'
  | 'ROKU'
  | 'STRIPE'
  | 'TEST_STORE'
  | (string & {});

export type RevenueCatEnvironment = 'SANDBOX' | 'PRODUCTION';

export type RevenueCatPeriodType = 'TRIAL' | 'INTRO' | 'NORMAL' | 'PROMOTIONAL' | 'PREPAID' | (string & {});

export type RevenueCatCancelReason =
  | 'UNSUBSCRIBE'
  | 'BILLING_ERROR'
  | 'DEVELOPER_INITIATED'
  | 'PRICE_INCREASE'
  | 'CUSTOMER_SUPPORT'
  | 'UNKNOWN'
  | (string & {});

export type RevenueCatExpirationReason = RevenueCatCancelReason | 'SUBSCRIPTION_PAUSED';

/**
 * A webhook event. Only `id`, `type` and `event_timestamp_ms` are guaranteed for
 * every type; the rest depends on the event type and store, so it is optional.
 */
export interface RevenueCatEvent {
  id: string;
  type: RevenueCatEventType;
  event_timestamp_ms: number;
  app_id?: string;
  app_user_id?: string;
  original_app_user_id?: string;
  aliases?: string[];
  subscriber_attributes?: Record<string, { value: string; updated_at_ms: number }>;
  product_id?: string | null;
  period_type?: RevenueCatPeriodType;
  purchased_at_ms?: number | null;
  /** Null for lifetime and other non-expiring purchases. */
  expiration_at_ms?: number | null;
  environment?: RevenueCatEnvironment;
  /** @deprecated Use `entitlement_ids`. */
  entitlement_id?: string | null;
  entitlement_ids?: string[] | null;
  presented_offering_id?: string | null;
  transaction_id?: string;
  original_transaction_id?: string;
  is_family_share?: boolean;
  country_code?: string;
  store?: RevenueCatStore;
  currency?: string | null;
  /** In USD. Negative for refunds, 0 for free trials. */
  price?: number | null;
  price_in_purchased_currency?: number | null;
  tax_percentage?: number | null;
  commission_percentage?: number | null;
  offer_code?: string | null;
  renewal_number?: number;
  is_trial_conversion?: boolean;
  /** CANCELLATION only. */
  cancel_reason?: RevenueCatCancelReason;
  /** EXPIRATION only. */
  expiration_reason?: RevenueCatExpirationReason;
  /** BILLING_ISSUE only. */
  grace_period_expiration_at_ms?: number | null;
  /** SUBSCRIPTION_PAUSED only (Google Play). */
  auto_resume_at_ms?: number;
  /** PRODUCT_CHANGE only. */
  new_product_id?: string;
  /** TRANSFER only. */
  transferred_from?: string[];
  /** TRANSFER only. */
  transferred_to?: string[];
}

export interface RevenueCatWebhookBody {
  api_version?: string;
  event: RevenueCatEvent;
}
