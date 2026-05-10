import { Inject, Injectable, Logger } from '@nestjs/common';
import { IClientRepository, CLIENT_REPOSITORY } from '../../client/sistema-api.interfaces';
import { SessionService, SessionData } from '../../session/session.service';
import { AgentTool } from './agent-tool.interface';

const MONTHS = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
];

@Injectable()
export class GetClientDebtTool implements AgentTool {
  private readonly logger = new Logger(GetClientDebtTool.name);

  constructor(
    @Inject(CLIENT_REPOSITORY) private readonly clientRepo: IClientRepository,
    private readonly sessionService: SessionService,
  ) {}

  getName(): string { return 'get_client_debt'; }
  requiresIdentification(): boolean { return true; }

  getDeclaration(): object {
    return {
      name: this.getName(),
      description:
        'Consulta las facturas pendientes del cliente. ' +
        'Usar cuando pregunte por deuda, cuánto debe, facturas, o períodos pendientes.',
      parameters: { type: 'OBJECT', properties: {}, required: [] },
    };
  }

  async execute(_args: Record<string, unknown>, session: SessionData): Promise<unknown> {
    try {
      const currentYear = new Date().getFullYear();

      const [currentInvoices, prevInvoices] = await Promise.all([
        this.clientRepo.getClientInvoices(session.clientId!, currentYear),
        this.clientRepo.getClientInvoices(session.clientId!, currentYear - 1),
      ]);

      const seen = new Set<string>();
      const allInvoices = [...prevInvoices, ...currentInvoices].filter((inv) => {
        const key = `${inv.Year}-${inv.Month}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      const invoices = allInvoices
        .filter((i) => i.Status === 'Pendiente' || i.Status === 'Vencida')
        .sort((a, b) => a.Year !== b.Year ? a.Year - b.Year : a.Month - b.Month);

      if (invoices.length === 0) {
        await this.sessionService.updateSession(session.phoneNumber, { totalDebt: 0 });
        return {
          hasPendingDebt: false,
          totalDebt: 0,
          message: 'El cliente está al día — no tiene facturas pendientes.',
        };
      }

      const total = invoices.reduce((sum, inv) => sum + inv.Amount, 0);
      await this.sessionService.updateSession(session.phoneNumber, { totalDebt: total });

      const detail = invoices.map((inv) => ({
        period:  `${MONTHS[Math.max(0, Math.min(11, inv.Month - 1))]} ${inv.Year}`,
        amount:  inv.Amount,
        status:  inv.Status,
        dueDate: inv.DueDate,
      }));

      return {
        hasPendingDebt: true,
        totalDebt:      total,
        pendingCount:   invoices.length,
        invoices:       detail,
      };
    } catch (err: any) {
      this.logger.error(`GetClientDebtTool error: ${err.message}`);
      return { error: `No se pudo consultar la deuda: ${err.message}` };
    }
  }
}
