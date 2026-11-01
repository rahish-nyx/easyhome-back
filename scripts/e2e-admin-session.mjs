import "dotenv/config";
import { randomBytes } from "node:crypto";
import { collections } from "../src/config/store.js";
import { hashPassword } from "../src/lib/auth.js";

const mode = process.argv[2] || "create";

if (mode === "create") {
  const suffix = randomBytes(5).toString("hex");
  const id = `e2e_admin_${suffix}`;
  const email = `${id}@example.invalid`;
  const password = `E2e!${randomBytes(8).toString("hex")}`;
  const now = new Date();
  await collections.users.doc(id).set({
    uid: id,
    role: "admin",
    name: "E2E Admin",
    email,
    emailVerified: true,
    passwordHash: await hashPassword(password),
    createdAt: now,
    updatedAt: now,
  });
  await collections.admins.doc(id).set({
    uid: id,
    email,
    name: "E2E Admin",
    createdAt: now,
    updatedAt: now,
  });
  console.log(JSON.stringify({ id, email, password }));
} else if (mode === "delete") {
  const id = process.argv[3];
  if (!id) throw new Error("missing id");
  await collections.users.doc(id).delete();
  await collections.admins.doc(id).delete();
  const notifications = await collections.notifications.where("userId", "==", id).get();
  for (const doc of notifications.docs) await doc.ref.delete();
  console.log(`deleted ${id}`);
}
process.exit(0);
