import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const DEFAULT_TOLERANCE_SECONDS = 300;
const SIGNATURE_PATTERN = /^t=(\d+),v1=([0-9a-f]{64})$/i;

const sha256 = (value: string): Buffer => createHash('sha256').update(value).digest();

/**
 * Checks the `Authorization` header RevenueCat sends with every webhook against the
 * value set in the RevenueCat dashboard. Compared as hashes in constant time, so
 * neither the length nor the content of the secret leaks through timing.
 * An empty `expected` never matches, so a missing env var fails closed.
 */
export function verifyAuthorization(received: string | undefined, expected: string): boolean {
  if (!expected || !received) {
    return false;
  }
  return timingSafeEqual(sha256(received), sha256(expected));
}

export interface VerifySignatureOptions {
  /** The request body exactly as received, before JSON parsing. */
  rawBody: string | Buffer;
  /** The `X-RevenueCat-Webhook-Signature` header: `t=<unix seconds>,v1=<hex HMAC-SHA256>`. */
  header: string | undefined;
  /** The webhook signing secret from the RevenueCat dashboard. */
  secret: string;
  /** How far the signed timestamp may be from now, against replays. Default 300 (5 minutes). */
  toleranceSeconds?: number;
  /** The current time; for tests. */
  now?: Date;
}

/**
 * Verifies RevenueCat's optional HMAC webhook signature: HMAC-SHA256 of
 * `<timestamp>.<raw body>` with the signing secret, and a timestamp within the tolerance.
 */
export function verifySignature({
  rawBody,
  header,
  secret,
  toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
  now = new Date(),
}: VerifySignatureOptions): boolean {
  const match = header ? SIGNATURE_PATTERN.exec(header.trim()) : null;
  if (!secret || !match) {
    return false;
  }
  const [, timestamp, signature] = match as unknown as [string, string, string];
  if (Math.abs(now.getTime() / 1000 - Number(timestamp)) > toleranceSeconds) {
    return false;
  }
  const expected = createHmac('sha256', secret)
    .update(`${timestamp}.`)
    .update(rawBody)
    .digest();
  return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}
