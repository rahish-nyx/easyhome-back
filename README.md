# EasyHome API

Express 5 service that owns every EasyHome read and write. The API stores data in MongoDB (Mongoose), authenticates with JWT, applies role checks, runs atomic updates, uploads media, and writes audit/notification records. The frontend never talks to the database directly.

## Stack

- Node.js 22+ (Node 24 LTS recommended)
- Express 5
- MongoDB Atlas + Mongoose
- JWT access/refresh tokens, bcrypt password hashing
- Zod validation, Helmet, CORS, rate limiting, compression, Multer
- Resend for optional transactional email
- Cloudinary for public images and private KYC documents

## Setup

```bash
npm install
cp .env.example .env   # Windows: copy .env.example .env
```

Required environment:

```env
MONGODB_URI=mongodb+srv://...
JWT_SECRET=replace-with-a-long-random-string
```

Optional: `JWT_EXPIRES_IN`, `JWT_REFRESH_DAYS`, `GOOGLE_CLIENT_ID`, Cloudinary keys, Resend, Razorpay and Telegram.

Never commit `.env`. It is gitignored.

### Seed the first admin

```bash
npm run seed
```

The seed writes the service catalogue, cities, sample promos, `settings` and the admin account named by `ADMIN_EMAIL`. Set a unique `ADMIN_PASSWORD` of at least 12 characters in `.env` **before** running it in production; the seed skips the admin account when the password is missing or too short. The seed is idempotent and does not overwrite an existing admin password.

### Link services into folders

```bash
node scripts/linkServices.mjs
```

Creates the 15 customer-facing folders and assigns all 181 services to their folder. It is idempotent and prints per-folder counts. Services are grouped by `backend/src/data/serviceGroups.js`, which mirrors the frontend mapping. Unmapped services fall into `Other` (currently zero).

## Run

```bash
npm run dev     # nodemon on http://localhost:5000
npm start       # production process
npm run check   # syntax-check every source file
```

Health check: `GET /api/public/health` -> `{ ok: true, service: "easyhome-api", database: "mongodb" }`.

### Deploy the API to Vercel

Create a separate Vercel project for this repository and set its Root Directory to `backend`. The `api/index.js` entry exports the Express app as a serverless function, and `vercel.json` routes API requests to it. Set `MONGODB_URI`, `JWT_SECRET`, Cloudinary, CORS, email, payment and Telegram environment variables in Vercel; never commit production secrets. Set `NODE_ENV=production`, and include the deployed frontend origin in `CORS_ORIGINS`.

Vercel functions are ephemeral and may run concurrently. The local tracking watchdog started by `src/index.js` does not run in the Vercel function; use a scheduled Vercel Cron invocation or an external scheduler for periodic tracking/accountability checks. In-memory rate limits are also per function instance rather than globally shared.

## Environment highlights

| Variable | Purpose |
| --- | --- |
| `PORT` | API port (default `5000`) |
| `MONGODB_URI` | MongoDB Atlas connection string |
| `JWT_SECRET` | Signing key for access tokens |
| `CORS_ORIGINS` | Comma-separated allowed web origins |
| `PUBLIC_WEB_URL` | Links used in emails and notifications |
| `GOOGLE_CLIENT_ID` | Google sign-in audience |
| `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | Image uploads and private KYC documents |
| `RESEND_API_KEY`, `MAIL_FROM` | Optional transactional email |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME` | First admin seed |
| `DEFAULT_COMMISSION_PCT`, `DEFAULT_SUBSCRIPTION_PRICE` | Business defaults |
| `PAYMENT_PROVIDER` | `razorpay` (automated checkout + webhook) |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | Razorpay API credentials |
| `RAZORPAY_WEBHOOK_SECRET` | HMAC secret for `/api/payment/webhook` |
| `TELEGRAM_BOT_TOKEN`, `ADMIN_TELEGRAM_CHAT_ID` | Optional admin payment alerts |

## Security model

- Every request is scoped by role: public catalogue, owner/admin profiles, booking participants only, admin-only KYC.
- Privileged routes verify the JWT and its claims (`role`, `workerApproved`, `admin`), with an `admins` collection as an additional admin check.
- Passwords are hashed with bcrypt (cost 12). Refresh tokens are hashed before storage.
- Phone numbers live in private booking contact fields and are never returned in public booking documents.
- `workersPublic` contains only safe directory fields (no phone, email, UPI or KYC).
- KYC files are stored as private Cloudinary assets and exposed by a short-lived URL issued through an admin-authenticated route.
- Job-feed entries and in-app job notifications are created only for approved, online workers matching the booking's service, exact city/state/locality and active-zone radius; Pro workers are notified first.
- Worker job acceptance rechecks the active zone and worker radius in an atomic update, in addition to price negotiation, completion and fee settlement.
- A booking with `preferredWorkerId` is reserved for that worker in the API, not just hidden in the UI.
- Rate limits apply globally, and more tightly to auth endpoints.

## Data model

MongoDB collections (Mongoose models are registered in `src/config/db.js`):

| Collection | Purpose |
| --- | --- |
| `users` | Customer/admin profile, role, premium state, password hash |
| `workers` | Private worker profile, trades, availability, earnings, Cloudinary KYC identifiers |
| `workersPublic` | Safe public worker directory |
| `services` | Admin-managed catalogue; each service has a `folderId` |
| `serviceFolders` | The 15 customer-facing folders (`_id` is the folder name) |
| `cities`, `promos`, `footerLinks` | Admin-managed catalogue content |
| `bookings` | Booking lifecycle, pricing, assignment, status |
| `jobFeed` | Open-job feed entries scoped to individual eligible workers |
| `urgentPublic` | Sanitised urgent jobs for the storefront |
| `subscriptions` | Razorpay membership orders and activated plans |
| `commissions` | Worker fee dues and Razorpay settlements |
| `payments` | Verified Razorpay payment audit records |
| `reviews` | Ratings and customer feedback |
| `chats` | Customer/admin support threads and messages |
| `notifications` | In-app notifications |
| `settings` | Fees, pricing, maintenance and announcements |
| `admins` | Admin membership documents |
| `audit` | Admin action log |

## API surface

All routes are prefixed by `/api`.

### Public

| Method | Path |
| --- | --- |
| GET | `/public/bootstrap` |
| GET | `/public/folders` |
| GET | `/public/service-area` |
| GET | `/public/workers`, `/public/workers/:id` |
| GET | `/public/urgent`, `/public/stats` |
| GET | `/public/health`, `/public/ping` |

`/public/bootstrap` returns services, live folders (with `servicesCount` and `serviceKeys`), cities, active promos and settings in one round trip.

### Auth and profile

| Method | Path |
| --- | --- |
| POST | `/auth/register`, `/auth/login`, `/auth/google` |
| POST | `/auth/refresh`, `/auth/logout` |
| GET/PATCH | `/auth/me` |
| POST | `/auth/avatar` |
| POST | `/auth/worker/apply` |
| GET | `/auth/worker/status` |
| POST | `/auth/verify-email`, `/auth/forgot-password`, `/auth/reset-password` |

### Customer

| Method | Path |
| --- | --- |
| POST/GET | `/bookings` |
| PATCH | `/bookings/:id/offer`, `/bookings/:id/accept-price` |
| PATCH | `/bookings/:id/cancel`, `/bookings/:id/payment` |
| POST | `/bookings/:id/review` |
| GET | `/bookings/:id/contact` |
| POST | `/payment/subscription/order`, `/payment/subscription/verify` |
| POST | `/chat`, `/chat/read`, `/notifications/read` |
| GET | `/server-time` |

### Worker

| Method | Path |
| --- | --- |
| PATCH | `/worker/profile`, `/worker/availability` |
| POST | `/worker/jobs/:id/accept`, `/worker/jobs/:id/price` |
| POST | `/worker/jobs/:id/confirm`, `/worker/jobs/:id/start`, `/worker/jobs/:id/complete` |
| POST | `/payment/commission/order`, `/payment/commission/verify` |
| GET | `/worker/earnings`, `/worker/commission` |
| POST | `/worker/kyc`, `/worker/welcome-email` |

### Payments

| Method | Path |
| --- | --- |
| POST | `/payment/subscription/order`, `/payment/subscription/verify` |
| POST | `/payment/commission/order`, `/payment/commission/verify` |
| POST | `/payment/webhook` (Razorpay signature required) |

### Admin

| Area | Paths |
| --- | --- |
| Dashboard | `GET /admin/overview`, `GET /admin/audit` |
| Users | `GET /admin/users`, `PATCH /admin/users/:id` |
| Workers | `GET /admin/workers`, `PATCH /admin/workers/:id/review`, `PATCH /admin/workers/:id/kyc`, `GET /admin/workers/:id/kyc-file` |
| Bookings | `GET /admin/bookings`, `PATCH /admin/bookings/:id/cancel`, `PATCH /admin/bookings/:id/payment` |
| Chat | `GET /admin/chats`, `GET/POST /admin/chats/:uid` |
| Admins | `GET/POST /admin/admins`, `DELETE /admin/admins/:id` |
| Catalogue | CRUD under `/admin/services`, `/admin/cities`, `/admin/promos` |
| Folders | `GET/POST /admin/folders`, `PUT/DELETE /admin/folders/:id`, `PATCH /admin/folders/:id/toggle`, `GET/POST /admin/folders/:id/services` |
| Settings | `GET/PATCH /admin/settings`, `POST /admin/settings/announcement` |
| Money | `/admin/subscriptions*`, `/admin/commissions*`, `GET /admin/revenue`, `POST /admin/maintenance/expire-premium` |

## Media

- Public images and private KYC documents are stored in Cloudinary.
- Uploads require Cloudinary credentials; there is no alternate bucket or local-file fallback.
- Uploads are size/type limited by Multer and validated server-side.

## Email and payments

- In-app notifications always work. Email is sent only when `RESEND_API_KEY` is set.
- Memberships and worker fee clearances use Razorpay Checkout. The API creates the order, verifies the payment signature server-side, and fulfils the benefit immediately.
- Razorpay Dashboard webhook URL: `https://<your-api-domain>/api/payment/webhook`. Subscribe to `payment.captured` and `order.paid`; set the signing secret as `RAZORPAY_WEBHOOK_SECRET`.
- Fulfilment is idempotent, so the browser verify call and the webhook can safely race. Telegram alerts are best-effort and never block fulfilment.
- Legacy manual UTR routes return `410 MANUAL_PAYMENT_DISABLED`. Historical admin approval screens remain for old records.

## Deploy checklist

1. Create a MongoDB Atlas cluster and add its connection string as `MONGODB_URI`. Set a strong `JWT_SECRET`.
2. Configure Cloudinary credentials on the API.
3. Set a strong `ADMIN_PASSWORD`, then run `npm run seed` and `node scripts/linkServices.mjs`.
4. Deploy this Express API to a Node host (Vercel, Render, Railway, Fly.io, Cloud Run).
5. Add the frontend origin to `CORS_ORIGINS`, and set `VITE_API_URL` in the frontend build to the API base **including `/api`**.
6. Build the frontend and deploy `dist/` to any static host.
7. Smoke test `/api/public/health`, `/api/public/bootstrap`, sign-in, booking creation, worker approval and the admin folder flow.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Startup exits with `MONGODB_URI is missing` | Add `MONGODB_URI` to `.env`. |
| `MongooseServerSelectionError` | The Atlas IP allowlist or connection string is wrong. |
| Sign-in returns `401` after a restart | `JWT_SECRET` changed; sign in again. |
| Cache hits on stale folder data | Folder changes invalidate `/public/folders` after 30 s (`s-maxage=60`). |
| Folder counts show zero | Run `node scripts/linkServices.mjs`; services need `folderId`. |
| Cloudinary upload failure | Verify the Cloudinary credentials and API network access. |
| Admin route redirects | The signed-in account needs the `admin` claim and an `admins` record. |
