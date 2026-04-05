# SmartUtilitiesAI API - Setup Guide

## Project Overview
Your Node.js/Express API is configured with:
- **ORM**: Prisma with PostgreSQL
- **Authentication**: JWT tokens with bcryptjs password hashing
- **Database**: User model with email, password, name

## What's Already Implemented ✅
1. **Login Endpoint**: `POST /api/auth/login`
2. **Register Endpoint**: `POST /api/auth/register`
3. **Profile Endpoint**: `GET /api/auth/me` (protected)
4. **User Service**: Password hashing and validation
5. **Auth Middleware**: JWT token verification

## Step 1: Install PostgreSQL

### macOS (Homebrew)
```bash
# Install PostgreSQL
brew install postgresql@16

# Start PostgreSQL service
brew services start postgresql@16

# Verify installation
psql --version
```

### Docker (Alternative)
```bash
docker run --name smartutiltiesai-postgres -e POSTGRES_PASSWORD=password -e POSTGRES_DB=smartutilitesai_db -p 5432:5432 -d postgres:16
```

## Step 2: Create Database and User

```bash
# Connect to PostgreSQL
psql -U postgres

# In psql:
CREATE DATABASE smartutilitesai_db;
CREATE USER smartutilitesai WITH ENCRYPTED PASSWORD 'password';
GRANT ALL PRIVILEGES ON DATABASE smartutilitesai_db TO smartutilitesai;
\q
```

## Step 3: Update Environment Variables

Your `.env` file is already configured:
```env
PORT=4000
DATABASE_URL=postgresql://postgres:password@localhost:5432/smartutilitesai_db?schema=public
JWT_SECRET=your-secret-key-change-in-production
```

**IMPORTANT**: Change `JWT_SECRET` in production!

## Step 4: Initialize Prisma & Database

```bash
# Install dependencies (if not done)
npm install

# Generate Prisma client
npm run prisma:generate

# Run migrations to create tables
npm run prisma:migrate

# (Optional) Open Prisma Studio to view data
npm run prisma:studio
```

## Step 5: Start the API

```bash
# Development mode (with auto-reload)
npm run dev

# Or production mode
npm start
```

The API will be running at: `http://localhost:4000`

## API Endpoints

### 1. Register User
```bash
curl -X POST http://localhost:4000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user@example.com",
    "password": "password123",
    "name": "John Doe"
  }'
```

**Response**:
```json
{
  "message": "User registered successfully",
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": 1,
    "email": "user@example.com",
    "name": "John Doe"
  }
}
```

### 2. Login User
```bash
curl -X POST http://localhost:4000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user@example.com",
    "password": "password123"
  }'
```

**Response**:
```json
{
  "message": "Login successful",
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": 1,
    "email": "user@example.com",
    "name": "John Doe"
  }
}
```

### 3. Get Current User Profile (Protected)
```bash
curl -X GET http://localhost:4000/api/auth/me \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

**Response**:
```json
{
  "id": 1,
  "email": "user@example.com",
  "name": "John Doe",
  "createdAt": "2026-03-28T10:30:00Z"
}
```

## Database Schema

### User Table
```sql
CREATE TABLE "User" (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  password VARCHAR(255) NOT NULL,
  name VARCHAR(255),
  createdAt TIMESTAMP DEFAULT NOW(),
  updatedAt TIMESTAMP DEFAULT NOW()
);

CREATE INDEX "User_email_idx" ON "User"(email);
```

## Troubleshooting

### Connection Error
**Error**: `could not connect to server: No such file or directory`

**Solution**:
```bash
# Check if PostgreSQL is running
brew services list

# Start PostgreSQL if not running
brew services start postgresql@16
```

### Database Does Not Exist
**Error**: `FATAL: database "smartutilitesai_db" does not exist`

**Solution**: Run the database creation commands in Step 2

### Migration Issues
```bash
# Reset database (⚠️ deletes all data)
npm run prisma:migrate reset

# Or manually:
npm run prisma:migrate
```

### JWT_SECRET Warning
If you see warnings about expired tokens, ensure `JWT_SECRET` is set in `.env`

## Production Deployment

Before deploying:
1. Change `JWT_SECRET` to a strong random value
2. Use a production PostgreSQL database
3. Update `DATABASE_URL` with production credentials
4. Set `CORS_ORIGIN` to your domain
5. Use environment variables for sensitive data

```bash
# Generate strong JWT_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Next Steps
- Add more authentication features (password reset, 2FA)
- Add profile update endpoint
- Implement role-based access control
- Add email verification
