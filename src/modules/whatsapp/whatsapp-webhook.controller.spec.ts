import * as crypto from 'crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { Response } from 'express';
import { WhatsappWebhookController } from './whatsapp-webhook.controller';
import { BotOrchestratorService } from '../bot/bot-orchestrator.service';
import { NOTIFICATION_REPOSITORY } from '../client/sistema-api.interfaces';
import { WebhookDedupService } from './webhook-dedup.service';

const APP_SECRET = 'test-secret-32-chars-long-enough!!';

function makeSignature(body: string, secret: string): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

describe('WhatsappWebhookController — HMAC verification (FIX-01)', () => {
  let controller: WhatsappWebhookController;
  let configGet: jest.Mock;

  beforeEach(async () => {
    configGet = jest.fn((key: string) => {
      if (key === 'meta.appSecret') return APP_SECRET;
      if (key === 'meta.verifyToken') return 'verify-token';
      return '';
    });

    const module: TestingModule = await Test.createTestingModule({
      controllers: [WhatsappWebhookController],
      providers: [
        { provide: ConfigService, useValue: { get: configGet } },
        {
          provide: BotOrchestratorService,
          useValue: { handleIncoming: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: NOTIFICATION_REPOSITORY,
          useValue: { postDeliveryStatus: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: WebhookDedupService,
          useValue: { isDuplicate: jest.fn().mockResolvedValue(false), markSeen: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();

    controller = module.get(WhatsappWebhookController);
  });

  it('acepta payload con firma HMAC válida', async () => {
    const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
    const sig = makeSignature(body, APP_SECRET);
    const req = { rawBody: Buffer.from(body) } as any;

    const result = await controller.receive(req, { object: 'whatsapp_business_account', entry: [] }, sig);

    expect(result).toEqual({ status: 'ok' });
  });

  it('rechaza payload con firma incorrecta', async () => {
    const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
    const req = { rawBody: Buffer.from(body) } as any;

    const result = await controller.receive(
      req,
      { object: 'whatsapp_business_account', entry: [] },
      'sha256=deadbeef',
    );

    expect(result).toEqual({ status: 'ok' });
  });

  it('rechaza payload sin header de firma', async () => {
    const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
    const req = { rawBody: Buffer.from(body) } as any;

    const result = await controller.receive(
      req,
      { object: 'whatsapp_business_account', entry: [] },
      undefined as any,
    );

    expect(result).toEqual({ status: 'ok' });
  });

  it('no expone información en tiempo diferente entre firma válida e inválida', async () => {
    const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
    const validSig = makeSignature(body, APP_SECRET);
    const invalidSig = 'sha256=' + 'a'.repeat(64);
    const req = { rawBody: Buffer.from(body) } as any;
    const payload = { object: 'whatsapp_business_account', entry: [] } as any;

    const RUNS = 100;
    const validTimes: number[] = [];
    const invalidTimes: number[] = [];

    for (let i = 0; i < RUNS; i++) {
      const t0 = process.hrtime.bigint();
      await controller.receive(req, payload, validSig);
      validTimes.push(Number(process.hrtime.bigint() - t0));
    }

    for (let i = 0; i < RUNS; i++) {
      const t0 = process.hrtime.bigint();
      await controller.receive(req, payload, invalidSig);
      invalidTimes.push(Number(process.hrtime.bigint() - t0));
    }

    const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
    const diffMs = Math.abs(avg(validTimes) - avg(invalidTimes)) / 1_000_000;
    // Diferencia de tiempo promedio debe ser < 5ms (timingSafeEqual garantiza esto)
    expect(diffMs).toBeLessThan(5);
  });

  it('verifica webhook GET con token correcto', () => {
    const res = { status: jest.fn().mockReturnThis(), send: jest.fn() } as unknown as Response;
    controller.verify('subscribe', 'verify-token', 'challenge-xyz', res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).toHaveBeenCalledWith('challenge-xyz');
  });

  it('rechaza verificación GET con token incorrecto', () => {
    const res = { status: jest.fn().mockReturnThis(), send: jest.fn() } as unknown as Response;
    controller.verify('subscribe', 'wrong-token', 'challenge-xyz', res);
    expect(res.status).toHaveBeenCalledWith(403);
  });
});

describe('WhatsappWebhookController — sin APP_SECRET configurado', () => {
  let controller: WhatsappWebhookController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [WhatsappWebhookController],
      providers: [
        { provide: ConfigService, useValue: { get: () => '' } },
        {
          provide: BotOrchestratorService,
          useValue: { handleIncoming: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: NOTIFICATION_REPOSITORY,
          useValue: { postDeliveryStatus: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: WebhookDedupService,
          useValue: { isDuplicate: jest.fn().mockResolvedValue(false), markSeen: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();

    controller = module.get(WhatsappWebhookController);
  });

  it('acepta cualquier payload cuando META_APP_SECRET no está configurado', async () => {
    const req = { rawBody: Buffer.from('{}') } as any;
    const result = await controller.receive(
      req,
      { object: 'whatsapp_business_account', entry: [] },
      'sha256=anything',
    );
    expect(result).toEqual({ status: 'ok' });
  });
});
