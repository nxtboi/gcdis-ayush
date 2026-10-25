import {
  accessTokenFromCookies,
  cookiesToClear,
  refreshTokenFromCookies,
  sessionAppFor
} from '../apps/api/src/auth/session-cookies.util';

const bothCookies = {
  gcdis_access_token: 'public-access',
  gcdis_refresh_token: 'public-refresh',
  gcdis_admin_access_token: 'admin-access',
  gcdis_admin_refresh_token: 'admin-refresh'
};

function req(headers: Record<string, string>, cookies: Record<string, string> = bothCookies) {
  return { headers, cookies };
}

describe('Session cookie selection by calling application', () => {
  it('uses the staff cookie for requests from the staff console', () => {
    const r = req({ origin: 'http://localhost:3001' });
    expect(sessionAppFor(r)).toBe('admin');
    expect(accessTokenFromCookies(r)).toBe('admin-access');
    expect(refreshTokenFromCookies(r)).toBe('admin-refresh');
  });

  it('uses the public cookie for requests from the website, even when a staff cookie exists', () => {
    const r = req({ origin: 'http://localhost:3000' });
    expect(sessionAppFor(r)).toBe('public');
    expect(accessTokenFromCookies(r)).toBe('public-access');
    expect(refreshTokenFromCookies(r)).toBe('public-refresh');
  });

  it('never falls back to the other application cookie', () => {
    expect(accessTokenFromCookies(req({ origin: 'http://localhost:3000' }, { gcdis_admin_access_token: 'a' }))).toBeNull();
    expect(accessTokenFromCookies(req({ origin: 'http://localhost:3001' }, { gcdis_access_token: 'p' }))).toBeNull();
  });

  it('falls back to the Referer origin when Origin is absent', () => {
    expect(sessionAppFor(req({ referer: 'http://localhost:3001/some/page' }))).toBe('admin');
  });

  it('keeps the previous behaviour when no browser origin is present', () => {
    const r = req({});
    expect(sessionAppFor(r)).toBe('unknown');
    expect(accessTokenFromCookies(r)).toBe('admin-access');
    expect(cookiesToClear(r)).toHaveLength(4);
  });

  it('treats look-alike origins as unknown', () => {
    expect(sessionAppFor(req({ origin: 'http://localhost:3001.evil.test' }))).toBe('unknown');
  });

  it('signs out only the calling application', () => {
    expect(cookiesToClear(req({ origin: 'http://localhost:3000' }))).toEqual(['gcdis_access_token', 'gcdis_refresh_token']);
    expect(cookiesToClear(req({ origin: 'http://localhost:3001' }))).toEqual([
      'gcdis_admin_access_token',
      'gcdis_admin_refresh_token'
    ]);
  });

  it('does not trust localhost origins in production', () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(sessionAppFor(req({ origin: 'http://localhost:3001' }), { NODE_ENV: 'production' } as any)).toBe('unknown');
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});

import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { AuthService } from '../apps/api/src/auth/auth.service';
import { OptionalSessionGuard } from '../apps/api/src/auth/optional-session.guard';

describe('Refresh token rotation with concurrent tabs', () => {
  function serviceWith(session: any, successor: any) {
    const prisma: any = {
      session: {
        findUnique: jest.fn().mockResolvedValue(session),
        findFirst: jest.fn().mockResolvedValue(successor),
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      }
    };
    return { prisma, svc: new AuthService(prisma, {} as any, {} as any) };
  }

  it('answers 409 without revoking the family when another tab rotated the token moments ago', async () => {
    const { prisma, svc } = serviceWith(
      { id: 's1', familyId: 'f1', revokedAt: new Date(Date.now() - 2000), isActive: false, user: {} },
      { id: 's2' }
    );
    await expect(svc.rotateSession('token')).rejects.toThrow(ConflictException);
    expect(prisma.session.updateMany).not.toHaveBeenCalled();
  });

  it('still treats an old revoked token as a replay and revokes the family', async () => {
    const { prisma, svc } = serviceWith(
      { id: 's1', familyId: 'f1', revokedAt: new Date(Date.now() - 60_000), isActive: false, user: {} },
      { id: 's2' }
    );
    await expect(svc.rotateSession('token')).rejects.toThrow(UnauthorizedException);
    expect(prisma.session.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { familyId: 'f1' } }));
  });

  it('treats reuse of a signed-out token (no successor) as a replay', async () => {
    const { prisma, svc } = serviceWith(
      { id: 's1', familyId: 'f1', revokedAt: new Date(Date.now() - 1000), isActive: false, user: {} },
      null
    );
    await expect(svc.rotateSession('token')).rejects.toThrow(UnauthorizedException);
    expect(prisma.session.updateMany).toHaveBeenCalled();
  });

  it('answers 409 when a simultaneous request revoked the session first', async () => {
    const { prisma, svc } = serviceWith(
      { id: 's1', familyId: 'f1', revokedAt: null, isActive: true, expiresAt: new Date(Date.now() + 60_000), user: {} },
      null
    );
    prisma.session.updateMany.mockResolvedValue({ count: 0 });
    await expect(svc.rotateSession('token')).rejects.toThrow(ConflictException);
  });
});

describe('GET /auth/me optional session guard', () => {
  const ctx = (req: any) => ({ switchToHttp: () => ({ getRequest: () => req }) }) as any;

  it('lets a visitor with no session through with user = null', () => {
    const req: any = { headers: { origin: 'http://localhost:3000' }, cookies: {} };
    expect(new OptionalSessionGuard().canActivate(ctx(req))).toBe(true);
    expect(req.user).toBeNull();
  });

  it('ignores the other application cookie when deciding', () => {
    const req: any = { headers: { origin: 'http://localhost:3000' }, cookies: { gcdis_admin_access_token: 'x' } };
    expect(new OptionalSessionGuard().canActivate(ctx(req))).toBe(true);
    expect(req.user).toBeNull();
  });

  it('validates normally when a refresh cookie is present (so the client can refresh)', async () => {
    const req: any = { headers: { origin: 'http://localhost:3000' }, cookies: { gcdis_refresh_token: 'r' } };
    let result: any;
    try {
      result = await new OptionalSessionGuard().canActivate(ctx(req));
    } catch (err) {
      result = err;
    }
    expect(result).not.toBe(true);
  });
});
