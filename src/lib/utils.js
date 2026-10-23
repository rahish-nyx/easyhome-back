/**
 * Convert Firestore documents/Timestamps into JSON-safe values for API responses.
 */
export function serialize(value) {
  if (value === null || value === undefined) return value;

  if (typeof value?.toDate === "function") {
    return value.toDate().toISOString();
  }

  if (Array.isArray(value)) {
    return value.map(serialize);
  }

  if (typeof value === "object") {
    if (typeof value._seconds === "number" && typeof value._nanoseconds === "number") {
      return new Date(value._seconds * 1000).toISOString();
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, serialize(item)]),
    );
  }

  return value;
}

export function docToJson(snap) {
  if (!snap || !snap.exists) return null;
  return { id: snap.id, ...serialize(snap.data()) };
}

export function docsToJson(snapshot) {
  return snapshot.docs.map((doc) => docToJson(doc));
}

export function toDate(value) {
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate();
  if (value instanceof Date) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length > 10 ? digits.slice(-10) : digits;
}

export function isValidPhone(value) {
  return /^[6-9]\d{9}$/.test(normalizePhone(value));
}

export function pagination(req, { defaultLimit = 20, maxLimit = 100 } = {}) {
  const limit = Math.min(
    Math.max(Number(req.query.limit) || defaultLimit, 1),
    maxLimit,
  );
  const cursor = req.query.cursor ? String(req.query.cursor) : null;
  return { limit, cursor };
}

export function assert(condition, status, message, code) {
  if (!condition) {
    const error = new Error(message);
    error.status = status;
    error.code = code || "REQUEST_ERROR";
    throw error;
  }
}

export function roundMoney(value) {
  return Math.max(0, Math.round(Number(value) || 0));
}

export function monthKey(date) {
  const d = toDate(date);
  if (!d) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function lastMonths(count = 6) {
  const months = [];
  const now = new Date();
  for (let i = count - 1; i >= 0; i -= 1) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({
      key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`,
      label: d.toLocaleString("en-IN", { month: "short" }),
      amount: 0,
    });
  }
  return months;
}
