import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { HealthController } from './health.controller';
import { ShutdownService } from './shutdown.service';
import { IndexerCoordinationModule } from '../indexer/indexer-coordination.module';

@Module({
  imports: [
    HttpModule, // provides HttpService for Stellar RPC ping
    IndexerCoordinationModule, // lease + checkpoint status for /health/indexer
  ],
  controllers: [HealthController],
  providers: [ShutdownService],
  exports: [ShutdownService],
  // DataSource is provided globally by TypeOrmModule.forRoot() in AppModule
  // so it can be injected directly — no extra registration needed here
})
export class HealthModule {}
