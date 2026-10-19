import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export class ListIndexerDlqDto {
  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ default: 0, minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}

export class IndexerDlqPatchDto {
  @ApiPropertyOptional({
    description: 'Replacement topics, base64 XDR ScVal each (at least 2).',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(4)
  @IsString({ each: true })
  topic?: string[];

  @ApiPropertyOptional({ description: 'Replacement data value, base64 XDR.' })
  @IsOptional()
  @IsString()
  value?: string;

  @ApiPropertyOptional({ description: 'Replacement contract id (C...).' })
  @IsOptional()
  @IsString()
  contractId?: string;
}

export class RetryIndexerDlqDto {
  @ApiPropertyOptional({
    description: 'Event ids to re-drive. Mutually exclusive with all.',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  ids?: string[];

  @ApiPropertyOptional({
    description:
      'Re-drive the oldest 500 entries. Mutually exclusive with ids.',
  })
  @IsOptional()
  @IsBoolean()
  all?: boolean;

  @ApiPropertyOptional({
    description: 'Edit the raw event before re-driving. Exactly one id only.',
    type: IndexerDlqPatchDto,
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => IndexerDlqPatchDto)
  patch?: IndexerDlqPatchDto;
}
