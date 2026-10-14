/** An error whose message is safe and useful to show the user verbatim. */
export class LockerError extends Error {
  constructor(
    message: string,
    readonly code: string = 'E_LOCKER',
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'LockerError';
  }
}

export function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}
