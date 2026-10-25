import { collections, db } from "../config/firebase.js";

/**
 * End a support session by deleting the thread and every message in it.
 *
 * Chat is intentionally ephemeral: neither customers nor admins should retain
 * a transcript after either side clicks "End chat". The next message starts a
 * fresh session.
 */
export async function endChatSession(uid) {
  const threadRef = collections.chatThreads.doc(uid);
  let deleted = 0;

  while (true) {
    const snap = await threadRef.collection("messages").limit(400).get();
    if (snap.empty) break;
    const batch = db.batch();
    snap.forEach((message) => batch.delete(message.ref));
    await batch.commit();
    deleted += snap.size;
    if (snap.size < 400) break;
  }

  await threadRef.delete().catch(() => {});
  return deleted;
}
