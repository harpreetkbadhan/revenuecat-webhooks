# revenuecat-webhooks

Typed, verified [RevenueCat webhooks](https://www.revenuecat.com/docs/integrations/webhooks) for Node.js, with a NestJS guard and decorator.

Every app with RevenueCat subscriptions needs a backend that keeps entitlements in sync from webhooks. The parts that are easy to get wrong are the same everywhere:

- **Verifying requests.** The `Authorization` header in constant time, or the HMAC `X-RevenueCat-Webhook-Signature` with replay protection.
- **Duplicates and ordering.** RevenueCat delivers *at least once* and doesn't promise order. A retried or late event must not overwrite newer state.
- **What each event means.** `CANCELLATION` doesn't end access, `BILLING_ISSUE` doesn't mean expired, and `SUBSCRIPTION_PAUSED` only revokes access with the `EXPIRATION` that follows.
- **Future fields.** RevenueCat adds fields and event types without an API version change, and your parser must not reject them.

This package does those parts and leaves storage to you.

- Zero runtime dependencies. ESM, usable from CommonJS on Node ≥ 20.19.
- Typed events for all documented event types, open to new ones.
- Optional NestJS adapter: `RevenueCatWebhookModule`, `RevenueCatWebhookGuard`, `@RevenueCatWebhookEvent()`.

```sh
npm install revenuecat-webhooks
```

## NestJS

```ts
// app.module.ts
import { RevenueCatWebhookModule } from 'revenuecat-webhooks/nestjs';

@Module({
  imports: [
    RevenueCatWebhookModule.forRoot({
      authorization: process.env.REVENUECAT_WEBHOOK_AUTH, // the value set in the RevenueCat dashboard
      // and/or: signingSecret: process.env.REVENUECAT_WEBHOOK_SECRET (needs rawBody, below)
    }),
  ],
})
export class AppModule {}
```

```ts
// revenuecat.controller.ts
import type { RevenueCatEvent } from 'revenuecat-webhooks';
import { RevenueCatWebhookEvent, RevenueCatWebhookGuard } from 'revenuecat-webhooks/nestjs';

@Controller('webhooks/revenuecat')
@UseGuards(RevenueCatWebhookGuard)
export class RevenueCatController {
  constructor(private readonly subscriptions: SubscriptionsService) {}

  @Post()
  @HttpCode(200) // RevenueCat treats anything but 200 as a failure and retries
  async receive(@RevenueCatWebhookEvent() event: RevenueCatEvent) {
    await this.subscriptions.apply(event);
  }
}
```

- Requests without the right header or signature get **401** before your handler runs.
- A body that isn't a webhook gets **400**.
- Startup fails if no secret is configured, or if a configured one is empty (usually a missing env var). The guard checks this too, so options you provide yourself (a custom provider or factory) can't leave it open.

For signature verification, create the app with the raw body:

```ts
const app = await NestFactory.create(AppModule, { rawBody: true });
```

## Any framework

```ts
import { parseWebhook, verifyAuthorization, verifySignature } from 'revenuecat-webhooks';

app.post('/webhooks/revenuecat', express.raw({ type: 'application/json' }), async (req, res) => {
  // express.raw only fills req.body with a Buffer for matching content types.
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

  // Check every secret you configured. With both set, require both.
  const ok =
    verifyAuthorization(req.get('Authorization'), process.env.REVENUECAT_WEBHOOK_AUTH!) &&
    verifySignature({
      rawBody, // the bytes as received, before JSON parsing
      header: req.get('X-RevenueCat-Webhook-Signature'),
      secret: process.env.REVENUECAT_WEBHOOK_SECRET!,
    });
  if (!ok) return res.sendStatus(401);

  let event;
  try {
    event = parseWebhook(JSON.parse(rawBody.toString('utf8'))).event;
  } catch {
    return res.sendStatus(400); // not a webhook: don't make RevenueCat retry it
  }

  try {
    await subscriptions.apply(event); // keep it well under RevenueCat's 60 s timeout
    res.sendStatus(200);
  } catch (error) {
    console.error('RevenueCat webhook failed', error);
    res.sendStatus(500); // RevenueCat retries
  }
});
```

Respond `200` only once the event is safely stored (or queued). If you answer first and the work then fails, RevenueCat won't retry and the event is lost.

## Keeping a subscription in sync

```ts
import { accessEndsAtMs, appUserIds, hasAccess, isNewerEvent, subscriptionStatusFor } from 'revenuecat-webhooks';

async function apply(event: RevenueCatEvent) {
  const status = subscriptionStatusFor(event, { entitlementId: 'premium' });
  if (!status) return; // this event doesn't change the subscription

  const user = await users.findFirstByIds(appUserIds(event)); // app user id, original id and aliases
  if (!user) return;

  const current = await subscriptions.find(user.id);
  if (!isNewerEvent(event, current && { id: current.lastEventId, timestampMs: current.lastEventAt })) {
    return; // a retry, or older than what we already applied
  }

  await subscriptions.save(user.id, {
    status,
    expiresAtMs: accessEndsAtMs(event), // grace periods included; undefined (unknown) means no access
    lastEventId: event.id,
    lastEventAt: event.event_timestamp_ms,
  });
}

// Check access when reading, so a lost EXPIRATION webhook can't keep access on forever:
hasAccess(await subscriptions.find(user.id)); // true until the period ends
```

To be safe under concurrent deliveries, do the `isNewerEvent` check and the write atomically, as a conditional update in your database.

## API

| Function | What it does |
|---|---|
| `verifyAuthorization(header, expected)` | Constant-time check of the `Authorization` header. An empty `expected` never matches. |
| `verifySignature({ rawBody, header, secret, toleranceSeconds? })` | Verifies `X-RevenueCat-Webhook-Signature` (HMAC-SHA256 of `<t>.<raw body>`). Default tolerance is 300 s. |
| `parseWebhook(body)` | Checks `event.id`, `event.type` and `event.event_timestamp_ms` and returns the typed body. Throws `RevenueCatWebhookError`. Unknown fields and types pass through. |
| `isNewerEvent(event, last)` | `true` when the event is newer than the last applied one, or has the same timestamp and a different id. |
| `appUserIds(event)` | `app_user_id`, `original_app_user_id` and `aliases`, without duplicates. |
| `subscriptionStatusFor(event, { entitlementId? })` | `'active' \| 'cancelled' \| 'billing_issue' \| 'expired'`, or `null` when the event doesn't change the status. |
| `accessEndsAtMs(event)` | When access ends: `expiration_at_ms`, extended to the store grace period after a `BILLING_ISSUE`, and at most 24 h for a `TEMPORARY_ENTITLEMENT_GRANT`. `null` means lifetime; `undefined` means the payload had no expiration. |
| `hasAccess({ status, expiresAtMs }, now?)` | Access lasts until the period ends, also after a cancellation or a failed charge. `null` expiry means lifetime. An unknown (`undefined`) expiry means no access. |

### How events map to a status

| Status | Events |
|---|---|
| `active` | `INITIAL_PURCHASE`, `RENEWAL`, `UNCANCELLATION`, `NON_RENEWING_PURCHASE`, `SUBSCRIPTION_EXTENDED`, `REFUND_REVERSED`, `TEMPORARY_ENTITLEMENT_GRANT` |
| `cancelled` | `CANCELLATION` (access continues until expiry) |
| `billing_issue` | `BILLING_ISSUE` (access continues until expiry) |
| `expired` | `EXPIRATION` |
| no change | `SUBSCRIPTION_PAUSED`, `PRODUCT_CHANGE`, `TRANSFER`, `TEST` and anything else |

Handle `TRANSFER` (`transferred_from` → `transferred_to`) yourself, since it moves ownership between your users.

## Notes

- A signature stays valid for its tolerance window (5 minutes by default) and RevenueCat sends no nonce, so a captured request could be replayed within it. Make your handler idempotent with `isNewerEvent` (a replay is a duplicate), and consider configuring both the Authorization header and the signing secret.
- `isNewerEvent` applies two different events with the same millisecond timestamp in arrival order.
- RevenueCat retries up to 5 times over about 80 minutes, and gives up if your endpoint takes longer than 60 s. Keep the handler fast. If processing is slow, store or queue the event first, then respond `200`.
- RevenueCat recommends treating webhooks as a trigger and fetching the subscriber from its REST API when you need the full, current state.

## License

MIT
