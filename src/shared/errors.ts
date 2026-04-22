export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number = 400,
  ) {
    super(message)
    this.name = 'AppError'
  }
}

export const Errors = {
  NOT_FOUND: (resource: string) =>
    new AppError('NOT_FOUND', `${resource} not found`, 404),
  UNAUTHORIZED: () =>
    new AppError('UNAUTHORIZED', 'Authentication required', 401),
  FORBIDDEN: () =>
    new AppError('FORBIDDEN', 'You do not have permission to perform this action', 403),
  CONFLICT: (message: string) =>
    new AppError('CONFLICT', message, 409),
  VALIDATION: (message: string) =>
    new AppError('VALIDATION_ERROR', message, 422),
  INTERNAL: () =>
    new AppError('INTERNAL_ERROR', 'An unexpected error occurred', 500),
  PLAN_LIMIT: (limit: string) =>
    new AppError('PLAN_LIMIT_EXCEEDED', `Your plan limit for ${limit} has been reached`, 403),
  FEATURE_GATED: (feature: string) =>
    new AppError('FEATURE_NOT_AVAILABLE', `The ${feature} feature is not available on your current plan`, 403),
}
