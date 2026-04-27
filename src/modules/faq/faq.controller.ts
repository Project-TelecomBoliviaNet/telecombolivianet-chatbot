/**
 * @file faq.controller.ts
 * @description Controlador REST para gestión de FAQs por el administrador.
 *
 * Endpoints:
 *   POST   /admin/faq           → crear FAQ
 *   GET    /admin/faq           → listar FAQs (paginado, filtros)
 *   GET    /admin/faq/:id       → detalle de una FAQ
 *   PATCH  /admin/faq/:id       → actualizar FAQ
 *   DELETE /admin/faq/:id       → eliminar FAQ
 *
 * Auth: Bearer token estático (SISTEMA_BOT_STATIC_TOKEN) —
 * mismo mecanismo que MonitorController y RagDocumentsController.
 */

import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  Headers,
  UnauthorizedException,
  BadRequestException,
  Logger,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FaqService } from './faq.service';
import { isValidToken, extractBearerToken } from '../../common/security/token.util';
import {
  CreateFaqDto,
  UpdateFaqDto,
  FaqResponseDto,
  FaqListResponseDto,
} from './faq.dto';

@Controller('admin/faq')
export class FaqController {
  private readonly logger = new Logger(FaqController.name);
  private readonly staticToken: string;

  constructor(
    private readonly faqService: FaqService,
    private readonly config:     ConfigService,
  ) {
    this.staticToken = config.get<string>('sistema.botStaticToken') ?? '';
  }

  // ─── Autenticación ─────────────────────────────────────────────────────────

  private checkAuth(authHeader: string | undefined): void {
    const received = extractBearerToken(authHeader);
    if (!received || !isValidToken(received, this.staticToken)) {
      throw new UnauthorizedException('Token inválido o ausente');
    }
  }

  // ─── POST /admin/faq ───────────────────────────────────────────────────────

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Headers('authorization') auth: string,
    @Body() body: CreateFaqDto,
  ): Promise<FaqResponseDto> {
    this.checkAuth(auth);
    this.validateCreateBody(body);
    return this.faqService.create(body);
  }

  // ─── GET /admin/faq ────────────────────────────────────────────────────────

  @Get()
  async findAll(
    @Headers('authorization') auth: string,
    @Query('tag')    tag?:    string,
    @Query('active') active?: string,
    @Query('page')   page?:   string,
    @Query('limit')  limit?:  string,
  ): Promise<FaqListResponseDto> {
    this.checkAuth(auth);

    return this.faqService.findAll({
      tag,
      active: active === 'true' ? true : active === 'false' ? false : undefined,
      page:   page  ? parseInt(page,  10) : undefined,
      limit:  limit ? parseInt(limit, 10) : undefined,
    });
  }

  // ─── GET /admin/faq/:id ────────────────────────────────────────────────────

  @Get(':id')
  async findOne(
    @Headers('authorization') auth: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<FaqResponseDto> {
    this.checkAuth(auth);
    return this.faqService.findOne(id);
  }

  // ─── PATCH /admin/faq/:id ──────────────────────────────────────────────────

  @Patch(':id')
  async update(
    @Headers('authorization') auth: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateFaqDto,
  ): Promise<FaqResponseDto> {
    this.checkAuth(auth);
    return this.faqService.update(id, body);
  }

  // ─── DELETE /admin/faq/:id ─────────────────────────────────────────────────

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Headers('authorization') auth: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    this.checkAuth(auth);
    await this.faqService.remove(id);
  }

  // ─── Validación de body ────────────────────────────────────────────────────

  private validateCreateBody(body: CreateFaqDto): void {
    if (!body?.question || !body?.answer) {
      throw new BadRequestException(
        'Los campos "question" y "answer" son obligatorios',
      );
    }
    if (body.priority !== undefined &&
        (body.priority < 1 || body.priority > 10 || !Number.isInteger(body.priority))) {
      throw new BadRequestException('priority debe ser un entero entre 1 y 10');
    }
  }
}
