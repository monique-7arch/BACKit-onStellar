import { Injectable, Logger } from '@nestjs/common';

export interface Dispute {
  id: string;
  claimId: string;
  challenger: string;
  defendant: string;
  reason: string;
  status: 'pending' | 'resolved' | 'rejected';
  createdAt: number;
  resolvedAt?: number;
  resolution?: string;
}

@Injectable()
export class DisputeResolutionService {
  private readonly logger = new Logger(DisputeResolutionService.name);
  private disputes: Map<string, Dispute> = new Map();

  createDispute(
    dispute: Omit<Dispute, 'id' | 'createdAt' | 'status'>,
  ): Dispute {
    const id = `dispute_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const newDispute: Dispute = {
      ...dispute,
      id,
      status: 'pending',
      createdAt: Date.now(),
    };
    this.disputes.set(id, newDispute);
    this.logger.log(`Created dispute ${id} for claim ${dispute.claimId}`);
    return newDispute;
  }

  resolveDispute(id: string, resolution: string): Dispute | null {
    const dispute = this.disputes.get(id);
    if (!dispute) return null;
    if (dispute.status !== 'pending') return dispute;
    dispute.status = 'resolved';
    dispute.resolvedAt = Date.now();
    dispute.resolution = resolution;
    this.disputes.set(id, dispute);
    this.logger.log(`Resolved dispute ${id}`);
    return dispute;
  }

  rejectDispute(id: string, reason: string): Dispute | null {
    const dispute = this.disputes.get(id);
    if (!dispute) return null;
    if (dispute.status !== 'pending') return dispute;
    dispute.status = 'rejected';
    dispute.resolvedAt = Date.now();
    dispute.resolution = reason;
    this.disputes.set(id, dispute);
    this.logger.log(`Rejected dispute ${id}`);
    return dispute;
  }

  getDispute(id: string): Dispute | null {
    return this.disputes.get(id) || null;
  }

  getAllDisputes(): Dispute[] {
    return Array.from(this.disputes.values());
  }
}
