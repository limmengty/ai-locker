import { LockerError } from '../../util/errors.js';

/** Decode the base64 payload shared by providers whose snapshot is one opaque blob. */
export function decodeBase64Field(value: unknown, opts: { label: string; maxBytes: number }): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new LockerError(`${opts.label} profile does not contain a valid credential blob.`, 'E_FORMAT');
  }
  const data = Buffer.from(value, 'base64');
  if (data.length === 0 || data.length > opts.maxBytes) {
    throw new LockerError(`${opts.label} profile credential has an invalid size.`, 'E_FORMAT');
  }
  return data;
}
