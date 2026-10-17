export class AppError extends Error {
  /** @param {number} status @param {string} code @param {string} message */
  constructor(status, code, message) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
  }
}

/** @param {unknown} error */
export function publicError(error) {
  if (error instanceof AppError) {
    return {
      status: error.status,
      body: { error: { code: error.code, message: error.message } },
    };
  }
  return {
    status: 500,
    body: {
      error: {
        code: "INTERNAL_ERROR",
        message: "The request could not be completed.",
      },
    },
  };
}

export const invalidPage = () =>
  new AppError(
    502,
    "UPSTREAM_INVALID_PAGE",
    "The upstream page did not contain valid expected results.",
  );
export const databaseUnavailable = () =>
  new AppError(
    503,
    "DATABASE_UNAVAILABLE",
    "The local database is unavailable.",
  );
