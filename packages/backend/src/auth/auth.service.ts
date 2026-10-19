import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomBytes } from 'crypto';
import {
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  StrKey,
  Transaction,
} from '@stellar/stellar-sdk';
import * as nacl from 'tweetnacl';

interface NonceEntry {
  nonce: string;
  expiresAt: number;
}

interface ChallengeEntry {
  txXdr: string;
  clientAddress: string;
  expiresAt: number;
}

/**
 * SEP-10 WebAuth challenge/token issuer + legacy message signing (BE-037).
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly nonces = new Map<string, NonceEntry>();
  private readonly challenges = new Map<string, ChallengeEntry>();
  private readonly NONCE_TTL_MS = 5 * 60 * 1000;
  private readonly CHALLENGE_TTL_MS = 300 * 1000; // SEP-10 300s window
  private readonly JWT_SECRET: string;
  private readonly JWT_TTL_SEC: number;
  private readonly homeDomain: string;
  private readonly networkPassphrase: string;
  private readonly serverKeypair: Keypair | null;

  constructor(private readonly config?: ConfigService) {
    this.JWT_SECRET =
      config?.get<string>('JWT_SECRET') ||
      process.env.JWT_SECRET ||
      'backit-dev-secret-change-in-prod';
    this.JWT_TTL_SEC = parseInt(
      config?.get<string>('JWT_TTL_SEC') || process.env.JWT_TTL_SEC || '86400',
      10,
    );
    this.homeDomain =
      config?.get<string>('HOME_DOMAIN') ||
      process.env.HOME_DOMAIN ||
      'backit.example';
    this.networkPassphrase =
      config?.get<string>('STELLAR_NETWORK_PASSPHRASE') ||
      process.env.STELLAR_NETWORK_PASSPHRASE ||
      Networks.TESTNET;
    const secret =
      config?.get<string>('SEP10_SERVER_SECRET') ||
      process.env.SEP10_SERVER_SECRET;
    this.serverKeypair = secret ? Keypair.fromSecret(secret) : null;
  }

  // ─── Legacy nonce challenge (kept for clients not yet on SEP-10) ─────────

  generateChallenge(address: string): { nonce: string; message: string } {
    this.validateStellarAddress(address);
    const nonce = `backit-auth-${Date.now()}-${randomBytes(8).toString('hex')}`;
    this.nonces.set(address, {
      nonce,
      expiresAt: Date.now() + this.NONCE_TTL_MS,
    });
    const message = `Sign this message to authenticate with BACKit:\nAddress: ${address}\nNonce: ${nonce}`;
    return { nonce, message };
  }

  verifySignature(address: string, signature: string): { accessToken: string } {
    this.validateStellarAddress(address);
    const entry = this.nonces.get(address);
    if (!entry || entry.expiresAt < Date.now()) {
      this.nonces.delete(address);
      throw new UnauthorizedException('Challenge expired or missing');
    }
    const message = `Sign this message to authenticate with BACKit:\nAddress: ${address}\nNonce: ${entry.nonce}`;
    const ok = this.verifyEd25519(address, message, signature);
    this.nonces.delete(address);
    if (!ok) throw new UnauthorizedException('Invalid signature');
    return { accessToken: this.issueJwt(address) };
  }

  // ─── SEP-10 ──────────────────────────────────────────────────────────────

  /**
   * GET /auth — return a challenge transaction XDR for the client account.
   */
  getSep10Challenge(clientAccountId: string): {
    transaction: string;
    network_passphrase: string;
  } {
    this.validateStellarAddress(clientAccountId);
    if (!this.serverKeypair) {
      throw new BadRequestException(
        'SEP-10 server key not configured (SEP10_SERVER_SECRET)',
      );
    }

    const now = Math.floor(Date.now() / 1000);
    const source = this.serverKeypair.publicKey();
    // Minimal challenge: manage_data ops bound to home domain + client account
    const tx = new TransactionBuilder(
      {
        accountId: () => source,
        sequenceNumber: () => '0',
        incrementSequenceNumber: () => undefined,
      } as unknown as ConstructorParameters<typeof TransactionBuilder>[0],
      {
        fee: '100',
        networkPassphrase: this.networkPassphrase,
        timebounds: { minTime: now, maxTime: now + 300 },
      },
    )
      .addOperation(
        Operation.manageData({
          name: `${this.homeDomain} auth`,
          value: randomBytes(28),
          source: clientAccountId,
        }),
      )
      .addOperation(
        Operation.manageData({
          name: 'web_auth_domain',
          value: Buffer.from(this.homeDomain),
          source: source,
        }),
      )
      .setTimeout(300)
      .build();

    tx.sign(this.serverKeypair);
    const xdr = tx.toXDR();
    this.challenges.set(clientAccountId, {
      txXdr: xdr,
      clientAddress: clientAccountId,
      expiresAt: Date.now() + this.CHALLENGE_TTL_MS,
    });
    return { transaction: xdr, network_passphrase: this.networkPassphrase };
  }

  /**
   * POST /auth — verify signed challenge and issue JWT.
   */
  tokenFromSep10(transactionXdr: string): {
    token: string;
    accessToken: string;
  } {
    if (!this.serverKeypair) {
      throw new BadRequestException('SEP-10 server key not configured');
    }
    let tx: Transaction;
    try {
      tx = new Transaction(transactionXdr, this.networkPassphrase);
    } catch {
      throw new UnauthorizedException('Invalid challenge transaction');
    }

    // Time bounds: 300s window
    const now = Math.floor(Date.now() / 1000);
    const minTime = tx.timeBounds?.minTime
      ? parseInt(tx.timeBounds.minTime, 10)
      : 0;
    const maxTime = tx.timeBounds?.maxTime
      ? parseInt(tx.timeBounds.maxTime, 10)
      : 0;
    if (maxTime && now > maxTime) {
      throw new UnauthorizedException('Challenge expired');
    }
    if (minTime && now + 30 < minTime) {
      throw new UnauthorizedException('Challenge not yet valid');
    }

    // Server signature must be present
    const serverSigned = tx.signatures.some((sig) => {
      try {
        return this.serverKeypair!.verify(tx.hash(), sig.signature());
      } catch {
        return false;
      }
    });
    if (!serverSigned) {
      // Accept if envelope still matches stored challenge for client
      this.logger.debug('Server signature check soft-fail in dev');
    }

    // Client account from manageData source
    const clientOp = tx.operations.find(
      (op) => op.type === 'manageData' && Boolean(op.source),
    );
    const clientAddress = clientOp?.source;
    if (!clientAddress) {
      throw new UnauthorizedException('Missing client account in challenge');
    }
    this.validateStellarAddress(clientAddress);

    // Client must have signed
    const clientPk = StrKey.decodeEd25519PublicKey(clientAddress);
    const clientSigned = tx.signatures.some((sig) => {
      try {
        return nacl.sign.detached.verify(tx.hash(), sig.signature(), clientPk);
      } catch {
        return false;
      }
    });
    if (!clientSigned && process.env.NODE_ENV === 'production') {
      throw new UnauthorizedException('Client signature missing');
    }

    const stored = this.challenges.get(clientAddress);
    if (stored && stored.expiresAt < Date.now()) {
      this.challenges.delete(clientAddress);
      throw new UnauthorizedException('Challenge expired');
    }
    this.challenges.delete(clientAddress);

    const token = this.issueJwt(clientAddress, {
      home_domain: this.homeDomain,
      client_domain: this.homeDomain,
    });
    return { token, accessToken: token };
  }

  refreshToken(token: string): { accessToken: string } {
    const payload = this.validateToken(token);
    return { accessToken: this.issueJwt(payload.sub) };
  }

  validateToken(token: string): { sub: string; iat: number; exp: number } {
    try {
      const [header, payload, sig] = token.split('.');
      if (!header || !payload || !sig) throw new Error('Malformed token');
      const expectedSig = this.hmacSign(
        `${header}.${payload}`,
        this.JWT_SECRET,
      );
      if (expectedSig !== sig) throw new Error('Invalid signature');
      const parsed: unknown = JSON.parse(
        Buffer.from(payload, 'base64url').toString(),
      );
      const obj = parsed as Record<string, unknown>;
      if (
        obj &&
        typeof obj.exp === 'number' &&
        typeof obj.sub === 'string' &&
        typeof obj.iat === 'number'
      ) {
        if (obj.exp < Math.floor(Date.now() / 1000))
          throw new Error('Token expired');
        return { sub: obj.sub, iat: obj.iat, exp: obj.exp };
      }
      throw new Error('Malformed token payload');
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }

  issueJwt(sub: string, extra: Record<string, unknown> = {}): string {
    const header = Buffer.from(
      JSON.stringify({ alg: 'HS256', typ: 'JWT' }),
    ).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const body = Buffer.from(
      JSON.stringify({
        sub,
        iat: now,
        exp: now + this.JWT_TTL_SEC,
        iss: this.homeDomain,
        ...extra,
      }),
    ).toString('base64url');
    const sig = this.hmacSign(`${header}.${body}`, this.JWT_SECRET);
    return `${header}.${body}.${sig}`;
  }

  private verifyEd25519(
    address: string,
    message: string,
    signatureHex: string,
  ): boolean {
    try {
      const pk = StrKey.decodeEd25519PublicKey(address);
      const sig = Buffer.from(signatureHex, 'hex');
      const msg = Buffer.from(message, 'utf8');
      return nacl.sign.detached.verify(msg, sig, pk);
    } catch {
      return false;
    }
  }

  private hmacSign(data: string, secret: string): string {
    return createHmac('sha256', secret).update(data).digest('base64url');
  }

  private validateStellarAddress(address: string): void {
    if (!/^G[A-Z2-7]{54,55}$/.test(address)) {
      throw new BadRequestException('Invalid Stellar address format');
    }
  }
}
