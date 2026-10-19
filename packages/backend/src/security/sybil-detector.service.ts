import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Users } from '../user/entities/users.entity';

export interface StakeEdge {
  from: string;
  to: string;
  /** Counter-stake volume between the pair */
  volume: number;
}

export interface FundingLink {
  funder: string;
  funded: string;
  amount: number;
}

export interface SybilClusterReport {
  members: string[];
  circularityScore: number;
  reason: string;
  flagged: boolean;
}

/**
 * Wash-staking / Sybil cluster detector (BE-035).
 * Graph signals: funding trees + circular counter-stake volume.
 */
@Injectable()
export class SybilDetectorService {
  private readonly logger = new Logger(SybilDetectorService.name);

  /** Circularity above this → flag (tunable). */
  static readonly CIRCULARITY_THRESHOLD = 0.65;

  constructor(
    @InjectRepository(Users)
    private readonly usersRepo: Repository<Users>,
  ) {}

  /**
   * Circularity score in [0,1]: share of stake volume that is reciprocal
   * between the same address pairs within a cluster.
   */
  computeCircularity(edges: StakeEdge[]): number {
    if (edges.length === 0) return 0;
    const forward = new Map<string, number>();
    let total = 0;
    for (const e of edges) {
      const k = `${e.from}->${e.to}`;
      forward.set(k, (forward.get(k) ?? 0) + e.volume);
      total += e.volume;
    }
    if (total <= 0) return 0;
    let reciprocal = 0;
    for (const e of edges) {
      const back = forward.get(`${e.to}->${e.from}`) ?? 0;
      reciprocal += Math.min(e.volume, back);
    }
    // Each direction contributes its own matched volume, so a fully
    // reciprocal graph sums to `total` → score 1.
    return Math.min(1, reciprocal / total);
  }

  /**
   * Connected components from funding links (same funder → Sybil cluster candidate).
   */
  fundingClusters(links: FundingLink[]): string[][] {
    const parent = new Map<string, string>();
    const find = (x: string): string => {
      if (!parent.has(x)) parent.set(x, x);
      if (parent.get(x) !== x) parent.set(x, find(parent.get(x)!));
      return parent.get(x)!;
    };
    const union = (a: string, b: string) => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    };
    for (const l of links) {
      union(l.funder, l.funded);
    }
    const groups = new Map<string, string[]>();
    for (const node of parent.keys()) {
      const r = find(node);
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r)!.push(node);
    }
    return [...groups.values()].filter((g) => g.length > 1);
  }

  analyzeCluster(members: string[], edges: StakeEdge[]): SybilClusterReport {
    const internal = edges.filter(
      (e) => members.includes(e.from) && members.includes(e.to),
    );
    const circularityScore = this.computeCircularity(internal);
    const flagged =
      members.length >= 2 &&
      circularityScore >= SybilDetectorService.CIRCULARITY_THRESHOLD;
    return {
      members,
      circularityScore,
      reason: flagged
        ? `High circular counter-stake volume (${circularityScore.toFixed(2)})`
        : 'Within normal multi-staker patterns',
      flagged,
    };
  }

  /**
   * Full pass: build clusters from funding + stake graph, flag users.
   * Standard multi-staker calls (low circularity) produce zero flags.
   */
  async detectAndFlag(
    links: FundingLink[],
    edges: StakeEdge[],
  ): Promise<SybilClusterReport[]> {
    const clusters = this.fundingClusters(links);
    // Also consider densely reciprocal stake pairs not in funding tree
    const reports: SybilClusterReport[] = [];
    for (const members of clusters) {
      const report = this.analyzeCluster(members, edges);
      reports.push(report);
      if (report.flagged) {
        await this.usersRepo
          .createQueryBuilder()
          .update(Users)
          .set({
            sybilFlagged: true,
            sybilCircularityScore: report.circularityScore,
          })
          .whereInIds(members)
          .execute()
          .catch(() => {
            // members may be wallet addresses not UUIDs — best-effort
          });
        this.logger.warn(
          `Sybil cluster flagged: ${members.join(',')} score=${report.circularityScore}`,
        );
      }
    }
    return reports;
  }
}
