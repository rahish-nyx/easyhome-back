# EasyHome API

Thin Express 5 service that owns every privileged EasyHome write. The web app reads Firestore directly with realtime listeners; this API verifies Firebase ID tokens, applies role checks, runs transactions, uploads media, and writes audit/notification records with the Firebase Admin SDK.

> The previous MongoDB/Mongoose backend and Socket.IO transport have been removed. Realtime updates are delivered by Firestore `onSnapshot`.

## Stack

- Node.js 20+
- Express 5
- Firebase Admin SDK (Auth, Firestore, Storage)
- Zod validation, Helmet, CORS, rate limiting, compression, Multer
- Resend for optional transactional email

## Setup

```bash
npm install
cp .env.example .env   # Windows: copy .env.example .env
```

Set Firebase Admin credentials in `.env` using one of:

1. `GOOGLE_APPLICATION_CREDENTIALS=./serviceAccount.json` (recommended locally), or
2. `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`, or
3. `FIREBASE_SERVICE_ACCOUNT_JSON` with the full JSON.

Never commit `.env` or the service-account key. Both are gitignored.

### Required Firebase project setup

The current project is `easyhome-bec14` (Firestore region `asia-south1`).

1. Link a billing account to the Google Cloud project. Identity Platform (Firebase Authentication) and a default Storage bucket cannot be initialised while billing is disabled.
2. **Authentication** -> enable **Email/Password** and **Google**.
3. **Storage** -> create the default bucket (`easyhome-bec14.firebasestorage.app`).
4. Deploy the security rules and indexes:

```bash
npx firebase-tools login
npx firebase-tools deploy --only firestore:rules,firestore:indexes,storage
```

5. Build the frontend, then deploy hosting:

```bash
cd ../easyhomes && npm run build
cd ../backend
npx firebase-tools deploy --only hosting
```

Hosting publishes `../easyhomes/dist`, rewrites SPA routes to `index.html`, marks hashed assets immutable, and sets security headers.

### Seed the first admin

After Authentication is enabled:

```bash
npm run seed
```

The seed writes the service catalogue, cities, sample promos, `settings/app`, and the admin account named by `ADMIN_EMAIL`. Set a unique `ADMIN_PASSWORD` of at least 12 characters in `.env` **before** running it in production; the seed skips the admin account when the password is missing or too short. The seed is idempotent for catalogue documents and does not overwrite an existing admin password.

## Run

```bash
npm run dev     # nodemon on http://localhost:5000
npm start       # production process
npm run check   # syntax-check every source file
```

Health check: `GET /health` -> `{ ok: true, service: "easyhome-api", version: 2 }`.

## Environment highlights

| Variable | Purpose |
| --- | --- |
| `PORT` | API port (default `5000`) |
| `CORS_ORIGINS` | Comma-separated allowed web origins |
| `PUBLIC_WEB_URL` | Links used in emails and notifications |
| `FIREBASE_*` / `GOOGLE_APPLICATION_CREDENTIALS` | Admin credentials |
| `FIREBASE_STORAGE_BUCKET` | Media/KYC bucket |
| `RESEND_API_KEY`, `MAIL_FROM` | Optional transactional email |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME` | First admin seed |
| `DEFAULT_COMMISSION_PCT`, `DEFAULT_SUBSCRIPTION_PRICE` | Business defaults |
| `PAYMENT_PROVIDER` | `manual` today; Razorpay adapter can follow |

`FIRESTORE_EMULATOR_HOST`, `FIREBASE_AUTH_EMULATOR_HOST` and `FIREBASE_STORAGE_EMULATOR_HOST` switch the API to the emulator suite without a service account.

## Security model

- Firestore rules deny all client writes.
- Reads are scoped: public catalogue; owner/admin profiles; booking participants only; admin-only KYC.
- Privileged routes verify the Firebase ID token and custom claims (`role`, `workerApproved`, `admin`), with `admins/{uid}` as an additional admin check.
- Phone numbers live in `bookings/{id}/private/contact`, never in public booking documents.
- `workersPublic` contains only safe directory fields (no phone, email, UPI or KYC).
- KYC files are served only through an admin-authenticated route.
- Worker job acceptance, price negotiation, completion and commission settlement run in Firestore transactions.
- A booking with `preferredWorkerId` is reserved for that worker in the API, not just hidden in the UI.
- Rate limits apply globally, and more tightly to auth endpoints.

## Data model

| Collection | Purpose |
| --- | --- |
| `users/{uid}` | Customer/admin profile, role, premium state |
| `workers/{uid}` | Private worker profile, trades, availability, earnings, KYC paths |
| `workersPublic/{uid}` | Safe public worker directory |
| `services/{id}`, `cities/{id}`, `promos/{id}` | Admin-managed catalogue |
| `bookings/{id}` | Booking lifecycle, pricing, assignment, status |
| `bookings/{id}/private/contact` | Phone and private contact details |
| `jobFeed/{bookingId}` | Open-job feed used by workers |
| `urgentPublic/{bookingId}` | Sanitised urgent jobs for the storefront |
| `subscriptions/{id}` | Manual UPI membership requests and approvals |
| `commissions/{id}` | Worker commission dues and settlements |
| `reviews/{id}` | Ratings and customer feedback |
| `chats/{uid}/messages/{id}` | Customer/admin support thread |
| `notifications/{id}` | In-app notifications |
| `settings/app` | Commission, pricing, UPI, maintenance and announcements |
| `admins/{uid}` | Admin membership document |

## API surface

All routes are prefixed by `/api`.

### Public

| Method | Path |
| --- | --- |
| GET | `/public/bootstrap` |
| GET | `/public/service-area` |
| GET | `/public/workers`, `/public/workers/:id` |
| GET | `/public/urgent`, `/public/stats` |
| GET | `/public/health`, `/public/ping` |

`/public/bootstrap` returns services, cities, active promos and settings in one round trip and avoids composite-index dependencies for the small catalogue collections.

### Auth and profile

| Method | Path |
| --- | --- |
| POST | `/auth/session` |
| GET/PATCH | `/auth/me` |
| POST | `/auth/avatar` |
| POST | `/auth/worker/apply` |
| GET | `/auth/worker/status` |

### Customer

| Method | Path |
| --- | --- |
| POST/GET | `/bookings` |
| PATCH | `/bookings/:id/offer`, `/bookings/:id/accept-price` |
| PATCH | `/bookings/:id/cancel`, `/bookings/:id/payment` |
| POST | `/bookings/:id/review` |
| GET | `/bookings/:id/contact` |
| POST | `/subscriptions` |
| POST | `/chat`, `/chat/read`, `/notifications/read` |
| GET | `/server-time` |

### Worker

| Method | Path |
| --- | --- |
| PATCH | `/worker/profile`, `/worker/availability` |
| POST | `/worker/jobs/:id/accept`, `/worker/jobs/:id/price` |
| POST | `/worker/jobs/:id/confirm`, `/worker/jobs/:id/start`, `/worker/jobs/:id/complete` |
| POST | `/worker/commission/:bookingId/paid` |
| GET | `/worker/earnings`, `/worker/commission` |
| POST | `/worker/kyc`, `/worker/welcome-email` |

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
| Settings | `GET/PATCH /admin/settings`, `POST /admin/settings/announcement` |
| Money | `/admin/subscriptions*`, `/admin/commissions*`, `GET /admin/revenue`, `POST /admin/maintenance/expire-premium` |

## Media

- Public images are uploaded to Storage and served through `GET /api/media/:path`.
- KYC images use a separate private folder and are only exposed by the admin KYC route.
- Uploads are size/type limited by Multer and validated server-side.
- If the Storage bucket is missing, uploads fail cleanly instead of silently writing to the repository.

## Email and payments

- In-app notifications always work. Email is sent only when `RESEND_API_KEY` is set.
- Memberships use manual UPI plus admin approval by default. `PAYMENT_PROVIDER` leaves room for a Razorpay adapter without changing the client contract.

## Deploy checklist

1. Link billing and enable Authentication + Storage in the Firebase console.
2. Set a strong `ADMIN_PASSWORD`, then run `npm run seed`.
3. Deploy this Express API to a Node host (Render, Railway, Fly.io, Cloud Run) or wrap it as a Firebase Cloud Function with an `/api/**` Hosting rewrite. Firebase Hosting alone cannot run Express.
4. Add the Hosting origin to `CORS_ORIGINS`, and set `VITE_API_URL` in the frontend build to the API base **including `/api`**.
5. `npx firebase-tools login`.
6. Deploy rules and indexes: `npx firebase-tools deploy --only firestore:rules,firestore:indexes,storage`.
7. Build the frontend, then deploy hosting.
8. Smoke test `/health`, `/api/public/bootstrap`, sign-in, booking creation, worker approval and admin dashboard.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `CONFIGURATION_NOT_FOUND` on sign-in | Authentication is not enabled, or billing is not linked for Identity Platform. |
| `BILLING_NOT_ENABLED` | Link a billing account to the Google Cloud project. |
| Storage upload 403/404 | Create the default Storage bucket and verify the service account. |
| `firebaserules.releases.create` denied | The service account cannot deploy rules. Use `npx firebase-tools login` with an owner account, or grant Firebase Rules Admin. |
| `query requires an index` | Deploy `firestore.indexes.json` with the Firebase CLI. |
| Public catalogue is empty | Firestore rules are still deny-all; deploy them. |
| Admin route redirects | The signed-in account needs the `admin` custom claim and `admins/{uid}`. |
