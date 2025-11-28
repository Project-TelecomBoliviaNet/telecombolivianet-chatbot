/**
 * Genera el mensaje de clasificación de imagen cuando el intent es desconocido.
 * Si hay caption, incluye su contenido en la pregunta para dar contexto al usuario.
 * Si no hay caption, usa el mensaje genérico de selección 1 / 2.
 */
export function buildImageClassificationPrompt(caption?: string | null): string {
  const captionHint = caption?.trim()
    ? `\n\nVi que escribiste: _"${caption.trim()}"_`
    : '';

  return (
    `📷 Recibí tu imagen.${captionHint}\n\n` +
    `Para atenderte mejor, ¿qué tipo de imagen es?\n\n` +
    `1️⃣ *Comprobante de pago* — transferencia, QR, recibo\n` +
    `2️⃣ *Foto de mi equipo* — modem, router, cables\n\n` +
    `Responde *1* o *2* 🙏`
  );
}
