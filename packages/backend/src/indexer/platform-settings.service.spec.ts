/* eslint-disable
  @typescript-eslint/require-await,
  @typescript-eslint/no-unsafe-assignment,
  @typescript-eslint/no-unsafe-member-access,
  @typescript-eslint/no-unsafe-return,
  @typescript-eslint/no-unsafe-call,
  @typescript-eslint/no-unsafe-argument,
  @typescript-eslint/no-misused-promises
  -- test doubles, mocked async functions and raw SQL rows are intentionally loosely typed */
import { PlatformSettingsService } from './platform-settings.service';
import { EventType } from './event-log.entity';

describe('PlatformSettingsService leader gating', () => {
  let leader: boolean;
  let indexer: {
    getLatestLedger: jest.Mock;
    fetchContractEvents: jest.Mock;
    updatePlatformSettings: jest.Mock;
  };
  let parser: { parseEvent: jest.Mock };
  let repo: { findOne: jest.Mock; create: jest.Mock; save: jest.Mock };
  let checkpoints: { get: jest.Mock; advance: jest.Mock };
  let service: PlatformSettingsService;

  const adminEvent = (ledger: number) => ({
    id: `e${ledger}`,
    ledger,
    pagingToken: `p${ledger}`,
  });

  beforeEach(() => {
    process.env.STELLAR_CONTRACT_ID = 'CTEST';
    leader = true;
    indexer = {
      getLatestLedger: jest.fn(async () => ({ sequence: 200 })),
      fetchContractEvents: jest.fn(async () => ({ events: [] })),
      updatePlatformSettings: jest.fn(async () => undefined),
    };
    parser = {
      parseEvent: jest.fn((e: { ledger: number }) => ({
        eventType: EventType.ADMIN_PARAMS_CHANGED,
        contractId: 'CTEST',
        ledger: e.ledger,
        txHash: 'h',
        txOrder: 0,
        timestamp: new Date(),
        eventData: { paramName: 'fee', newValue: '1' },
      })),
    };
    repo = {
      findOne: jest.fn(async () => null),
      create: jest.fn((x: unknown) => x),
      save: jest.fn(async (x: unknown) => x),
    };
    checkpoints = {
      get: jest.fn(async () => null),
      advance: jest.fn(async () => 0),
    };
    service = new PlatformSettingsService(
      indexer as never,
      parser as never,
      repo as never,
      { isLeader: () => leader, nodeId: 'n1' } as never,
      checkpoints as never,
    );
  });

  it('a standby never talks to the RPC or the database', async () => {
    leader = false;
    await service.syncPlatformSettings();
    expect(indexer.getLatestLedger).not.toHaveBeenCalled();
    expect(indexer.fetchContractEvents).not.toHaveBeenCalled();
    expect(repo.save).not.toHaveBeenCalled();
    expect(checkpoints.advance).not.toHaveBeenCalled();
  });

  it('resumes from the furthest of the stored event and the checkpoint', async () => {
    repo.findOne.mockResolvedValue({ ledger: 120 });
    checkpoints.get.mockResolvedValue(150);
    await service.onModuleInit();
    await service.syncPlatformSettings();
    expect(indexer.fetchContractEvents).toHaveBeenCalledWith('CTEST', 151);
  });

  it('reloads its resume point after a leadership change (takeover)', async () => {
    await service.onModuleInit(); // loaded 0 as the node started
    leader = false;
    await service.syncPlatformSettings(); // loses leadership
    // meanwhile the other node advanced the shared checkpoint
    checkpoints.get.mockResolvedValue(180);
    leader = true;
    await service.syncPlatformSettings();
    expect(indexer.fetchContractEvents).toHaveBeenCalledWith('CTEST', 181);
  });

  it('records the checkpoint after processing', async () => {
    indexer.fetchContractEvents.mockResolvedValue({
      events: [adminEvent(190)],
    });
    await service.syncPlatformSettings();
    expect(indexer.updatePlatformSettings).toHaveBeenCalledTimes(1);
    expect(checkpoints.advance).toHaveBeenCalledWith(
      'platform-settings',
      200,
      'n1',
    );
  });

  it('stops mid-batch when the lease lapses and does not checkpoint', async () => {
    indexer.fetchContractEvents.mockResolvedValue({
      events: [adminEvent(190), adminEvent(191), adminEvent(192)],
    });
    indexer.updatePlatformSettings.mockImplementation(async () => {
      leader = false; // lease lapses after the first event
    });
    await service.syncPlatformSettings();
    expect(indexer.updatePlatformSettings).toHaveBeenCalledTimes(1);
    expect(checkpoints.advance).not.toHaveBeenCalled();
  });
});
