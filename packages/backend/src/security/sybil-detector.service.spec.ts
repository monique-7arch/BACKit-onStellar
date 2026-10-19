import { SybilDetectorService } from './sybil-detector.service';

describe('SybilDetectorService (BE-035)', () => {
  const svc = new SybilDetectorService(
    {} as ConstructorParameters<typeof SybilDetectorService>[0],
  );

  it('scores zero circularity on one-way stakes', () => {
    const edges = [
      { from: 'A', to: 'B', volume: 100 },
      { from: 'A', to: 'C', volume: 50 },
    ];
    expect(svc.computeCircularity(edges)).toBe(0);
  });

  it('detects wash ring circularity', () => {
    const edges = [
      { from: 'A', to: 'B', volume: 100 },
      { from: 'B', to: 'A', volume: 100 },
      { from: 'B', to: 'C', volume: 80 },
      { from: 'C', to: 'B', volume: 80 },
    ];
    const score = svc.computeCircularity(edges);
    expect(score).toBeGreaterThan(0.5);
    const report = svc.analyzeCluster(['A', 'B', 'C'], edges);
    expect(report.flagged).toBe(true);
  });

  it('does not flag standard multi-staker (low circularity)', () => {
    const edges = [
      { from: 'A', to: 'CALL1', volume: 100 },
      { from: 'B', to: 'CALL1', volume: 120 },
      { from: 'C', to: 'CALL1', volume: 90 },
    ];
    const report = svc.analyzeCluster(['A', 'B', 'C'], edges);
    expect(report.flagged).toBe(false);
  });

  it('groups funding clusters', () => {
    const links = [
      { funder: 'F', funded: 'S1', amount: 10 },
      { funder: 'F', funded: 'S2', amount: 10 },
      { funder: 'X', funded: 'Y', amount: 5 },
    ];
    const clusters = svc.fundingClusters(links);
    const withF = clusters.find((c) => c.includes('F'));
    expect(withF?.length).toBeGreaterThanOrEqual(3);
  });
});
