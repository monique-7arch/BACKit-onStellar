import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Users } from '../user/entities/users.entity';
import { SybilDetectorService } from './sybil-detector.service';

@Module({
  imports: [TypeOrmModule.forFeature([Users])],
  providers: [SybilDetectorService],
  exports: [SybilDetectorService],
})
export class SecurityModule {}
