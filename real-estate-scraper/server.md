# Juyonna Travels Server - API Setup Guide

## Overview

This document explains the architecture and structure of the Juyonna Travels API server. The project is built with **Express.js**, **TypeScript**, and **Prisma ORM**, following a modular, role-based API structure.

---

## 1. Project Architecture

The API server is organized into three main role-based modules:

```
src/
├── api/                    # All API endpoints
│   ├── authentication/     # Auth-related endpoints (login, sign-up, password reset, etc.)
│   ├── admin/             # Admin panel endpoints
│   ├── client/            # Client-facing endpoints
│   └── webhooks/          # Third-party webhook handlers (Paystack)
├── middlewares/           # Express middleware (JWT verification, role checking, error handling)
├── exceptions/            # Custom error classes and HTTP status codes
├── libs/                  # External service integrations (Firebase, Paystack, Termii, etc.)
├── utils/                 # Utility functions (JWT, logger, date helpers, etc.)
├── events/                # Event listeners and handlers
├── jobs/                  # Background/scheduled jobs
├── types/                 # TypeScript type definitions
├── app.ts                 # Express app configuration
├── routes.ts              # Main router setup
└── server.ts              # Server startup
```

---

## 2. Routing & API Versioning

### Main Router Configuration (`routes.ts`)

All routes are versioned and organized by feature:

```typescript
router.get("/healthcheck", ...);
router.use("/:version/auth", authenticationRoutes);
router.use("/:version/admin", adminRoutes);
router.use("/:version/client", clientRoutes);
router.use("/:version/webhook", paystackRoutes);
```

### Usage

- All API endpoints are prefixed with `/api`
- Versions are passed as a URL parameter: `/api/v1/auth/login`
- Health check available at: `/api/healthcheck`
- Swagger documentation at: `/docs`

### Example Endpoints

```
POST   /api/v1/auth/sign-up
POST   /api/v1/auth/login
POST   /api/v1/auth/refresh-token
POST   /api/v1/client/bookings
GET    /api/v1/admin/customers
POST   /api/v1/webhook/paystack
```

---

## 3. Application Setup (`app.ts`)

### Middleware Stack

1. **Helmet** - Security headers
2. **CORS** - Cross-origin request handling with origin whitelist
3. **Morgan** - HTTP request logging
4. **Express JSON/URL** - Request body parsing (10mb limit)
5. **Passport** - Authentication strategy (optional)
6. **Express Session** - Session management

### CORS Configuration

Allowed origins:
- Local development: `localhost:3000`, `localhost:5173`, `127.0.0.1:3000`
- Production: `https://juyonna.com`, `https://admin.juyonna.com`
- Staging environments with custom domains

### Error Handling

- Global 404 handler returns: `{ status: "error", message: "Route not found" }`
- Error handler middleware catches and logs all errors

### Additional Endpoints

- **`GET /`** - Redirects to `/docs`
- **`GET /metrics`** - Prometheus metrics for monitoring
- **`GET /docs`** - Swagger API documentation

---

## 4. API Module Structure

Each API module (authentication, admin, client) follows a consistent pattern:

```
authentication/
├── index.ts              # Router setup with all routes and Swagger docs
├── handlers/
│   ├── index.ts         # Barrel export of all handlers
│   ├── login/
│   │   ├── index.ts     # Export
│   │   └── login-v1.ts  # Handler function
│   ├── sign-up/
│   │   ├── index.ts
│   │   └── sign-up-v1.ts
│   ├── refresh-token/
│   ├── reset-password/
│   ├── forgot-password/
│   ├── change-password/
│   └── otp/
└── services/
    └── database/        # Database queries and operations
        ├── user.ts
        ├── refreshToken.ts
        ├── pushToken.ts
        └── notifications.ts
```

---

## 5. Handler Pattern

### File Naming Convention

- Handler files follow the pattern: `<feature>-v<version>.ts`
- Example: `login-v1.ts`, `sign-up-v1.ts`
- Multiple versions can coexist for backward compatibility

### Handler Structure

```typescript
export const login = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    // Extract request data
    const { email, password, fcmToken, deviceName, deviceId, location } = req.body;

    // Validate inputs
    if (!email || !password) {
      return res.status(HttpStatusCode.BAD_REQUEST).json({
        status: "error",
        message: "Email and password are required.",
      });
    }

    // Business logic
    // - Query database
    // - Process data
    // - Generate tokens
    // - Create records

    // Send response
    res.status(HttpStatusCode.OK).json({
      status: "ok",
      data: { token, refreshToken, user }
    });

  } catch (error) {
    next(error);  // Pass to error handler middleware
  }
};
```

### Key Patterns

- All handlers use async/await
- Try-catch blocks for error handling
- Errors passed to `next()` for centralized handling
- Consistent response format: `{ status: "ok"|"error", data?: any, message?: string }`

---

## 6. Middleware Chain

### Authentication Middleware (`checkJwt`)

Verifies JWT tokens and populates user information:

```typescript
export interface CustomRequest extends Request {
  token?: AuthTokenPayload;
  user?: User;
  adminTeamMember?: AdminTeamMembers;
}
```

**Usage:**
```typescript
router.get("/profile", checkJwt, UserProfileController.getProfile);
```

### Role-Based Middleware (`checkRoles`)

Verifies user roles:

```typescript
router.post("/create-service", checkJwt, checkIsAdmin, ProtocolsController.createService);
```

### Error Handler Middleware

Catches all errors and returns standardized error responses.

---

## 7. Database Service Layer

Each API module has a `services/database/` folder with functions for database operations.

### Example Structure

```typescript
// services/database/user.ts
export const findUser = async (email: string) => {
  return prismaClient.user.findUnique({ where: { email } });
};

export const createUser = async (userData: CreateUserInput) => {
  return prismaClient.user.create({ data: userData });
};
```

### Usage in Handlers

```typescript
import { findUser, createUser } from "../../services/database/user";

const user = await findUser(email);
if (!user) {
  throw new NotFoundError("User not found");
}
```

---

## 8. Error Handling

### Custom Error Classes

Located in `exceptions/index.ts`:

```typescript
export enum HttpStatusCode {
  OK = 200,
  CREATED = 201,
  BAD_REQUEST = 400,
  UNAUTHORIZED = 401,
  FORBIDDEN = 403,
  NOT_FOUND = 404,
  INTERNAL_SERVER = 500,
}

export class BaseError extends Error {
  constructor(
    name: string,
    httpCode: HttpStatusCode,
    description: string,
    isOperational: boolean
  );
}
```

### Error Subclasses

- `BadRequestError`
- `UnauthorizedError`
- `ForbiddenError`
- `NotFoundError`
- `ConflictError`
- `InternalServerError`

### Usage in Handlers

```typescript
if (!email || !password) {
  throw new BadRequestError("Email and password are required");
}

if (!user) {
  throw new UnauthorizedError("Invalid credentials");
}
```

---

## 9. Authentication Flow

### Token-Based Authentication (JWT)

1. **Login** → Generate JWT and Refresh Token
2. **Request** → Include JWT in Authorization header: `Bearer <token>`
3. **Verify** → Middleware validates JWT and extracts user info
4. **Refresh** → Use refresh token to get new JWT when expired

### JWT Structure

```typescript
interface AuthTokenPayload {
  id: string;
  email: string;
  role: UserRole;
  iat: number;
  exp: number;
}
```

### Token Generation

```typescript
import { generateToken, generateRefreshToken } from "../../../../utils/jwt";

const token = generateToken(user);
const refreshToken = generateRefreshToken(user);
```

---

## 10. External Service Integrations

### Integrated Services (in `libs/`)

- **Firebase** (`libs/firebase/`) - Push notifications
- **Paystack** (`libs/paystack/`) - Payment processing
- **Termii** (`libs/termii/`) - SMS/WhatsApp messaging
- **Anchor** (`libs/anchor/`) - Travel insurance
- **Tangerine** (`libs/tangerine/`) - Local travel insurance
- **AIES** (`libs/aies/`) - Shipment tracking
- **ZeptoMail** (`libs/zeptomail/`) - Email service
- **WhatsApp** (`libs/whatsapp/`) - WhatsApp integration

### Webhook Handlers

Webhooks from external services (Paystack) are handled in `api/webhooks/`:

```typescript
// api/webhooks/paystack.ts
router.post("/paystack", handlePaystackWebhook);
```

---

## 11. API Documentation (Swagger)

### Swagger Setup

- Configured in `utils/swagger.ts`
- Accessible at: `http://localhost:3000/docs`
- Generated from JSDoc comments in route files

### Example Swagger Documentation

```typescript
/**
 * @swagger
 * '/auth/login':
 *  post:
 *     tags:
 *     - Auth
 *     summary: Login user with email and password
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               email:
 *                 type: string
 *               password:
 *                 type: string
 *     responses:
 *      200:
 *        description: Login successful
 *      401:
 *        description: Invalid credentials
 */
router.post("/login", AuthController.login);
```

---

## 12. Request/Response Format

### Standard Success Response

```json
{
  "status": "ok",
  "data": {
    "id": "user-123",
    "email": "user@example.com",
    "token": "eyJhbGc...",
    "refreshToken": "eyJhbGc..."
  }
}
```

### Standard Error Response

```json
{
  "status": "error",
  "message": "Invalid credentials"
}
```

### Status Codes

- **200** - Success
- **201** - Created
- **400** - Bad Request
- **401** - Unauthorized
- **403** - Forbidden
- **404** - Not Found
- **409** - Conflict
- **500** - Internal Server Error

---

## 13. Event System

Located in `events/`:

- `listener.ts` - Event listener setup
- `index.ts` - Event type definitions and emitter

Used for:
- Triggering background tasks
- Sending notifications
- Logging important actions

```typescript
import { AppEventTypes, appEvents } from "../../../../events";

appEvents.emit(AppEventTypes.USER_CREATED, { userId, email });
```

---

## 14. Utility Functions

### Common Utilities

- **JWT Utils** (`utils/jwt.ts`) - Token generation and verification
- **Logger** (`utils/logger.ts`) - Centralized logging
- **Prisma** (`utils/prisma.ts`) - Database client instance
- **Date Helpers** (`utils/date.ts`) - Date manipulation
- **OTP Generator** (`utils/generate-otp.ts`) - OTP generation
- **Validations** (`utils/validations.ts`) - Input validation functions
- **Phone Service** (`utils/phoneService.ts`) - Phone number formatting

---

## 15. Environment Configuration

### Key Environment Variables

```env
JWT_SECRET=your-secret-key
JWT_EXPIRES_IN=24h
JWT_AUDIENCE=your-audience
JWT_ISSUER=your-issuer
PORT=3000
DATABASE_URL=postgresql://...
FIREBASE_ADMIN_SDK_KEY=...
PAYSTACK_SECRET_KEY=...
```

Loaded and validated in `config.ts`

---

## 16. Database & Migrations (Prisma)

### Schema Location

`prisma/schema.prisma` - Defines all data models

### Migrations

Located in `prisma/migrations/` - Version control for database schema changes

### Common Tasks

```bash
npx prisma migrate dev --name add_new_table
npx prisma generate
npx prisma db push
```

---

## 17. Development Workflow

### Starting the Server

```bash
npm run dev
```

### Testing API Endpoints

- Use Postman/Insomnia with the provided Postman collection (`AIES.postman_collection.json`)
- Or access Swagger UI at `http://localhost:3000/docs`

### Adding a New Endpoint

1. Create handler in `api/<module>/handlers/<feature>/<feature>-v1.ts`
2. Export from `api/<module>/handlers/index.ts`
3. Add route with Swagger docs in `api/<module>/index.ts`
4. Use database service functions for data operations
5. Return standardized response format

---

## 18. Monitoring & Logging

- **Morgan** - HTTP request logging to console
- **Logger Utility** - Centralized logging system
- **Prometheus** - Metrics available at `/metrics`
- **Error Logging** - All errors logged before returning to client

---

## Summary

The API follows a **modular, service-oriented architecture** with:

✅ **Role-based API modules** (auth, admin, client)  
✅ **Versioned endpoints** for backward compatibility  
✅ **Standardized handler pattern** for consistency  
✅ **Database service layer** for clean data operations  
✅ **Custom error handling** for predictable responses  
✅ **JWT-based authentication** with role verification  
✅ **External service integrations** via dedicated libraries  
✅ **Swagger documentation** for easy API exploration  
✅ **Comprehensive logging** for debugging and monitoring  

This structure makes the codebase scalable, maintainable, and easy for new developers to understand.
