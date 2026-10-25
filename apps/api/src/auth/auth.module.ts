import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './jwt.strategy';
import { TwoFactorService } from './two-factor.service';
import { GoogleAuthService } from './google-auth.service';
import { AuditModule } from '../audit/audit.module';
import { AccountRecoveryService } from './account-recovery.service';
import { EmailVerifiedGuard } from './email-verified.guard';

@Module({
  imports: [
    PassportModule,
    AuditModule,
    JwtModule.registerAsync({
      useFactory: () => {
        const secret = process.env.JWT_SECRET;
        if (!secret || secret.length < 32) {
          throw new Error('FATAL: JWT_SECRET must be configured with at least 32 characters');
        }
        return {
          secret,
          signOptions: { expiresIn: '10m', algorithm: 'HS256' }, // short-lived access token
          // Pinned: every verify() through this JwtService accepts HS256 only (no alg confusion / "none")
          verifyOptions: { algorithms: ['HS256'] }
        };
      }
    })
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy, TwoFactorService, GoogleAuthService, AccountRecoveryService, EmailVerifiedGuard],
  exports: [AuthService, TwoFactorService, JwtModule, AccountRecoveryService, EmailVerifiedGuard]
})
export class AuthModule {}
