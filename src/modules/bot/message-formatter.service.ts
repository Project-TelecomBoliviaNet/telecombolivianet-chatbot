import { Injectable } from '@nestjs/common';
import { InvoiceDto, PlanDto, SlotDto } from '../client/sistema-api.service';

// ══════════════════════════════════════════════════════════════
// MESSAGE FORMATTER SERVICE
// Centraliza la construcción de todos los textos que el bot
// envía al cliente. Facilita mantenimiento y consistencia.
// ══════════════════════════════════════════════════════════════

@Injectable()
export class MessageFormatterService {

  // ─── Bienvenida ───────────────────────────────────────────
  welcome(name: string): string {
    return (
      `¡Hola ${name}! 👋 Soy el asistente virtual de *Telecom Bolivianet*.\n\n` +
      `¿En qué puedo ayudarte hoy?\n\n` +
      `1️⃣ Consultar mi deuda\n` +
      `2️⃣ Obtener QR de pago\n` +
      `3️⃣ Reportar un problema técnico\n` +
      `4️⃣ Agendar una instalación\n` +
      `5️⃣ Información sobre planes\n\n` +
      `Escribe tu consulta o elige una opción.`
    );
  }

  welcomeProspect(): string {
    return (
      `¡Hola! 👋 Soy el asistente virtual de *Telecom Bolivianet*.\n\n` +
      `Veo que aún no eres cliente. Te puedo ayudar con:\n\n` +
      `📋 Información sobre nuestros planes\n` +
      `🔧 Agendar una instalación\n` +
      `❓ Preguntas generales\n\n` +
      `¿En qué te puedo ayudar?`
    );
  }

  // ─── Deuda ────────────────────────────────────────────────
  debtSummary(name: string, pendingInvoices: InvoiceDto[]): string {
    if (pendingInvoices.length === 0) {
      return (
        `✅ *${name}*, estás al día con tus pagos.\n\n` +
        `No tienes facturas pendientes. ¡Gracias por pagar a tiempo! 🎉`
      );
    }

    const months = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
      'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

    const total = pendingInvoices.reduce((s, i) => s + i.Amount, 0);
    const lines = pendingInvoices.map((inv) => {
      const label = `${months[inv.Month - 1]} ${inv.Year}`;
      const status = inv.Status === 'Vencida' ? ' ⚠️ *VENCIDA*' : '';
      return `  • ${label}: *Bs. ${inv.Amount.toFixed(2)}*${status}`;
    });

    return (
      `💰 *Resumen de deuda — ${name}*\n\n` +
      `${lines.join('\n')}\n\n` +
      `📊 *Total a pagar: Bs. ${total.toFixed(2)}*\n` +
      `📅 Fecha límite de pago: día *5 de cada mes*\n\n` +
      `¿Deseas recibir el *código QR* para pagar ahora? 👇`
    );
  }

  // ─── QR ───────────────────────────────────────────────────
  qrInstruction(name: string, tbnCode: string, total: number): string {
    return (
      `📲 *QR de pago — ${name}*\n\n` +
      `Al realizar el depósito, usa como concepto:\n` +
      `➡️ *${tbnCode}*\n\n` +
      `💵 Monto total: *Bs. ${total.toFixed(2)}*\n\n` +
      `⚠️ Una vez realizado el pago, *envíanos la foto del comprobante* por este mismo chat para que lo verifiquemos.`
    );
  }

  noDebtForQr(name: string): string {
    return `✅ *${name}*, no tienes pagos pendientes. ¡Tu cuenta está al día! 🎉`;
  }

  suspendedClientQr(name: string, total: number): string {
    return (
      `⚠️ *${name}*, tu servicio está actualmente *suspendido*.\n\n` +
      `Deuda total: *Bs. ${total.toFixed(2)}*\n\n` +
      `Al ponerte al día, el servicio se reactivará. Aquí tienes el QR de pago: 👇`
    );
  }

  // ─── Comprobante ──────────────────────────────────────────
  receiptReceived(name: string): string {
    return (
      `✅ ¡Gracias ${name}! Recibimos tu comprobante.\n\n` +
      `🔍 Nuestro equipo lo verificará a la brevedad y recibirás una confirmación por aquí.\n\n` +
      `⏱️ El tiempo de verificación es de *1 a 2 horas hábiles*.`
    );
  }

  receiptReceivedUnknown(): string {
    return (
      `✅ Recibimos tu comprobante.\n\n` +
      `🔍 No pudimos identificar tu número en nuestro sistema. ` +
      `Nuestro equipo lo revisará y se pondrá en contacto contigo.`
    );
  }

  receiptReceivedWithOcr(
    name: string,
    amount: number | null,
    bank: string | null,
    date: string | null,
  ): string {
    const lines: string[] = [
      `✅ ¡Gracias ${name}! Recibimos tu comprobante.`,
      ``,
      `📋 *Datos detectados automáticamente:*`,
    ];
    if (amount) lines.push(`💵 Monto: *Bs. ${amount.toFixed(2)}*`);
    if (bank)   lines.push(`🏦 Banco / Billetera: *${bank}*`);
    if (date)   lines.push(`📅 Fecha: *${date}*`);
    if (!amount && !bank && !date) {
      lines.push(`⚠️ No pudimos leer los datos del comprobante automáticamente.`);
    }
    lines.push(``);
    lines.push(`🔍 Nuestro equipo lo verificará. Tiempo estimado: *1 a 2 horas hábiles*.`);
    return lines.join(`\n`);
  }

  ragSupportGuide(answer: string): string {
    return (
      `💡 *Antes de crear un ticket, prueba estos pasos:*\n\n` +
      `${answer}\n\n` +
      `¿El problema se resolvió con estos pasos? Responde *Sí* o *No*.`
    );
  }

  ragNoSolution(): string {
    return (
      `🔧 No encontré una guía de solución para tu problema.\n\n` +
      `Voy a crear un ticket de soporte ahora.`
    );
  }

  // ─── Soporte técnico ──────────────────────────────────────
  ticketCreated(name: string, ticketId: string, priority: string): string {
    const icon = priority === 'Alta' ? '🚨' : '🔧';
    return (
      `${icon} *Ticket de soporte creado — ${name}*\n\n` +
      `📋 N° de ticket: *${ticketId.substring(0, 8).toUpperCase()}*\n` +
      `⚡ Prioridad: *${priority}*\n\n` +
      `Nuestro equipo técnico fue notificado y atenderá tu caso.\n\n` +
      `¿Puedes darme más detalles? Por ejemplo:\n` +
      `• ¿Qué luces ves en tu router?\n` +
      `• ¿Desde cuándo ocurre el problema?\n` +
      `• ¿Otros dispositivos también están afectados?`
    );
  }

  ticketUpdated(): string {
    return `📝 Anotado. Esa información fue agregada a tu ticket.`;
  }

  ticketClosed(ticketId: string): string {
    return (
      `✅ ¡Perfecto! Tu ticket *${ticketId.substring(0, 8).toUpperCase()}* fue cerrado como resuelto.\n\n` +
      `Si el problema vuelve a ocurrir, escríbenos y abrimos un nuevo ticket.`
    );
  }

  confirmCloseTicket(ticketId: string): string {
    return (
      `¿Confirmas que el problema se resolvió y deseas cerrar el ticket *${ticketId.substring(0, 8).toUpperCase()}*?\n\n` +
      `Responde *Sí* para cerrar o *No* si el problema persiste.`
    );
  }

  // ─── Instalación ──────────────────────────────────────────
  slotsAvailable(slots: SlotDto[]): string {
    if (slots.length === 0) {
      return (
        `😔 Por el momento no hay horarios disponibles para los próximos días.\n\n` +
        `Escríbenos en unos días o comunícate con nuestro equipo.`
      );
    }

    const days = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
    const grouped: Record<string, SlotDto[]> = {};

    for (const slot of slots) {
      // Usar T12:00:00 (mediodía) para evitar que el offset UTC-4 cambie el día
      const date = new Date(slot.Fecha + 'T12:00:00');
      const label = `${days[date.getDay()]} ${slot.Fecha}`;
      if (!grouped[label]) grouped[label] = [];
      grouped[label].push(slot);
    }

    const lines: string[] = ['📅 *Horarios disponibles para tu instalación:*\n'];
    Object.entries(grouped).forEach(([day, daySlots]) => {
      lines.push(`*${day}*`);
      daySlots.forEach((s) => lines.push(`  • ${s.HoraInicio} hs`));
    });

    lines.push('\nResponde con el día y horario que prefieres. Ejemplo: *Lunes 09:00*');
    return lines.join('\n');
  }

  askInstallationAddress(): string {
    return `🏠 Para completar el agendamiento, ¿cuál es la *dirección exacta* donde se realizará la instalación?`;
  }

  installationConfirmed(fecha: string, hora: string, direccion: string): string {
    return (
      `✅ *¡Instalación agendada!*\n\n` +
      `📅 Fecha: *${fecha}*\n` +
      `🕐 Hora: *${hora} hs*\n` +
      `📍 Dirección: *${direccion}*\n\n` +
      `Nuestro técnico llegará en el horario indicado. ` +
      `Asegúrate de que haya alguien presente para recibir al equipo.\n\n` +
      `¿Necesitas algo más?`
    );
  }

  installationCancelled(): string {
    return (
      `✅ Tu instalación fue cancelada correctamente.\n\n` +
      `¿Deseas *reagendar* para otro horario disponible?`
    );
  }

  confirmCancelInstallation(): string {
    return (
      `¿Confirmas que deseas *cancelar* tu instalación agendada?\n\n` +
      `Responde *Sí* para confirmar o *No* para mantenerla.`
    );
  }

  slotNoLongerAvailable(): string {
    return `⚠️ Ese horario ya no está disponible. Te muestro las opciones actuales:`;
  }

  // ─── Periodo de pago (US-04) ──────────────────────────────

  paymentPeriodInfo(dayOfMonth: number): string {
    const statusMsg = this.buildPaymentPeriodStatus(dayOfMonth);
    return (
      `📅 *Información del periodo de pago — Telecom Bolivianet*\n\n` +
      `• Las facturas del mes se generan el *día 1*\n` +
      `• La fecha límite de pago es el *día 5* de cada mes\n` +
      `• A partir del *día 6*, las facturas pasan a estado *Vencida*\n` +
      `• El *día 7*, el sistema envía un recordatorio automático por WhatsApp\n\n` +
      `${statusMsg}\n\n` +
      `¿Deseas consultar tu deuda actual o recibir el QR de pago?`
    );
  }

  paymentPeriodWithDebt(
    name: string,
    pendingInvoices: InvoiceDto[],
    dayOfMonth: number,
  ): string {
    const statusMsg = this.buildPaymentPeriodStatus(dayOfMonth);

    if (pendingInvoices.length === 0) {
      return (
        `📅 *Información de pago — ${name}*\n\n` +
        `✅ Estás al día. No tienes facturas pendientes.\n\n` +
        `${statusMsg}\n\n` +
        `• Fecha límite mensual: *día 5*\n` +
        `• Las facturas del mes siguiente se generan el *día 1*`
      );
    }

    const months = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
      'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
    const total = pendingInvoices.reduce((s, i) => s + i.Amount, 0);
    const hasOverdue = pendingInvoices.some((i) => i.Status === 'Vencida');

    const lines = pendingInvoices.map((inv) => {
      const label = `${months[inv.Month - 1]} ${inv.Year}`;
      const statusTag = inv.Status === 'Vencida' ? ' ⚠️ *VENCIDA*' : '';
      return `  • ${label}: *Bs. ${inv.Amount.toFixed(2)}*${statusTag}`;
    });

    return (
      `📅 *Periodo de pago — ${name}*\n\n` +
      `${statusMsg}\n\n` +
      `📋 *Facturas pendientes:*\n${lines.join('\n')}\n\n` +
      `💰 *Total: Bs. ${total.toFixed(2)}*\n` +
      `📌 Fecha límite: *día 5 de cada mes*\n` +
      (hasOverdue ? `⚠️ Tienes facturas *vencidas*. Te recomendamos pagar a la brevedad.\n\n` : '\n') +
      `¿Deseas recibir el *QR de pago*? Responde *Sí* para obtenerlo.`
    );
  }

  private buildPaymentPeriodStatus(dayOfMonth: number): string {
    if (dayOfMonth <= 5) {
      const daysLeft = 5 - dayOfMonth;
      return daysLeft === 0
        ? `⚠️ *Hoy es el último día* para pagar sin mora.`
        : `🟢 Estás dentro del periodo de pago. Quedan *${daysLeft} día(s)* para pagar sin mora.`;
    } else if (dayOfMonth === 6) {
      return `🔴 *Hoy las facturas pasan a estado Vencida.* Te recomendamos pagar cuanto antes.`;
    } else if (dayOfMonth === 7) {
      return `🔴 Las facturas están *vencidas*. Hoy el sistema enviará un recordatorio automático.`;
    } else {
      return `🔴 El periodo de pago venció el día 5. Las facturas están en estado *Vencida*.`;
    }
  }

  // ─── Planes ───────────────────────────────────────────────
  plansList(plans: PlanDto[]): string {
    const lines = ['📡 *Nuestros planes disponibles:*\n'];
    plans.forEach((p) => {
      lines.push(
        `*${p.Name}*\n` +
        `  ↓ Descarga: ${p.DownloadSpeedMbps} Mbps\n` +
        `  ↑ Subida: ${p.UploadSpeedMbps} Mbps\n` +
        `  💵 Precio: Bs. ${p.PriceMonthly}/mes\n`,
      );
    });
    lines.push('¿Te interesa alguno? Puedo ayudarte a agendar la instalación. 😊');
    return lines.join('\n');
  }

  // ─── Escalado ─────────────────────────────────────────────
  escalationNotice(): string {
    return (
      `Lo siento, no pude resolver tu consulta de forma automática. 😔\n\n` +
      `Te estoy transfiriendo con un *agente humano* que te atenderá a la brevedad.\n\n` +
      `Por favor espera un momento. 🙏`
    );
  }

  agentTookOver(agentName: string): string {
    return `👤 *${agentName}* se ha unido a la conversación para ayudarte.`;
  }

  botResumed(): string {
    return (
      `Nuestro agente terminó de atenderte. Si necesitas algo más, ` +
      `puedes escribirme y te ayudo. 😊`
    );
  }

  // ─── Fallback / menú ──────────────────────────────────────
  fallbackMenu(): string {
    return (
      `No entendí bien tu consulta. 🤔 Puedo ayudarte con:\n\n` +
      `1️⃣ Consultar deuda\n` +
      `2️⃣ Pagar con QR\n` +
      `3️⃣ Reportar problema técnico\n` +
      `4️⃣ Agendar instalación\n` +
      `5️⃣ Información de planes\n` +
      `6️⃣ Hablar con un agente\n\n` +
      `Escribe el número o describe tu consulta.`
    );
  }

  suspended(name: string): string {
    return (
      `⚠️ *${name}*, tu servicio está *suspendido*.\n\n` +
      `Para reactivarlo, realiza el pago de tu deuda y envíanos el comprobante.\n\n` +
      `¿Deseas recibir el QR de pago?`
    );
  }
}
