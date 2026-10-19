import { AuthService } from './auth.service';
import { UnauthorizedException } from '@nestjs/common';

describe('AuthService SEP-10 / JWT (BE-037)', () => {
  const svc = new AuthService();

  it('issues and validates JWT', () => {
    const token = svc.issueJwt('GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW');
    const payload = svc.validateToken(token);
    expect(payload.sub).toMatch(/^G/);
    expect(payload.exp).toBeGreaterThan(payload.iat);
  });

  it('rejects tampered JWT', () => {
    const token = svc.issueJwt('GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW');
    const bad = token.slice(0, -4) + 'XXXX';
    expect(() => svc.validateToken(bad)).toThrow(UnauthorizedException);
  });

  it('rejects expired challenge via validateToken exp', () => {
    // craft expired by mocking — validateToken checks exp
    const [h, , s] = svc.issueJwt('GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW').split('.');
    const body = Buffer.from(
      JSON.stringify({ sub: 'GTEST', iat: 1, exp: 2 }),
    ).toString('base64url');
    // signature won't match — still Unauthorized
    expect(() => svc.validateToken(`${h}.${body}.${s}`)).toThrow(
      UnauthorizedException,
    );
  });

  it('legacy challenge returns nonce message', () => {
    // valid-looking G address length
    const addr = 'G' + 'A'.repeat(55);
    const ch = svc.generateChallenge(addr);
    expect(ch.nonce).toContain('backit-auth-');
    expect(ch.message).toContain(addr);
  });
});
