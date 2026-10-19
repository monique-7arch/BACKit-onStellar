import { Injectable, Logger } from '@nestjs/common';

export interface ReconciliationRecord {
  id: string;
  source: string;
  target: string;
  amount: number;
  status: 'pending' | 'matched' | 'mismatched' | 'resolved';
  discrepancy?: number;
  notes?: string;
  createdAt: number;
  resolvedAt?: number;
}

@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);
  private records: Map<string, ReconciliationRecord> = new Map();

  createRecord(
    source: string,
    target: string,
    amount: number,
  ): ReconciliationRecord {
    const id = `rec_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const record: ReconciliationRecord = {
      id,
      source,
      target,
      amount,
      status: 'pending',
      createdAt: Date.now(),
    };
    this.records.set(id, record);
    this.logger.log(`Created reconciliation record ${id}`);
    return record;
  }

  reconcile(id: string, targetAmount: number): ReconciliationRecord | null {
    const record = this.records.get(id);
    if (!record) return null;
    const discrepancy = Math.abs(targetAmount - record.amount);
    record.discrepancy = discrepancy;
    record.status = discrepancy === 0 ? 'matched' : 'mismatched';
    this.records.set(id, record);
    this.logger.log(
      `Reconciled ${id}: status=${record.status}, discrepancy=${discrepancy}`,
    );
    return record;
  }

  resolve(id: string, notes?: string): ReconciliationRecord | null {
    const record = this.records.get(id);
    if (!record) return null;
    record.status = 'resolved';
    record.resolvedAt = Date.now();
    if (notes) record.notes = notes;
    this.records.set(id, record);
    return record;
  }

  getRecord(id: string): ReconciliationRecord | null {
    return this.records.get(id) || null;
  }

  getAllRecords(): ReconciliationRecord[] {
    return Array.from(this.records.values());
  }
}
