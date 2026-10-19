import { Injectable, Logger } from '@nestjs/common';

export interface RelayerTransaction {
  id: string;
  to: string;
  method: string;
  args: any[];
  status: 'pending' | 'submitted' | 'confirmed' | 'failed';
  txHash?: string;
  error?: string;
  submittedAt?: number;
  confirmedAt?: number;
}

@Injectable()
export class SorobanRelayerService {
  private readonly logger = new Logger(SorobanRelayerService.name);
  private transactions: Map<string, RelayerTransaction> = new Map();

  relayTransaction(
    to: string,
    method: string,
    args: any[],
  ): Promise<RelayerTransaction> {
    const id = `tx_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const tx: RelayerTransaction = {
      id,
      to,
      method,
      args,
      status: 'pending',
      submittedAt: Date.now(),
    };
    this.transactions.set(id, tx);
    this.logger.log(`Relaying transaction ${id} to ${to}.${method}`);
    // Simulate submission
    setTimeout(() => {
      tx.status = 'submitted';
      tx.txHash = `0x${Math.random().toString(16).substr(2, 9)}`;
    }, 0);
    return Promise.resolve(tx);
  }

  waitForConfirmation(id: string): Promise<RelayerTransaction | null> {
    const tx = this.transactions.get(id);
    if (!tx) return Promise.resolve(null);
    if (tx.status === 'submitted' || tx.status === 'pending') {
      tx.status = 'confirmed';
      tx.confirmedAt = Date.now();
      this.transactions.set(id, tx);
      this.logger.log(`Confirmed transaction ${id}`);
    }
    return Promise.resolve(tx);
  }

  getTransaction(id: string): RelayerTransaction | null {
    return this.transactions.get(id) || null;
  }

  getAllTransactions(): RelayerTransaction[] {
    return Array.from(this.transactions.values());
  }
}
