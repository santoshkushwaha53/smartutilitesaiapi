# Quick Reference - Login API Endpoints

## 🚀 Start Server
```bash
npm start
```
Server runs on: `http://localhost:4000`

---

## 📝 Register New User
```bash
curl -X POST http://localhost:4000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user@example.com",
    "password": "password123",
    "name": "Your Name"
  }'
```

**Response**: `201 Created` + JWT Token

---

## 🔐 Login User (Get JWT Token)
```bash
curl -X POST http://localhost:4000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user@example.com",
    "password": "password123"
  }'
```

**Response**: `200 OK` + JWT Token

---

## 👤 Get User Profile (Protected)
```bash
curl -X GET http://localhost:4000/api/auth/me \
  -H "Authorization: Bearer JWT_TOKEN_HERE"
```

**Response**: `200 OK` + User data

---

## 🗄️ Database Commands

### Connect to Database
```bash
psql -U postgres -h localhost smartutilitesai_db
```

### View Users Table
```sql
SELECT id, email, name, "createdAt" FROM "User";
```

### Check Database Status
```bash
npm run prisma:studio
```

---

## 📋 Environment Variables
| Key | Value |
|-----|-------|
| PORT | 4000 |
| DATABASE_URL | postgresql://postgres:password@localhost:5432/smartutilitesai_db |
| JWT_SECRET | your-super-secret-jwt-key-change-in-production-2026 |

---

## ✅ Test Credentials
**Email**: newuser@test.com  
**Password**: password123

---

## 🔑 JWT Token Structure
- **Type**: HS256 (HMAC SHA256)
- **Expires**: 7 days
- **Contains**: userId, email, iat, exp
- **Location**: `Authorization: Bearer <token>`

---

## 📦 Tech Stack
- **Framework**: Express.js 5
- **Database**: PostgreSQL
- **ORM**: Prisma 5
- **Authentication**: JWT + bcryptjs
- **Security**: Helmet, CORS, Morgan logger

---

## 🚨 Error Codes
| Status | Meaning |
|--------|---------|
| 400 | Bad request / Invalid input |
| 401 | Unauthorized / Invalid credentials |
| 404 | Not found |
| 500 | Server error |

---

## 📚 Key Files
- `src/server.js` - Main server file
- `src/routes/auth.route.js` - Auth endpoints (LOGIN is here)
- `src/services/user.service.js` - User business logic
- `prisma/schema.prisma` - Database schema
- `.env` - Configuration file

---

**Made with ❤️ on March 28, 2026**
