export const WHATSAPP_MESSENGER = Symbol('WHATSAPP_MESSENGER');

export interface IWhatsappMessenger {
  sendText(to: string, text: string): Promise<string>;
  sendImage(to: string, imageUrl: string, caption?: string): Promise<string>;
  sendList(
    to: string,
    body: string,
    buttonLabel: string,
    sections: Array<{
      title: string;
      rows: Array<{ id: string; title: string; description?: string }>;
    }>,
  ): Promise<string>;
  sendButtons(
    to: string,
    body: string,
    buttons: Array<{ id: string; title: string }>,
  ): Promise<string>;
  markAsRead(messageId: string): Promise<void>;
  downloadMedia(mediaId: string): Promise<Buffer>;
}
