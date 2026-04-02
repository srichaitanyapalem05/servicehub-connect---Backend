# Multi-Vendor Service Booking Platform

## Overview

A complete production-ready backend for a Multi-Vendor Service Booking Platform built with Node.js, Express.js, TypeScript, and PostgreSQL (Drizzle ORM).

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Auth**: JWT (jsonwebtoken) + bcryptjs
- **Validation**: express-validator + Zod (zod/v4)
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (ESM bundle)
- **Logging**: pino + pino-http

## Structure

```text
artifacts-monorepo/
├── artifacts/
│   └── api-server/         # Express API server
│       └── src/
│           ├── controllers/     # Business logic
│           ├── middlewares/     # Auth, validation, error handling
│           ├── routes/          # API routes
│           └── utils/           # ID generation, pagination
├── lib/
│   ├── api-spec/           # OpenAPI spec + Orval codegen config
│   ├── api-client-react/   # Generated React Query hooks
│   ├── api-zod/            # Generated Zod schemas from OpenAPI
│   └── db/                 # Drizzle ORM schema + DB connection
│       └── src/schema/
│           ├── users.ts
│           ├── vendors.ts
│           ├── services.ts
│           ├── bookings.ts
│           └── reviews.ts
├── scripts/                # Utility scripts
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── tsconfig.json
└── package.json
```

## API Endpoints

### Authentication (`/api/auth`)
- `POST /api/auth/register` — Register as customer
- `POST /api/auth/login` — Login (any role)
- `GET /api/users/profile` — Get own profile (protected)

### Vendor (`/api/vendor`)
- `POST /api/vendor/register` — Register as vendor
- `POST /api/vendor/login` — Vendor login
- `GET /api/vendor/dashboard` — Vendor dashboard stats (protected: vendor)
- `GET /api/vendor/bookings` — Get vendor's bookings (protected: vendor)
- `PATCH /api/vendor/bookings/:id` — Update booking status (protected: vendor)

### Services (`/api/services`)
- `GET /api/services` — Browse services (search, filter, sort, paginate)
- `GET /api/services/:id` — Get service details
- `POST /api/services` — Create service (protected: vendor)
- `PUT /api/services/:id` — Update service (protected: vendor)
- `DELETE /api/services/:id` — Delete service (protected: vendor)

### Bookings (`/api/bookings`)
- `POST /api/bookings` — Create booking (protected: customer)
- `GET /api/bookings/my` — Get user's booking history (protected)

### Reviews (`/api/reviews`)
- `POST /api/reviews` — Create review (protected)
- `GET /api/reviews/service/:serviceId` — Get reviews for a service

### Payments (`/api/payments`)
- `POST /api/payments/checkout` — Mock payment (marks booking as paid)

### Admin (`/api/admin`)
- `GET /api/admin/users` — List all users (protected: admin)
- `DELETE /api/admin/users/:id` — Delete user (protected: admin)
- `GET /api/admin/vendors` — List all vendors (protected: admin)
- `PATCH /api/admin/vendors/:id/approve` — Approve/reject vendor (protected: admin)
- `GET /api/admin/bookings` — List all bookings (protected: admin)
- `GET /api/admin/reports` — Platform analytics (protected: admin)

## User Roles

- `customer` — can browse services, create bookings, leave reviews
- `vendor` — can manage services, accept/reject bookings, view dashboard
- `admin` — can manage all users, approve vendors, view reports

## Database Schema

| Table | Key fields |
|-------|-----------|
| users | id, name, email, password, role, createdAt |
| vendors | id, userId, businessName, isApproved, createdAt |
| services | id, title, description, price, category, vendorId, rating, reviewCount, createdAt |
| bookings | id, userId, vendorId, serviceId, date, time, status, paymentStatus, createdAt |
| reviews | id, userId, serviceId, rating, comment, createdAt |

## Notes

- Vendors must be approved by an admin before they can add services
- To create an admin, manually update a user's `role` column to `'admin'` in the database
- JWT tokens expire in 7 days
- Services support keyword search, category filter, price/rating range filters, and sorting
- All paginated endpoints support `?page=` and `?limit=` query params
