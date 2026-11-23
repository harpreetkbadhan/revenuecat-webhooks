import 'reflect-metadata';
import { createHmac } from 'node:crypto';
import {
  Controller,
  type DynamicModule,
  HttpCode,
  type INestApplication,
  Module,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import type { RevenueCatEvent } from '../src/index.js';
import {
  REVENUECAT_WEBHOOK_OPTIONS,
  RevenueCatWebhookEvent,
  RevenueCatWebhookGuard,
  RevenueCatWebhookModule,
  type RevenueCatWebhookOptions,
} from '../src/nestjs.js';

@Controller('webhooks/revenuecat')
@UseGuards(RevenueCatWebhookGuard)
class HookController {
  received: RevenueCatEvent[] = [];

  @Post()
  @HttpCode(200)
  receive(@RevenueCatWebhookEvent() event: RevenueCatEvent): void {
    this.received.push(event);
  }
}

const body = { api_version: '1.0', event: { id: 'evt_1', type: 'RENEWAL', event_timestamp_ms: 1 } };
const SECRET = 'whsec_test';
const sign = (raw: string, t = Math.floor(Date.now() / 1000)) =>
  `t=${t},v1=${createHmac('sha256', SECRET).update(`${t}.${raw}`).digest('hex')}`;

let app: INestApplication | undefined;

async function start(options: RevenueCatWebhookOptions, rawBody = true) {
  const moduleRef = await Test.createTestingModule({
    imports: [RevenueCatWebhookModule.forRoot(options)],
    controllers: [HookController],
  }).compile();
  app = moduleRef.createNestApplication({ rawBody, logger: false });
  await app.init();
  return { http: request(app.getHttpServer()), controller: moduleRef.get(HookController) };
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('RevenueCatWebhookModule', () => {
  it('refuses to start without an authorization value or signing secret', () => {
    expect(() => RevenueCatWebhookModule.forRoot({})).toThrow(/authorization.*signingSecret/);
    expect(() => RevenueCatWebhookModule.forRoot({ authorization: '' })).toThrow();
  });
});

describe('RevenueCatWebhookGuard', () => {
  it('refuses to exist without a secret, even when the options are provided by hand', () => {
    expect(() => new RevenueCatWebhookGuard({})).toThrow(/authorization.*signingSecret/);
    expect(() => new RevenueCatWebhookGuard({ authorization: undefined as unknown as string })).toThrow();
    expect(() => new RevenueCatWebhookGuard({ signingSecret: '' })).toThrow(/empty/);
  });

  it('fails startup when a custom provider supplies empty options', async () => {
    await expect(
      Test.createTestingModule({
        providers: [{ provide: REVENUECAT_WEBHOOK_OPTIONS, useValue: {} }, RevenueCatWebhookGuard],
        controllers: [HookController],
      }).compile(),
    ).rejects.toThrow(/authorization.*signingSecret/);
  });
});

describe('RevenueCatWebhookModule.forRootAsync', () => {
  const SECRET_TOKEN = 'SECRET_FROM_CONFIG';

  @Module({})
  class ConfigLikeModule {
    static with(secret: string): DynamicModule {
      return {
        module: ConfigLikeModule,
        providers: [{ provide: SECRET_TOKEN, useValue: secret }],
        exports: [SECRET_TOKEN],
      };
    }
  }

  async function startAsync(secret: string) {
    const moduleRef = await Test.createTestingModule({
      imports: [
        RevenueCatWebhookModule.forRootAsync({
          imports: [ConfigLikeModule.with(secret)],
          inject: [SECRET_TOKEN],
          useFactory: async (authorization: string) => ({ authorization }),
        }),
      ],
      controllers: [HookController],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    return request(app.getHttpServer());
  }

  it('reads the options from injected providers, also asynchronously', async () => {
    const http = await startAsync('Bearer from-config');
    await http.post('/webhooks/revenuecat').set('Authorization', 'Bearer from-config').send(body).expect(200);
    await http.post('/webhooks/revenuecat').set('Authorization', 'Bearer nope').send(body).expect(401);
  });

  it('refuses to start when the factory returns an empty secret', async () => {
    await expect(startAsync('')).rejects.toThrow(/empty/);
  });
});

describe('with an Authorization header', () => {
  it('passes the parsed event to the handler', async () => {
    const { http, controller } = await start({ authorization: 'Bearer s3cret' });
    await http.post('/webhooks/revenuecat').set('Authorization', 'Bearer s3cret').send(body).expect(200);
    expect(controller.received).toEqual([body.event]);
  });

  it('rejects a wrong or missing header with 401 before reading the body', async () => {
    const { http, controller } = await start({ authorization: 'Bearer s3cret' });
    await http.post('/webhooks/revenuecat').set('Authorization', 'Bearer nope').send({}).expect(401);
    await http.post('/webhooks/revenuecat').send(body).expect(401);
    expect(controller.received).toEqual([]);
  });

  it('rejects an authorized body that is not a webhook with 400', async () => {
    const { http } = await start({ authorization: 'Bearer s3cret' });
    await http.post('/webhooks/revenuecat').set('Authorization', 'Bearer s3cret').send({ event: {} }).expect(400);
  });
});

describe('with a signing secret', () => {
  const raw = JSON.stringify(body);

  it('accepts a correctly signed request', async () => {
    const { http, controller } = await start({ signingSecret: SECRET });
    await http
      .post('/webhooks/revenuecat')
      .set('Content-Type', 'application/json')
      .set('X-RevenueCat-Webhook-Signature', sign(raw))
      .send(raw)
      .expect(200);
    expect(controller.received).toHaveLength(1);
  });

  it('rejects a body that does not match the signature', async () => {
    const { http } = await start({ signingSecret: SECRET });
    await http
      .post('/webhooks/revenuecat')
      .set('Content-Type', 'application/json')
      .set('X-RevenueCat-Webhook-Signature', sign(raw))
      .send(raw.replace('RENEWAL', 'EXPIRATION'))
      .expect(401);
  });

  it('fails loudly when the app was created without rawBody', async () => {
    const { http } = await start({ signingSecret: SECRET }, false);
    await http
      .post('/webhooks/revenuecat')
      .set('Content-Type', 'application/json')
      .set('X-RevenueCat-Webhook-Signature', sign(raw))
      .send(raw)
      .expect(500);
  });

  it('requires both checks when both are configured', async () => {
    const { http } = await start({ authorization: 'Bearer s3cret', signingSecret: SECRET });
    await http
      .post('/webhooks/revenuecat')
      .set('Content-Type', 'application/json')
      .set('X-RevenueCat-Webhook-Signature', sign(raw))
      .send(raw)
      .expect(401);
    await http
      .post('/webhooks/revenuecat')
      .set('Content-Type', 'application/json')
      .set('Authorization', 'Bearer s3cret')
      .set('X-RevenueCat-Webhook-Signature', sign(raw))
      .send(raw)
      .expect(200);
  });
});
