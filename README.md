# NimbusCloud API

Node.js + Express + PostgreSQL backend for the NimbusCloud media storage service.

## Tech Stack

- **Runtime**: Node.js 20+ with TypeScript
- **Framework**: Express.js
- **Database**: PostgreSQL (via Supabase or direct pg connection)
- **Object Storage**: Supabase Storage or AWS S3
- **Auth**: JWT (access + refresh tokens, httpOnly cookies)
- **Validation**: Zod
- **Queue**: BullMQ + Redis (for background jobs)
- **Rate Limiting**: express-rate-limit

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Copy and fill environment variables
cp .env.example .env

# 3. Run database migration
npm run migrate

# 4. Start development server
npm run dev
```

Server starts at `http://localhost:8080`

## Environment Variables

See `.env.example` for the full list. Key variables:

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | Long random string for signing access tokens |
| `REFRESH_SECRET` | Long random string for refresh tokens |
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key for storage operations |
| `CORS_ORIGIN` | Frontend URL (e.g. http://localhost:3000) |

## API Endpoints

### Auth
| Method | Path | Description |
|---|---|---|
| POST | `/api/auth/register` | Register new user |
| POST | `/api/auth/login` | Login, sets httpOnly cookies |
| POST | `/api/auth/logout` | Logout, clears cookies |
| POST | `/api/auth/refresh` | Rotate refresh token |
| GET | `/api/auth/me` | Get current user |

### Folders
| Method | Path | Description |
|---|---|---|
| POST | `/api/folders` | Create folder |
| GET | `/api/folders` | List root folders + files |
| GET | `/api/folders/:id` | Get folder with children + breadcrumb |
| PATCH | `/api/folders/:id` | Rename or move folder |
| DELETE | `/api/folders/:id` | Soft-delete folder |

### Files
| Method | Path | Description |
|---|---|---|
| POST | `/api/files/init` | Initiate multipart upload → returns presigned URLs |
| POST | `/api/files/complete` | Finalize upload, create version record |
| GET | `/api/files/:id` | Get file metadata + signed download URL |
| PATCH | `/api/files/:id` | Rename or move file |
| DELETE | `/api/files/:id` | Soft-delete file |
| GET | `/api/files/:id/versions` | List all versions |

### Shares
| Method | Path | Description |
|---|---|---|
| POST | `/api/shares` | Grant user access (viewer/editor) |
| GET | `/api/shares/:type/:id` | List who has access |
| DELETE | `/api/shares/:id` | Revoke access |

### Public Links
| Method | Path | Description |
|---|---|---|
| POST | `/api/link-shares` | Create public link (optional expiry + password) |
| GET | `/api/link-shares/:type/:id` | List links for a resource |
| DELETE | `/api/link-shares/:id` | Revoke link |
| GET | `/api/link/:token` | Resolve public link (no auth needed) |

### Other
| Method | Path | Description |
|---|---|---|
| GET | `/api/search?q=&type=` | Search files and folders |
| POST | `/api/stars` | Star a resource |
| DELETE | `/api/stars` | Unstar a resource |
| GET | `/api/trash` | List trashed items |
| POST | `/api/trash/restore` | Restore from trash |
| DELETE | `/api/trash/purge/:type/:id` | Permanently delete |

## Error Format

All errors follow this structure:
```json
{
  "error": {
    "code": "FORBIDDEN",
    "message": "Access denied"
  }
}
```

Common error codes: `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_ERROR`, `RATE_LIMITED`, `CONFLICT`

## Security

- JWT access tokens (15 min TTL) in httpOnly cookies
- Refresh token rotation on every use
- Server-side ACL checks on every request
- Zod input validation on all routes
- Rate limiting per IP + user
- CORS restricted to `CORS_ORIGIN`
- Helmet security headers

## Project Structure

```
src/
├── index.ts              # Express app entry point
├── db/
│   ├── index.ts          # pg Pool + query helper
│   └── migrations/
│       └── 001_initial_schema.sql
├── middleware/
│   ├── auth.ts           # JWT authentication
│   ├── errorHandler.ts   # Global error handler
│   └── rateLimiter.ts    # Rate limiting config
├── routes/
│   ├── auth.ts
│   ├── files.ts
│   ├── folders.ts
│   ├── shares.ts
│   ├── linkShares.ts     # Also contains search, stars, trash
│   ├── search.ts
│   ├── stars.ts
│   └── trash.ts
├── services/
│   ├── authService.ts    # Token generation, hashing
│   ├── storageService.ts # Presigned URLs, storage keys
│   ├── aclService.ts     # Permission checks
│   └── activityService.ts
└── types/
    └── index.ts          # Shared TypeScript types
```

## Deployment

### Render / Fly.io
```bash
# Set environment variables in dashboard
# Build command:
npm run build
# Start command:
npm start
```

### Docker
```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY dist/ ./dist/
EXPOSE 8080
CMD ["node", "dist/index.js"]
```
