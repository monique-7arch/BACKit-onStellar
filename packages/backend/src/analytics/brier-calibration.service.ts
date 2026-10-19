import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Users } from '../user/entities/users.entity';
import {
  binaryBrierScore,
  binaryLogLoss,
  calibrationCurve,
  meanBrier,
  multiOutcomeBrierScore,
} from './brier-score';

export interface ResolvedPrediction {
  userId: string;
  /** Predicted probability of the chosen (or YES) outcome */
  probability: number;
  /** 1 if prediction matched resolution, else 0 */
  outcome: 0 | 1;
  /** Optional multi-outcome vector */
  probabilities?: number[];
  outcomeIndex?: number;
  resolvedAt: Date;
}

/**
 * Computes Brier / log-loss on settlement and maintains a 30-day calibration index
 * on the user record (BE-029).
 */
@Injectable()
export class BrierCalibrationService {
  private readonly logger = new Logger(BrierCalibrationService.name);

  constructor(
    @InjectRepository(Users)
    private readonly usersRepo: Repository<Users>,
  ) {}

  scorePrediction(p: ResolvedPrediction): {
    brier: number;
    logLoss: number;
  } {
    if (p.probabilities && p.outcomeIndex !== undefined) {
      return {
        brier: multiOutcomeBrierScore(p.probabilities, p.outcomeIndex),
        logLoss: binaryLogLoss(p.probability, p.outcome),
      };
    }
    return {
      brier: binaryBrierScore(p.probability, p.outcome),
      logLoss: binaryLogLoss(p.probability, p.outcome),
    };
  }

  /**
   * Recalculate rolling 30-day mean Brier for a user and persist on Users.
   */
  async recalculateUserCalibration(
    userId: string,
    recent: ResolvedPrediction[],
  ): Promise<{ brier30d: number; logLoss30d: number; n: number }> {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const window = recent.filter((r) => r.resolvedAt.getTime() >= cutoff);
    const brierScores = window.map((r) => this.scorePrediction(r).brier);
    const logScores = window.map((r) => this.scorePrediction(r).logLoss);
    const brier30d = meanBrier(brierScores);
    const logLoss30d = meanBrier(logScores);

    await this.usersRepo.update(
      { id: userId },
      {
        brierScore30d: brier30d,
        logLoss30d,
        calibrationSampleSize: window.length,
      },
    );

    this.logger.debug(
      `User ${userId} calibration: brier30d=${brier30d.toFixed(4)} n=${window.length}`,
    );
    return { brier30d, logLoss30d, n: window.length };
  }

  calibrationCurveFor(recent: ResolvedPrediction[], buckets = 10) {
    return calibrationCurve(
      recent.map((r) => ({ probability: r.probability, outcome: r.outcome })),
      buckets,
    );
  }
}
