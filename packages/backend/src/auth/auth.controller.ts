import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  HttpCode,
  HttpStatus,
  Headers,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { IsString, IsNotEmpty } from 'class-validator';
import { IsStellarAddress } from '../common/validators/stellar-address.validator';
import { AuthService } from './auth.service';

class ChallengeDto {
  @IsStellarAddress()
  address: string;
}

class VerifyDto {
  @IsStellarAddress()
  address: string;

  @IsString()
  @IsNotEmpty()
  signature: string;
}

class Sep10TokenDto {
  @IsString()
  @IsNotEmpty()
  transaction: string;
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // ── Legacy message-signing flow ──────────────────────────────────────────

  @Post('challenge')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Legacy nonce challenge for message signing' })
  challenge(@Body() dto: ChallengeDto) {
    return this.authService.generateChallenge(dto.address);
  }

  @Post('verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify ed25519 message signature and return JWT' })
  verify(@Body() dto: VerifyDto) {
    return this.authService.verifySignature(dto.address, dto.signature);
  }

  // ── SEP-10 (BE-037) ──────────────────────────────────────────────────────

  @Get()
  @ApiOperation({
    summary: 'SEP-10: GET challenge transaction',
    description:
      'Returns a Stellar challenge transaction (XDR) for the client account.',
  })
  @ApiResponse({
    status: 200,
    description: 'Challenge transaction + network passphrase',
  })
  sep10Challenge(@Query('account') account: string) {
    return this.authService.getSep10Challenge(account);
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'SEP-10: exchange signed challenge for JWT' })
  sep10Token(@Body() dto: Sep10TokenDto) {
    return this.authService.tokenFromSep10(dto.transaction);
  }

  @Post('token')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'SEP-10: POST /auth/token alias' })
  sep10TokenAlias(@Body() dto: Sep10TokenDto) {
    return this.authService.tokenFromSep10(dto.transaction);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rotate JWT (SEP-10 session refresh)' })
  refresh(
    @Headers('authorization') authorization?: string,
    @Body('token') bodyToken?: string,
  ) {
    const token =
      bodyToken ||
      (authorization?.startsWith('Bearer ')
        ? authorization.slice(7)
        : undefined);
    if (!token) {
      return this.authService.refreshToken('');
    }
    return this.authService.refreshToken(token);
  }
}
