/**
 * Small date/increment primitives used by the MongoDB adapter.
 *
 * Keeping a small Timestamp/FieldValue API means the business logic (pricing,
 * referrals, commissions, chat, dispatch) stays independent of the storage
 * driver and continues to run on MongoDB.
 */
export class Timestamp {
  constructor(seconds, nanoseconds = 0) {
    this._seconds = Number(seconds) || 0;
    this._nanoseconds = Number(nanoseconds) || 0;
  }

  toDate() {
    return new Date(this._seconds * 1000 + Math.floor(this._nanoseconds / 1_000_000));
  }

  toMillis() {
    return this._seconds * 1000 + Math.floor(this._nanoseconds / 1_000_000);
  }

  isEqual(other) {
    return (
      other instanceof Timestamp &&
      other._seconds === this._seconds &&
      other._nanoseconds === this._nanoseconds
    );
  }

  valueOf() {
    return this.toMillis();
  }

  toJSON() {
    return { _seconds: this._seconds, _nanoseconds: this._nanoseconds };
  }

  static now() {
    return Timestamp.fromDate(new Date());
  }

  static fromDate(date) {
    const millis = date instanceof Date ? date.getTime() : new Date(date).getTime();
    const safe = Number.isFinite(millis) ? millis : 0;
    return new Timestamp(Math.floor(safe / 1000), (safe % 1000) * 1_000_000);
  }

  static fromMillis(millis) {
    return Timestamp.fromDate(new Date(millis));
  }
}

const sentinel = (op, extra = {}) => ({ __easyhomeOp: op, ...extra });

export const FieldValue = Object.freeze({
  serverTimestamp: () => sentinel("serverTimestamp"),
  increment: (value) => sentinel("increment", { value: Number(value) || 0 }),
  delete: () => sentinel("delete"),
  arrayUnion: (...items) => sentinel("arrayUnion", { items }),
  arrayRemove: (...items) => sentinel("arrayRemove", { items }),
});

export function isFieldValue(value) {
  return Boolean(value && typeof value === "object" && value.__easyhomeOp);
}

export function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !(value instanceof Date) &&
    !(value instanceof Timestamp) &&
    !isFieldValue(value)
  );
}
