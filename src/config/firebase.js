import { randomBytes } from "node:crypto";
import mongoose from "mongoose";
import { collectionNameFor, connectDb, getModel } from "./db.js";
import {
  FieldValue,
  Timestamp,
  isFieldValue,
  isPlainObject,
} from "../lib/firestore.js";

const INTERNAL_KEYS = new Set(["_id", "_parentId", "__v"]);

function toDateValue(value) {
  if (value instanceof Timestamp) return value.toDate();
  if (value instanceof Date) return value;
  return value;
}

function toMongo(value) {
  if (value instanceof Timestamp) return value.toDate();
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(toMongo);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, toMongo(item)]),
    );
  }
  return value;
}

function fromMongo(value) {
  if (value instanceof Date) return Timestamp.fromDate(value);
  if (Array.isArray(value)) return value.map(fromMongo);
  if (value && typeof value === "object") {
    if (value._bsontype === "ObjectId") return value.toHexString();
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, fromMongo(item)]),
    );
  }
  return value;
}

function materialize(value) {
  if (isFieldValue(value)) {
    if (value.__easyhomeOp === "serverTimestamp") return new Date();
    if (value.__easyhomeOp === "increment") return Number(value.value) || 0;
    if (value.__easyhomeOp === "delete") return undefined;
    if (value.__easyhomeOp === "arrayUnion") return value.items.map(toMongo);
    if (value.__easyhomeOp === "arrayRemove") return [];
  }
  if (Array.isArray(value)) return value.map(materialize);
  if (isPlainObject(value)) {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      const next = materialize(item);
      if (next !== undefined) out[key] = next;
    }
    return out;
  }
  return toMongo(value);
}

function removeUndefined(value) {
  if (Array.isArray(value)) return value.map(removeUndefined);
  if (isPlainObject(value)) {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) out[key] = removeUndefined(item);
    }
    return out;
  }
  return value;
}

function mergeIntoTarget(target, incoming) {
  const out = { ...target };
  for (const [key, rawValue] of Object.entries(incoming)) {
    if (rawValue === undefined) continue;
    if (isFieldValue(rawValue)) {
      if (rawValue.__easyhomeOp === "delete") {
        delete out[key];
        continue;
      }
      if (rawValue.__easyhomeOp === "serverTimestamp") {
        out[key] = new Date();
        continue;
      }
      if (rawValue.__easyhomeOp === "increment") {
        out[key] = (Number(out[key]) || 0) + (Number(rawValue.value) || 0);
        continue;
      }
      if (rawValue.__easyhomeOp === "arrayUnion") {
        const current = Array.isArray(out[key]) ? out[key] : [];
        const next = [...current];
        for (const item of rawValue.items) {
          const normalized = toMongo(item);
          if (!next.some((entry) => JSON.stringify(entry) === JSON.stringify(normalized))) {
            next.push(normalized);
          }
        }
        out[key] = next;
        continue;
      }
      if (rawValue.__easyhomeOp === "arrayRemove") {
        const current = Array.isArray(out[key]) ? out[key] : [];
        out[key] = current.filter(
          (entry) =>
            !rawValue.items.some(
              (item) => JSON.stringify(entry) === JSON.stringify(toMongo(item)),
            ),
        );
        continue;
      }
    }

    if (isPlainObject(rawValue)) {
      const current = isPlainObject(out[key]) ? out[key] : {};
      out[key] = mergeIntoTarget(current, rawValue);
      continue;
    }

    out[key] = toMongo(rawValue);
  }
  return out;
}

function documentId() {
  return randomBytes(10).toString("hex");
}

function buildUpdatePayload(data) {
  const set = {};
  const inc = {};
  const unset = {};
  const addToSet = {};
  const pull = {};

  for (const [key, rawValue] of Object.entries(data)) {
    if (rawValue === undefined) continue;
    if (isFieldValue(rawValue)) {
      switch (rawValue.__easyhomeOp) {
        case "serverTimestamp":
          set[key] = new Date();
          break;
        case "increment":
          inc[key] = Number(rawValue.value) || 0;
          break;
        case "delete":
          unset[key] = "";
          break;
        case "arrayUnion":
          addToSet[key] = { $each: rawValue.items.map(toMongo) };
          break;
        case "arrayRemove":
          pull[key] = { $in: rawValue.items.map(toMongo) };
          break;
        default:
          break;
      }
      continue;
    }
    set[key] = toMongo(rawValue);
  }

  const update = {};
  if (Object.keys(set).length) update.$set = set;
  if (Object.keys(inc).length) update.$inc = inc;
  if (Object.keys(unset).length) update.$unset = unset;
  if (Object.keys(addToSet).length) update.$addToSet = addToSet;
  if (Object.keys(pull).length) update.$pull = pull;
  return update;
}

class DocumentSnapshot {
  constructor(ref, raw) {
    this.ref = ref;
    this.id = ref.id;
    this._raw = raw || null;
    this.exists = Boolean(raw);
  }

  data() {
    if (!this._raw) return undefined;
    const out = {};
    for (const [key, value] of Object.entries(this._raw)) {
      if (INTERNAL_KEYS.has(key)) continue;
      out[key] = fromMongo(value);
    }
    return out;
  }

  get(field) {
    return this.data()?.[field];
  }
}

class QuerySnapshot {
  constructor(docs) {
    this.docs = docs;
    this.size = docs.length;
    this.empty = docs.length === 0;
    this.metadata = { fromCache: false, hasPendingWrites: false };
  }

  forEach(callback) {
    this.docs.forEach(callback);
  }
}

class AggregateSnapshot {
  constructor(count) {
    this._count = count;
  }

  data() {
    return { count: this._count };
  }
}

class DocumentReference {
  constructor(collection, id, parentId = null) {
    this._collection = collection;
    this.id = id;
    this._parentId = parentId;
    this._parentPath = collection.parent ? collection.parent.path : null;
  }

  get ref() {
    return this;
  }

  get path() {
    return this._parentPath
      ? `${this._parentPath}/${this._collection.name}/${this.id}`
      : `${this._collection.name}/${this.id}`;
  }

  collection(name) {
    return new CollectionReference(
      collectionNameFor(this._collection.name, name),
      this,
    );
  }

  _filter() {
    const filter = { _id: this.id };
    if (this._parentId) filter._parentId = this._parentId;
    return filter;
  }

  async _get({ session } = {}) {
    const model = getModel(this._collection.name);
    let query = model.findOne(this._filter()).lean();
    if (session) query = query.session(session);
    const raw = await query.exec();
    return new DocumentSnapshot(this, raw);
  }

  async get() {
    await connectDb();
    return this._get();
  }

  async set(data, options = {}) {
    await connectDb();
    return this._set(data, options);
  }

  async _set(data, { merge = false, session } = {}) {
    const model = getModel(this._collection.name);
    const payload = removeUndefined(materialize(data || {}));
    let doc;

    if (merge) {
      let current = {};
      try {
        let query = model.findOne(this._filter()).lean();
        if (session) query = query.session(session);
        current = (await query.exec()) || {};
      } catch {
        current = {};
      }
      doc = mergeIntoTarget(current, data || {});
      doc = removeUndefined(materialize(doc));
    } else {
      doc = payload;
    }

    doc._id = this.id;
    if (this._parentId) doc._parentId = this._parentId;

    await model.replaceOne(this._filter(), doc, {
      upsert: true,
      session: session || undefined,
    });
    return this;
  }

  async update(data) {
    await connectDb();
    return this._update(data);
  }

  async _update(data, { session } = {}) {
    const update = buildUpdatePayload(data || {});
    if (!Object.keys(update).length) return this;
    const model = getModel(this._collection.name);
    await model.updateOne(this._filter(), update, {
      session: session || undefined,
    });
    return this;
  }

  async delete() {
    await connectDb();
    return this._delete();
  }

  async _delete({ session } = {}) {
    const model = getModel(this._collection.name);
    await model.deleteOne(this._filter(), { session: session || undefined });
    return this;
  }
}

class Query {
  constructor(collection, options = {}) {
    this._collection = collection;
    this._filters = options.filters ? [...options.filters] : [];
    this._orders = options.orders ? [...options.orders] : [];
    this._limit = options.limit ?? null;
    this._cursor = options.cursor ? [...options.cursor] : [];
  }

  _clone(patch) {
    return new Query(this._collection, {
      filters: this._filters,
      orders: this._orders,
      limit: this._limit,
      cursor: this._cursor,
      ...patch,
    });
  }

  where(field, op, value) {
    return this._clone({
      filters: [...this._filters, { field, op, value }],
    });
  }

  orderBy(field, direction = "asc") {
    return this._clone({
      orders: [...this._orders, { field, direction }],
    });
  }

  limit(count) {
    return this._clone({ limit: count });
  }

  startAfter(...values) {
    return this._clone({ cursor: values });
  }

  startAt(...values) {
    return this._clone({ cursor: values });
  }

  endBefore(...values) {
    return this._clone({ cursor: values });
  }

  endAt(...values) {
    return this._clone({ cursor: values });
  }

  _mongoFilter() {
    const conditions = [];
    if (this._collection._parentId) {
      conditions.push({ _parentId: this._collection._parentId });
    }

    for (const filter of this._filters) {
      const field = filter.field === "id" ? "_id" : filter.field;
      const value = toDateValue(filter.value);
      switch (filter.op) {
        case "==":
          conditions.push({ [field]: value });
          break;
        case "!=":
          conditions.push({ [field]: { $ne: value } });
          break;
        case ">":
          conditions.push({ [field]: { $gt: value } });
          break;
        case ">=":
          conditions.push({ [field]: { $gte: value } });
          break;
        case "<":
          conditions.push({ [field]: { $lt: value } });
          break;
        case "<=":
          conditions.push({ [field]: { $lte: value } });
          break;
        case "in":
          conditions.push({ [field]: { $in: (value || []).map(toDateValue) } });
          break;
        case "not-in":
          conditions.push({ [field]: { $nin: (value || []).map(toDateValue) } });
          break;
        case "array-contains":
          conditions.push({ [field]: value });
          break;
        case "array-contains-any":
          conditions.push({ [field]: { $in: (value || []).map(toDateValue) } });
          break;
        default:
          break;
      }
    }

    if (this._cursor.length && this._orders.length) {
      const { field, direction } = this._orders[0];
      const value = toDateValue(this._cursor[0]);
      conditions.push({
        [field]: { [direction === "desc" ? "$lt" : "$gt"]: value },
      });
    }

    if (!conditions.length) return {};
    if (conditions.length === 1) return conditions[0];
    return { $and: conditions };
  }

  _mongoSort() {
    const sort = {};
    for (const order of this._orders) {
      const field = order.field === "id" ? "_id" : order.field;
      sort[field] = order.direction === "desc" ? -1 : 1;
    }
    return sort;
  }

  async get() {
    await connectDb();
    return this._get();
  }

  async _get({ session } = {}) {
    const model = getModel(this._collection.name);
    let query = model.find(this._mongoFilter()).lean();
    const sort = this._mongoSort();
    if (Object.keys(sort).length) query = query.sort(sort);
    if (this._limit !== null) query = query.limit(this._limit);
    if (session) query = query.session(session);
    const rows = await query.exec();
    const docs = rows.map(
      (row) =>
        new DocumentSnapshot(
          this._collection.doc(String(row._id)),
          row,
        ),
    );
    return new QuerySnapshot(docs);
  }

  count() {
    return new AggregateQuery(this);
  }
}

class AggregateQuery {
  constructor(query) {
    this._query = query;
  }

  async get() {
    await connectDb();
    const model = getModel(this._query._collection.name);
    const count = await model.countDocuments(this._query._mongoFilter());
    return new AggregateSnapshot(count);
  }
}

class CollectionReference extends Query {
  constructor(name, parent = null, parentId = null) {
    super(null);
    this.name = name;
    this.parent = parent;
    this._parentId = parentId || (parent ? parent.id : null);
    this._collection = this;
  }

  doc(id) {
    return new DocumentReference(this, id || documentId(), this._parentId);
  }

  async add(data) {
    const ref = this.doc();
    await ref.set(data);
    return ref;
  }

  where(field, op, value) {
    return new Query(this, {
      filters: this._filters,
      orders: this._orders,
      limit: this._limit,
      cursor: this._cursor,
    }).where(field, op, value);
  }

  orderBy(field, direction = "asc") {
    return new Query(this, {
      filters: this._filters,
      orders: this._orders,
      limit: this._limit,
      cursor: this._cursor,
    }).orderBy(field, direction);
  }

  limit(count) {
    return new Query(this, {
      filters: this._filters,
      orders: this._orders,
      limit: this._limit,
      cursor: this._cursor,
    }).limit(count);
  }

  startAfter(...values) {
    return new Query(this, {
      filters: this._filters,
      orders: this._orders,
      limit: this._limit,
      cursor: this._cursor,
    }).startAfter(...values);
  }
}

class WriteBatch {
  constructor() {
    this._operations = [];
  }

  set(ref, data, options = {}) {
    this._operations.push({ type: "set", ref, data, options });
    return this;
  }

  update(ref, data) {
    this._operations.push({ type: "update", ref, data });
    return this;
  }

  delete(ref) {
    this._operations.push({ type: "delete", ref });
    return this;
  }

  async commit() {
    await connectDb();
    for (const operation of this._operations) {
      if (operation.type === "set") {
        await operation.ref._set(operation.data, operation.options);
      } else if (operation.type === "update") {
        await operation.ref._update(operation.data);
      } else if (operation.type === "delete") {
        await operation.ref._delete();
      }
    }
    this._operations = [];
    return this;
  }
}

class Transaction {
  constructor(session) {
    this._session = session;
  }

  async get(ref) {
    return ref._get({ session: this._session });
  }

  set(ref, data, options = {}) {
    return ref._set(data, { ...options, session: this._session });
  }

  update(ref, data) {
    return ref._update(data, { session: this._session });
  }

  delete(ref) {
    return ref._delete({ session: this._session });
  }
}

export const db = {
  collection(name) {
    return new CollectionReference(name);
  },

  batch() {
    return new WriteBatch();
  },

  async runTransaction(handler) {
    await connectDb();
    const session = await mongoose.startSession();
    let result;
    try {
      await session.withTransaction(async () => {
        result = await handler(new Transaction(session));
      });
      return result;
    } finally {
      await session.endSession();
    }
  },
};

export const collections = {
  users: db.collection("users"),
  workers: db.collection("workers"),
  workersPublic: db.collection("workersPublic"),
  bookings: db.collection("bookings"),
  jobFeed: db.collection("jobFeed"),
  urgentPublic: db.collection("urgentPublic"),
  notifications: db.collection("notifications"),
  reviews: db.collection("reviews"),
  services: db.collection("services"),
  cities: db.collection("cities"),
  serviceZones: db.collection("service_zones"),
  serviceWaitlist: db.collection("service_waitlist"),
  promos: db.collection("promos"),
  footerLinks: db.collection("footer_links"),
  subscriptions: db.collection("subscriptions"),
  commissions: db.collection("commissions"),
  payments: db.collection("payments"),
  chatThreads: db.collection("chatThreads"),
  callRequests: db.collection("callRequests"),
  referrals: db.collection("referrals"),
  admins: db.collection("admins"),
  settings: db.collection("settings"),
  audit: db.collection("audit"),
};

export { Timestamp, FieldValue };
