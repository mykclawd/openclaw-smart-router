import type { FastifyReply } from 'fastify';

export class OpenAIError extends Error {
  statusCode: number;
  code: string | null;
  type: string;
  param: string | null;

  constructor(message: string, statusCode = 500, type = 'server_error', code: string | null = null, param: string | null = null) {
    super(message);
    this.name = 'OpenAIError';
    this.statusCode = statusCode;
    this.type = type;
    this.code = code;
    this.param = param;
  }
}

export function openAIErrorBody(error: OpenAIError | Error, fallbackStatus = 500) {
  if (error instanceof OpenAIError) {
    return {
      statusCode: error.statusCode,
      body: {
        error: {
          message: error.message,
          type: error.type,
          param: error.param,
          code: error.code,
        },
      },
    };
  }
  return {
    statusCode: fallbackStatus,
    body: {
      error: {
        message: error.message || 'Internal server error',
        type: 'server_error',
        param: null,
        code: null,
      },
    },
  };
}

export function sendOpenAIError(reply: FastifyReply, error: OpenAIError | Error, fallbackStatus = 500) {
  const shaped = openAIErrorBody(error, fallbackStatus);
  return reply.status(shaped.statusCode).send(shaped.body);
}
