import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from './prisma.service';

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);
  constructor(private readonly prisma: PrismaService) {}

  async log(userId: string | null, action: string, target?: string | null, ip?: string | null, data?: Prisma.InputJsonValue) {
    try {
      await this.prisma.auditLog.create({ data: { userId, action, target: target ?? null, ip: ip ?? null, data } });
    } catch (err) {
      this.logger.warn(`No se pudo registrar auditoría ${action}: ${(err as Error).message}`);
    }
  }
}
