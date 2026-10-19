export interface ParlayLeg {
  marketId: string;
  outcome: 'YES' | 'NO';
  odds: number;
  maxStake?: number;
  expiresAt?: number | string;
}

export interface ParlayCalculation {
  legs: ParlayLeg[];
  multiplier: number;
  potentialPayout: number;
  totalStake: number;
  isValid: boolean;
  errors: string[];
}

export function calculateParlay(legs: ParlayLeg[], stake: number): ParlayCalculation {
  if (legs.length < 2) {
    return {
      legs,
      multiplier: 1,
      potentialPayout: stake,
      totalStake: stake,
      isValid: false,
      errors: ['Parlay requires at least 2 legs'],
    };
  }
  if (legs.length > 10) {
    return {
      legs,
      multiplier: 1,
      potentialPayout: stake,
      totalStake: stake,
      isValid: false,
      errors: ['Parlay cannot have more than 10 legs'],
    };
  }

  let multiplier = 1;
  const errors: string[] = [];

  for (const leg of legs) {
    if (leg.odds < 1) {
      errors.push(`Invalid odds for market ${leg.marketId}`);
    }
    multiplier *= leg.odds;
    const now = Date.now();
    if (leg.expiresAt) {
      const exp = typeof leg.expiresAt === 'string' ? new Date(leg.expiresAt).getTime() : leg.expiresAt;
      if (exp < now) {
        errors.push(`Market ${leg.marketId} has expired`);
      }
    }
    if (leg.maxStake && stake > leg.maxStake) {
      errors.push(`Stake exceeds max for market ${leg.marketId}`);
    }
  }

  multiplier = Math.round(multiplier * 10000) / 10000;
  const potentialPayout = Math.round(stake * multiplier * 100) / 100;
  const isValid = errors.length === 0;

  return {
    legs,
    multiplier,
    potentialPayout,
    totalStake: stake,
    isValid,
    errors,
  };
}