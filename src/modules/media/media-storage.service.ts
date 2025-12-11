import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';

export type MediaType = 'image' | 'audio';

@Injectable()
export class MediaStorageService {
  private readonly logger = new Logger(MediaStorageService.name);
  private readonly storageType: string;

  // Modo local
  private readonly uploadDir: string;
  private readonly publicUrl: string;

  // Modo Supabase
  private readonly supabaseUrl: string;
  private readonly supabaseKey: string;
  private readonly supabaseBucket: string;

  constructor(private readonly config: ConfigService) {
    this.storageType    = config.get<string>('storage.type') || 'local';
    this.uploadDir      = config.get<string>('storage.localPath') || './uploads';
    this.publicUrl      = (config.get<string>('storage.publicUrl') || '').replace(/\/$/, '');
    this.supabaseUrl    = config.get<string>('storage.supabase.url') || '';
    this.supabaseKey    = config.get<string>('storage.supabase.key') || '';
    this.supabaseBucket = config.get<string>('storage.supabase.bucket') || 'chatbot-uploads';

    if (this.storageType === 'local') {
      fs.mkdirSync(this.uploadDir, { recursive: true });
    }
  }

  async saveMedia(buffer: Buffer, type: MediaType, id: string): Promise<string> {
    const ext      = type === 'audio' ? 'ogg' : 'jpg';
    const prefix   = type === 'audio' ? 'audio' : 'img';
    const fileName = `${prefix}_${id}_${Date.now()}.${ext}`;
    const mimeType = type === 'audio' ? 'audio/ogg' : 'image/jpeg';

    if (this.storageType === 'supabase') {
      return this.uploadToSupabase(buffer, fileName, mimeType);
    }
    return this.saveLocally(buffer, fileName);
  }

  private async saveLocally(buffer: Buffer, fileName: string): Promise<string> {
    const filePath = path.join(this.uploadDir, fileName);
    await fs.promises.writeFile(filePath, buffer);
    this.logger.debug(`Media guardada localmente: ${fileName}`);
    return this.publicUrl
      ? `${this.publicUrl}/uploads/${fileName}`
      : `/uploads/${fileName}`;
  }

  private async uploadToSupabase(buffer: Buffer, fileName: string, mimeType: string): Promise<string> {
    const uploadUrl = `${this.supabaseUrl}/storage/v1/object/${this.supabaseBucket}/${fileName}`;
    await axios.post(uploadUrl, buffer, {
      headers: {
        Authorization: `Bearer ${this.supabaseKey}`,
        'Content-Type': mimeType,
      },
      maxBodyLength: Infinity,
    });
    this.logger.debug(`Media subida a Supabase: ${fileName}`);
    return `${this.supabaseUrl}/storage/v1/object/public/${this.supabaseBucket}/${fileName}`;
  }
}
