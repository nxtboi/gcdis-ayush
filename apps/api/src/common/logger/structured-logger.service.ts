import { Injectable, LoggerService, Scope } from '@nestjs/common';

export interface StructuredLogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  context: string;
  message: string;
  requestId?: string;
  actorId?: string;
  ipAddress?: string;
  metadata?: Record<string, any>;
  alertType?: string;
}

@Injectable({ scope: Scope.TRANSIENT })
export class StructuredLoggerService implements LoggerService {
  private context: string = 'GCDIS';

  setContext(context: string) {
    this.context = context;
  }

  log(message: any, context?: string, meta?: Record<string, any>) {
    this.emit('info', message, context, meta);
  }

  error(message: any, trace?: string, context?: string, meta?: Record<string, any>) {
    this.emit('error', message, context, { ...meta, trace });
  }

  warn(message: any, context?: string, meta?: Record<string, any>) {
    this.emit('warn', message, context, meta);
  }

  debug(message: any, context?: string, meta?: Record<string, any>) {
    this.emit('debug', message, context, meta);
  }

  /**
   * Alert trigger for failed payment transactions
   */
  alertFailedPayment(data: {
    orderId: string;
    paymentId?: string;
    amount?: number;
    reason: string;
    actorId?: string;
    ipAddress?: string;
  }) {
    this.emit('error', `[ALERT_PAYMENT_FAILURE] Payment transaction failed: ${data.reason}`, 'PaymentsService', {
      alertType: 'PAYMENT_FAILURE_ALERT',
      orderId: data.orderId,
      paymentId: data.paymentId,
      amount: data.amount,
      reason: data.reason,
      actorId: data.actorId,
      ipAddress: data.ipAddress
    });
  }

  /**
   * Alert trigger for repeated failed logins / brute force attempts
   */
  alertFailedLogin(data: {
    email: string;
    ipAddress: string;
    failedAttempts: number;
    reason: string;
  }) {
    this.emit('warn', `[ALERT_FAILED_LOGIN] Authentication failure threshold exceeded for ${data.email}`, 'AuthService', {
      alertType: 'FAILED_LOGIN_ALERT',
      email: data.email,
      ipAddress: data.ipAddress,
      failedAttempts: data.failedAttempts,
      reason: data.reason
    });
  }

  private emit(
    level: 'info' | 'warn' | 'error' | 'debug',
    message: any,
    context?: string,
    meta?: Record<string, any>
  ) {
    const entry: StructuredLogEntry = {
      timestamp: new Date().toISOString(),
      level,
      context: context || this.context,
      message: typeof message === 'string' ? message : JSON.stringify(message),
      ...meta
    };

    const serialized = JSON.stringify(entry);

    if (level === 'error') {
      console.error(serialized);
    } else if (level === 'warn') {
      console.warn(serialized);
    } else {
      console.log(serialized);
    }
  }
}
