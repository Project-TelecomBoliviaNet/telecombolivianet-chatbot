import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { AxiosInstance } from 'axios';
import { createGeminiClient, geminiUrl } from '../../common/http/gemini-client';
import { WhatsappApiService } from '../whatsapp/whatsapp-api.service';
import { SistemaApiService } from '../client/sistema-api.service';
import { SessionData } from '../session/session.service';

// ══════════════════════════════════════════════════════════════
// RECEIPT HANDLER SERVICE (US-06) — Versión Gemini Vision
//
// Reemplaza Tesseract.js (OCR clásico basado en texto) por
// Gemini Vision (modelo multimodal que "ve" la imagen).
//
// Ventajas sobre Tesseract:
//   - Entiende logos, tablas, sellos y diseños complejos
//   - No necesita instalar binarios nativos en Docker
//   - Devuelve JSON estructurado directamente (sin regex frágiles)
//   - Maneja comprobantes torcidos, con ruido o baja resolución
//   - Reconoce bancos bolivianos por su logo, no solo por texto
//   - Misma API key que el resto del proyecto (GEMINI_API_KEY)
//
// Flujo (idéntico al anterior, solo cambia el paso de extracción):
//   1. Descargar imagen de Meta → Buffer
//   2. Guardar en almacenamiento (local / MinIO)
//   3. Enviar imagen a Gemini Vision → JSON con datos
//   4. Registrar en sistema C# con los datos extraídos
// ══════════════════════════════════════════════════════════════

export interface OcrResult {
  rawText: string;
  amount: number | null;
  bank: string | null;
  date: string | null;
}

// Estructura JSON que le pedimos a Gemini que devuelva
interface GeminiReceiptData {
  monto: number | null;
  banco: string | null;
  fecha: string | null;
  descripcion: string;
  esComprobante: boolean;
}

// Tipos de la API de Gemini
interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
}
interface GeminiCandidate {
  content: { parts: Array<{ text: string }> };
}
interface GeminiResponse {
  candidates: GeminiCandidate[];
}

// Prompt que le enviamos a Gemini junto con la imagen.
// Pedimos JSON puro para poder parsearlo directamente.
const RECEIPT_PROMPT = `
Analiza esta imagen de un comprobante de pago boliviano.
Extrae los siguientes datos y responde ÚNICAMENTE con un objeto JSON válido,
sin texto adicional, sin bloques de código, sin explicaciones:

{
  "monto": <número decimal o null>,
  "banco": <nombre del banco/entidad o null>,
  "fecha": <fecha en formato DD/MM/YYYY o null>,
  "descripcion": <descripción breve de lo que se ve en la imagen, máx 100 caracteres>,
  "esComprobante": <true si parece un comprobante de pago, false si no>
}

Reglas:
- Para "monto": busca el total pagado en bolivianos (Bs.). Solo el número, sin símbolo.
- Para "banco": identifica la entidad emisora (BCP, BNB, Banco Unión, Tigo Money, QR Bolivia, etc.)
- Para "fecha": la fecha de la transacción, no la de vencimiento
- Si un campo no está visible o no es legible, usa null
- Si la imagen no parece un comprobante de pago, pon esComprobante: false y el resto null
`.trim();

@Injectable()
export class ReceiptHandlerService {
  private readonly logger = new Logger(ReceiptHandlerService.name);
  private readonly storageType: string;
  private readonly localPath: string;
  private readonly apiKey: string;
  private readonly model: string;
  private http: AxiosInstance;

  constructor(
    private readonly config: ConfigService,
    private readonly whatsappApi: WhatsappApiService,
    private readonly sistemaApi: SistemaApiService,
  ) {
    this.storageType = config.get<string>('storage.type');
    this.localPath   = config.get<string>('storage.localPath');
    this.apiKey      = config.get<string>('gemini.apiKey');
    // Usamos el mismo modelo que para RAG (gemini-2.0-flash soporta visión)
    this.model       = config.get<string>('gemini.ragModel');

    if (this.storageType === 'local') {
      fs.mkdirSync(this.localPath, { recursive: true });
    }

    this.http = createGeminiClient(this.apiKey);
  }

  async handle(
    imageId: string,
    caption: string | undefined,
    session: SessionData,
  ): Promise<OcrResult | null> {
    try {
      // ── Paso 1: Descargar imagen de Meta ──────────────────
      this.logger.debug(`Descargando imagen ${imageId}`);
      const imageBuffer = await this.whatsappApi.downloadMedia(imageId);

      // ── Paso 2: Guardar en almacenamiento ─────────────────
      const fileName = `comprobante_${uuidv4()}.jpg`;
      const imageUrl = await this.saveImage(imageBuffer, fileName);

      // ── Paso 3: Analizar con Gemini Vision ────────────────
      const ocrResult = await this.analyzeWithGemini(imageBuffer, caption);
      this.logger.debug(
        `Gemini Vision: monto=${ocrResult.amount}, banco=${ocrResult.bank}, ` +
        `fecha=${ocrResult.date}, esComprobante determinado por descripción`,
      );

      // ── Paso 4: Registrar en sistema C# ───────────────────
      await this.sistemaApi.submitWhatsappReceipt({
        ClientId: session.clientId,
        ImageUrl: imageUrl,
        MessageText: caption || ocrResult.rawText.substring(0, 500),
        DeclaredAmount: ocrResult.amount,
        OcrBank: ocrResult.bank,
        OcrDate: ocrResult.date,
        OcrRawText: ocrResult.rawText.substring(0, 1000),
        PhoneNumber: session.phoneNumber,
      });

      return ocrResult;
    } catch (err) {
      this.logger.error(`Error procesando comprobante: ${err.message}`, err.stack);
      return null;
    }
  }

  // ─── Análisis de imagen con Gemini Vision ────────────────
  // Gemini acepta imágenes como base64 en el campo inlineData.
  // El modelo gemini-2.0-flash soporta visión por defecto.
  private async analyzeWithGemini(
    imageBuffer: Buffer,
    caption?: string,
  ): Promise<OcrResult> {
    if (!this.apiKey) {
      this.logger.warn('GEMINI_API_KEY no configurada — OCR deshabilitado');
      return this.emptyResult(caption || '');
    }

    try {
      const base64Image = imageBuffer.toString('base64');
      // Meta siempre devuelve JPEG para imágenes de WhatsApp
      const mimeType = 'image/jpeg';

      // Construir el mensaje multimodal: texto + imagen
      const parts: GeminiPart[] = [
        { text: RECEIPT_PROMPT },
        { inlineData: { mimeType, data: base64Image } },
      ];

      // Si el usuario añadió un caption al enviar la imagen, lo incluimos
      // como contexto adicional para que Gemini lo considere
      if (caption?.trim()) {
        parts.push({ text: `\nEl cliente añadió este texto al enviar la imagen: "${caption}"` });
      }

      const url = geminiUrl(this.model, 'generateContent');

      const res = await this.http.post<GeminiResponse>(url, {
        contents: [{ parts }],
        generationConfig: {
          temperature: 0,         // Determinista — queremos datos exactos
          maxOutputTokens: 256,   // Solo necesitamos el JSON pequeño
        },
      });

      const rawText = res.data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      return this.parseGeminiResponse(rawText);

    } catch (err) {
      this.logger.warn(`Gemini Vision falló: ${err.message}. Continuando sin OCR.`);
      return this.emptyResult(caption || '');
    }
  }

  // ─── Parsear la respuesta JSON de Gemini ─────────────────
  // Gemini puede devolver el JSON con o sin bloques de código.
  // Limpiamos cualquier wrapper antes de parsear.
  private parseGeminiResponse(rawText: string): OcrResult {
    try {
      // Limpiar posibles bloques ```json ... ``` que Gemini a veces añade
      const clean = rawText
        .replace(/```json\s*/gi, '')
        .replace(/```\s*/gi, '')
        .trim();

      const data: GeminiReceiptData = JSON.parse(clean);

      return {
        rawText: data.descripcion || rawText,
        amount: typeof data.monto === 'number' && data.monto > 0 ? data.monto : null,
        bank: data.banco || null,
        date: data.fecha || null,
      };
    } catch (err) {
      // Si Gemini no devolvió JSON válido, guardamos el texto crudo
      this.logger.warn(`No se pudo parsear JSON de Gemini: ${err.message}`);
      return {
        rawText: rawText.substring(0, 500),
        amount: null,
        bank: null,
        date: null,
      };
    }
  }

  // ─── Resultado vacío (fallback si Gemini no está disponible) ─
  private emptyResult(rawText: string): OcrResult {
    return { rawText, amount: null, bank: null, date: null };
  }

  // ─── Guardar imagen ───────────────────────────────────────
  // Sin cambios respecto a la versión original.
  private async saveImage(buffer: Buffer, fileName: string): Promise<string> {
    if (this.storageType === 'local') {
      const filePath = path.join(this.localPath, fileName);
      fs.writeFileSync(filePath, buffer);
      const port = this.config.get<number>('app.port') || 3001;
      return `http://localhost:${port}/uploads/${fileName}`;
    }

    // MinIO fallback
    this.logger.warn('MinIO no configurado — guardando comprobante localmente');
    const filePath = path.join(this.localPath, fileName);
    fs.mkdirSync(this.localPath, { recursive: true });
    fs.writeFileSync(filePath, buffer);
    const port = this.config.get<number>('app.port') || 3001;
    return `http://localhost:${port}/uploads/${fileName}`;
  }
}
