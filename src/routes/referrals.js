import { Router } from "express";
import { collections } from "../config/firebase.js";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/errors.js";
import { ensureReferralCode } from "../lib/referrals.js";
import { docsToJson } from "../lib/utils.js";

export const referralRouter = Router();

const STATUS_ORDER = {
  pending: 0,
  service_completed: 1,
  approved: 2,
  rejected: 3,
};

referralRouter.get(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    const uid = req.user.uid;
    const code = await ensureReferralCode(uid);
    const [snap, incomingSnap] = await Promise.all([
      collections.referrals.where("referrerId", "==", uid).limit(100).get(),
      collections.referrals.doc(uid).get(),
    ]);

    const referrals = docsToJson(snap).map((item) => ({
      id: item.id,
      referredName: item.referredName || "Your friend",
      status: item.status || "pending",
      serviceCompleted: item.serviceCompleted === true,
      rewardAmount: Number(item.rewardAmount) || 51,
      createdAt: item.createdAt || null,
      serviceCompletedAt: item.serviceCompletedAt || null,
      approvedAt: item.approvedAt || null,
      rejectedAt: item.rejectedAt || null,
    }));

    const stats = referrals.reduce(
      (result, item) => {
        result.total += 1;
        if (item.status === "pending") result.pending += 1;
        if (item.status === "service_completed") result.awaitingVerification += 1;
        if (item.status === "approved") {
          result.approved += 1;
          result.approvedRewards += item.rewardAmount;
        }
        if (item.status === "rejected") result.rejected += 1;
        return result;
      },
      {
        total: 0,
        pending: 0,
        awaitingVerification: 0,
        approved: 0,
        rejected: 0,
        approvedRewards: 0,
      },
    );

    const incoming = incomingSnap.exists
      ? {
          id: incomingSnap.id,
          referrerName: incomingSnap.data().referrerName || "An EasyHome customer",
          status: incomingSnap.data().status || "pending",
          serviceCompleted: incomingSnap.data().serviceCompleted === true,
          rewardAmount: Number(incomingSnap.data().rewardAmount) || 51,
          createdAt: incomingSnap.data().createdAt || null,
          serviceCompletedAt: incomingSnap.data().serviceCompletedAt || null,
          approvedAt: incomingSnap.data().approvedAt || null,
          rejectedAt: incomingSnap.data().rejectedAt || null,
        }
      : null;

    res.set("Cache-Control", "private, no-store");
    res.json({
      code,
      rewardAmount: 51,
      incoming,
      referrals: referrals.sort((a, b) => {
        const byStatus =
          (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9);
        if (byStatus !== 0) return byStatus;
        return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
      }),
      stats,
    });
  }),
);
