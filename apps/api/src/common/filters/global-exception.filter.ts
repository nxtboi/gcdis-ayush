import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger
} from '@nestjs/common';
import { Request, Response } from 'express';
import * as crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { redactUrl, validClientRequestId } from '../middleware/log-sanitizer';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    // RequestIdMiddleware has normally validated the header already; validate again for requests that
    // failed before it ran (e.g. body-parser errors), never echoing a malformed client value.
    const requestId = validClientRequestId(request.headers['x-request-id']) || crypto.randomUUID();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let errorResponse: any = {
      statusCode: status,
      error: 'Internal Server Error',
      message: 'An unexpected internal server error occurred.'
    };

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();
      if (typeof res === 'string') {
        errorResponse = {
          statusCode: status,
          error: exception.name,
          message: res
        };
      } else if (typeof res === 'object' && res !== null) {
        errorResponse = {
          statusCode: status,
          ...res
        };
      }
    } else if (this.prismaStatus(exception)) {
      // Known Prisma request errors map to client errors instead of opaque 500s
      const mapped = this.prismaStatus(exception)!;
      status = mapped.status;
      errorResponse = { statusCode: status, error: mapped.error, message: mapped.message };
      this.logger.warn(`[${requestId}] Prisma error mapped to ${status}: ${(exception as any)?.code}`);
    } else if (this.isPrismaValidationError(exception)) {
      // Malformed query arguments (e.g. NUL bytes, wrong types) are client errors, never 500s.
      status = HttpStatus.BAD_REQUEST;
      errorResponse = { statusCode: status, error: 'Bad Request', message: 'Invalid request parameters' };
      this.logger.warn(
        `[${requestId}] Prisma validation error mapped to 400`,
        exception instanceof Error ? exception.stack : undefined
      );
    } else if (this.bodyParserStatus(exception)) {
      // body-parser errors (payload too large, malformed JSON) surface as plain errors with type/status
      const mapped = this.bodyParserStatus(exception)!;
      status = mapped.status;
      errorResponse = { statusCode: status, error: mapped.error, message: mapped.message };
    } else {
      // Unhandled / Internal exception: log fully on the server only. The stack is never sent to clients.
      const errorMessage = exception instanceof Error ? exception.message : 'Unknown error';
      const errorStack = exception instanceof Error ? exception.stack : undefined;

      this.logger.error(
        `[${requestId}] Unhandled Exception: ${errorMessage}`,
        errorStack
      );
    }

    // Attach request metadata without leaking sensitive internal details
    // Defence in depth: never echo a stack, whatever shape the upstream response had
    delete errorResponse.stack;
    errorResponse.timestamp = new Date().toISOString();
    // Signed-URL tokens and one-time codes in the query string are never echoed back
    errorResponse.path = redactUrl(request.url);
    errorResponse.requestId = requestId;

    response.status(status).json(errorResponse);
  }

  private isPrismaValidationError(exception: unknown): boolean {
    if (exception instanceof Prisma.PrismaClientValidationError) return true;
    return (exception as any)?.constructor?.name === 'PrismaClientValidationError';
  }

  private bodyParserStatus(exception: unknown): { status: number; error: string; message: string } | null {
    const err = exception as any;
    if (!err || typeof err !== 'object') return null;
    const type = err.type;
    const errStatus = err.status ?? err.statusCode;
    if (type === 'entity.too.large' || errStatus === HttpStatus.PAYLOAD_TOO_LARGE) {
      return {
        status: HttpStatus.PAYLOAD_TOO_LARGE,
        error: 'Payload Too Large',
        message: 'The request body exceeds the maximum allowed size.'
      };
    }
    if (type === 'entity.parse.failed') {
      return { status: HttpStatus.BAD_REQUEST, error: 'Bad Request', message: 'Malformed JSON request body.' };
    }
    if (
      typeof type === 'string' &&
      typeof errStatus === 'number' &&
      errStatus >= 400 &&
      errStatus < 500 &&
      (type.startsWith('entity.') || type.startsWith('request.') || type.startsWith('charset.') || type.startsWith('encoding.') || type === 'parameters.too.many')
    ) {
      return { status: errStatus, error: 'Bad Request', message: 'The request body could not be processed.' };
    }
    return null;
  }

  private prismaStatus(exception: unknown): { status: number; error: string; message: string } | null {
    const code = (exception as any)?.code;
    const name = (exception as any)?.constructor?.name;
    if (typeof code !== 'string' || name !== 'PrismaClientKnownRequestError') return null;
    switch (code) {
      case 'P2025':
        return { status: HttpStatus.NOT_FOUND, error: 'Not Found', message: 'The requested record was not found.' };
      case 'P2002':
        return { status: HttpStatus.CONFLICT, error: 'Conflict', message: 'A record with these unique values already exists.' };
      case 'P2003':
        return { status: HttpStatus.BAD_REQUEST, error: 'Bad Request', message: 'A referenced record does not exist.' };
      default:
        return null;
    }
  }
}
