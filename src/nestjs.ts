import {
  BadRequestException,
  type CanActivate,
  createParamDecorator,
  type DynamicModule,
  type ExecutionContext,
  Inject,
  Injectable,
  Module,
  UnauthorizedException,
} from '@nestjs/common';
import { parseWebhook, RevenueCatWebhookError } from './events.js';
import type { RevenueCatEvent } from './types.js';
import { verifyAuthorization, verifySignature } from './verify.js';

export const REVENUECAT_WEBHOOK_OPTIONS = Symbol('REVENUECAT_WEBHOOK_OPTIONS');

const SIGNATURE_HEADER = 'x-revenuecat-webhook-signature';

export interface RevenueCatWebhookOptions {
  /** The Authorization header value set in the RevenueCat dashboard. */
  authorization?: string;
  /**
   * The webhook signing secret, to verify `X-RevenueCat-Webhook-Signature`.
   * Needs the raw body: `NestFactory.create(AppModule, { rawBody: true })`.
   */
  signingSecret?: string;
  /** Allowed age of a signature, against replays. Default 300 seconds. */
  signatureToleranceSeconds?: number;
}

interface WebhookRequest {
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  rawBody?: Buffer;
}

/**
 * Throws unless at least one secret is configured and none is empty. Runs in
 * `forRoot` and again in the guard, so options provided by hand (a custom provider
 * or a factory reading a missing env var) can never leave the guard open.
 */
function assertValidOptions(options: RevenueCatWebhookOptions): void {
  for (const key of ['authorization', 'signingSecret'] as const) {
    if (key in options && !options[key]) {
      throw new Error(`RevenueCat webhook options: \`${key}\` is empty (missing environment variable?)`);
    }
  }
  if (!options.authorization && !options.signingSecret) {
    throw new Error('RevenueCat webhook options need `authorization` and/or `signingSecret`');
  }
}

const headerValue = (request: WebhookRequest, name: string): string | undefined => {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
};

/**
 * Lets a request through only when it carries the configured Authorization header
 * and/or a valid signature; anything else gets 401 before the body is looked at.
 */
@Injectable()
export class RevenueCatWebhookGuard implements CanActivate {
  constructor(@Inject(REVENUECAT_WEBHOOK_OPTIONS) private readonly options: RevenueCatWebhookOptions) {
    assertValidOptions(options);
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<WebhookRequest>();
    const { authorization, signingSecret, signatureToleranceSeconds } = this.options;

    if (authorization !== undefined && !verifyAuthorization(headerValue(request, 'authorization'), authorization)) {
      throw new UnauthorizedException();
    }
    if (signingSecret !== undefined) {
      if (!request.rawBody) {
        throw new Error(
          'RevenueCat signature verification needs the raw request body: create the app with ' +
            '`NestFactory.create(AppModule, { rawBody: true })`.',
        );
      }
      const valid = verifySignature({
        rawBody: request.rawBody,
        header: headerValue(request, SIGNATURE_HEADER),
        secret: signingSecret,
        ...(signatureToleranceSeconds === undefined ? {} : { toleranceSeconds: signatureToleranceSeconds }),
      });
      if (!valid) {
        throw new UnauthorizedException();
      }
    }
    return true;
  }
}

/**
 * Injects the parsed, typed webhook event into a handler parameter.
 * A body that is not a RevenueCat webhook is rejected with 400.
 */
export const RevenueCatWebhookEvent = createParamDecorator(
  (_data: unknown, context: ExecutionContext): RevenueCatEvent => {
    const { body } = context.switchToHttp().getRequest<WebhookRequest>();
    try {
      return parseWebhook(body).event;
    } catch (error) {
      if (error instanceof RevenueCatWebhookError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  },
);

@Module({})
export class RevenueCatWebhookModule {
  /**
   * Registers the guard globally with its options. Fails at startup when no secret is
   * configured, or a configured one is empty (usually a missing environment variable).
   */
  static forRoot(options: RevenueCatWebhookOptions): DynamicModule {
    assertValidOptions(options);
    return {
      module: RevenueCatWebhookModule,
      global: true,
      providers: [{ provide: REVENUECAT_WEBHOOK_OPTIONS, useValue: options }, RevenueCatWebhookGuard],
      exports: [REVENUECAT_WEBHOOK_OPTIONS, RevenueCatWebhookGuard],
    };
  }
}
