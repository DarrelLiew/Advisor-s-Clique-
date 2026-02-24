# Setup Guide

Complete setup instructions for the Advisors Clique AI Chatbot platform.

## Prerequisites

- Node.js 18+ installed
- Supabase account (already configured at `kvgbhaqtvdrdlafbucdw.supabase.co`)
- n8n instance (cloud or self-hosted)
- OpenAI API account
- Telegram account (for bot creation)

## 1. Supabase Setup

### Get API Keys

1. Go to [Supabase Dashboard](https://supabase.com/dashboard)
2. Select your project: `kvgbhaqtvdrdlafbucdw`
3. Go to **Settings** → **API**
4. Copy:
   - **Project URL:** `https://kvgbhaqtvdrdlafbucdw.supabase.co`
   - **anon/public key:** (for frontend)
   - **service_role key:** (for backend - KEEP SECRET!)

### Create Storage Bucket

1. In Supabase Dashboard, go to **Storage**
2. Create new bucket: `documents`
3. Set to **Private** (authenticated users only)
4. In bucket settings, create policy:

   ```sql
   -- Allow authenticated users to upload
   CREATE POLICY "Authenticated users can upload"
   ON storage.objects FOR INSERT
   TO authenticated
   WITH CHECK (bucket_id = 'documents');

   -- Allow service role to read
   CREATE POLICY "Service role can read"
   ON storage.objects FOR SELECT
   TO service_role
   USING (bucket_id = 'documents');
   ```

### Database Schema

✅ Already created via MCP! Tables include:

- `profiles` - User profiles with roles
- `documents` - Document metadata
- `document_chunks` - Text chunks with embeddings (vector)
- `chat_messages` - Chat history
- `question_analytics` - Query analytics
- `telegram_link_tokens` - Telegram linking tokens
- `audit_logs` - Audit trail

### Create First Admin User

Run this in Supabase SQL Editor:

```sql
-- Create admin user (replace with your email)
INSERT INTO auth.users (
  instance_id,
  id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_user_meta_data,
  created_at,
  updated_at,
  confirmation_token,
  email_change,
  email_change_token_new,
  recovery_token
) VALUES (
  '00000000-0000-0000-0000-000000000000',
  gen_random_uuid(),
  'authenticated',
  'authenticated',
  'admin@example.com',  -- YOUR EMAIL HERE
  crypt('ChangeThisPassword123!', gen_salt('bf')),  -- YOUR PASSWORD HERE
  NOW(),
  '{"role": "admin"}'::jsonb,
  NOW(),
  NOW(),
  '',
  '',
  '',
  ''
);

-- Get the user ID
SELECT id, email FROM auth.users WHERE email = 'admin@example.com';

-- Update profile to admin (use the ID from above)
UPDATE profiles SET role = 'admin' WHERE id = 'USER_ID_HERE';
```

---

## 2. OpenAI Setup

1. Go to [OpenAI Platform](https://platform.openai.com/)
2. Create API key at **API Keys** section
3. Copy the key (starts with `sk-...`)
4. Ensure you have credits/billing set up

---

## 3. Telegram Bot Setup

1. Open Telegram and search for **@BotFather**
2. Send `/newbot`
3. Follow prompts:
   - Bot name: "Advisors Clique Bot"
   - Username: choose something like `advisors_clique_bot`
4. Copy the **Bot Token** (looks like `1234567890:ABCdefGHIjklMNOpqrsTUVwxyz`)
5. Set bot commands:
   ```
   /setcommands
   start - Start conversation
   link - Link Telegram to account
   help - Get help
   ```

---

## 4. n8n Setup

### Option A: n8n Cloud

1. Sign up at [n8n.cloud](https://n8n.cloud)
2. Create new workflow

### Option B: Self-Hosted

```bash
docker run -it --rm \
  --name n8n \
  -p 5678:5678 \
  -v ~/.n8n:/home/node/.n8n \
  n8nio/n8n
```

### Import Workflows

1. In n8n, click **Workflows** → **Add Workflow**
2. Click **⋮** → **Import from File**
3. Import from `n8n-workflows/` directory:
   - `document-processing.json` (when available)
   - `query-rag.json` (when available)
   - `telegram-bot.json` (when available)

### Configure Credentials in n8n

**Supabase:**

- Type: HTTP Request Credential (or use Supabase community node)
- URL: `https://kvgbhaqtvdrdlafbucdw.supabase.co`
- API Key (Header): `Authorization: Bearer <service_role_key>`

**OpenAI:**

- Type: OpenAI
- API Key: Your OpenAI key

**Telegram:**

- Type: Telegram
- Access Token: Your bot token

### Get Webhook URLs

After creating workflows:

1. Open each workflow
2. Click the Webhook node
3. Copy the **Test URL** (for development) or **Production URL**
4. Save these URLs for backend configuration

---

## 5. Backend Setup

```bash
cd backend

# Copy environment template
cp .env.example .env

# Edit .env with your values
nano .env
```

**.env configuration:**

```bash
# Supabase
SUPABASE_URL=https://kvgbhaqtvdrdlafbucdw.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<your_service_role_key>
SUPABASE_ANON_KEY=<your_anon_key>

# Server
PORT=3001
NODE_ENV=development

# OpenAI (for embeddings and chat)
OPENAI_API_KEY=<your_openai_api_key>

# n8n Webhooks (optional - now handled by backend)
N8N_WEBHOOK_URL=https://your-n8n-instance.app.n8n.cloud/webhook
N8N_UPLOAD_WEBHOOK=https://your-n8n-instance.app.n8n.cloud/webhook/upload-document
N8N_QUERY_WEBHOOK=https://your-n8n-instance.app.n8n.cloud/webhook/query
N8N_API_KEY=generate_a_secure_random_key_here

# Telegram
TELEGRAM_BOT_TOKEN=<your_telegram_bot_token>

# JWT Secret (for Telegram linking)
JWT_SECRET=generate_a_secure_random_secret_here

# CORS
CORS_ORIGIN=http://localhost:3000
```

**Install and run:**

```bash
npm install
npm run dev
```

Backend should start on `http://localhost:3001`

---

## 6. Frontend Setup

```bash
cd frontend

# Copy environment template
cp .env.local.example .env.local

# Edit .env.local
nano .env.local
```

**.env.local configuration:**

```bash
# Supabase
NEXT_PUBLIC_SUPABASE_URL=https://kvgbhaqtvdrdlafbucdw.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<your_anon_key>

# API
NEXT_PUBLIC_API_URL=http://localhost:3001
```

**Install and run:**

```bash
npm install
npm run dev
```

Frontend should start on `http://localhost:3000`

---

## 7. Testing the Setup

### Test 1: Admin Login

1. Open `http://localhost:3000`
2. Should redirect to `/login`
3. Login with admin credentials set in Supabase
4. Should redirect to `/admin/dashboard`

### Test 2: Create User

1. In admin dashboard, go to **Users**
2. Create a new user with email `test@example.com`
3. Copy the magic link
4. Open magic link in incognito/private window
5. Set password and login
6. Should see chat interface

### Test 3: Upload Document

1. Login as admin
2. Go to **Documents**
3. Upload a PDF (start with a small one, < 5 pages)
4. Watch status change: Pending → Processing → Ready
5. Check n8n execution logs for any errors

### Test 4: Query Document

1. Login as regular user
2. Ask a question related to uploaded document
3. Should receive answer with source citations
4. Check that message appears in chat history

### Test 5: Telegram Integration

1. Find your bot on Telegram
2. Send `/start`
3. Send `/link`
4. Open the link while logged into web app
5. Confirm linking
6. Send a query to bot
7. Should receive answer with sources

---

## 8. Troubleshooting

### Backend won't start

- Check all .env values are set
- Verify Supabase keys are correct
- Check port 3001 not in use: `lsof -i :3001`

### Frontend won't compile

- Run `npm install` again
- Check Node.js version: `node -v` (should be 18+)
- Clear Next.js cache: `rm -rf .next`

### Can't login

- Verify user exists in Supabase: `SELECT * FROM auth.users;`
- Check profile created: `SELECT * FROM profiles;`
- Check browser console for errors

### Document upload fails

- Verify Supabase Storage bucket exists
- Check storage policies allow upload
- Verify n8n webhook URL is correct
- Check n8n execution logs

### No RAG results

- Verify document status is 'ready'
- Check document_chunks table has embeddings
- Run test query in Supabase:
  ```sql
  SELECT COUNT(*) FROM document_chunks WHERE embedding IS NOT NULL;
  ```

### Telegram bot not responding

- Verify bot token is correct
- Check n8n Telegram workflow is activated
- Test with `/start` command first

---

## 9. Production Deployment

### Frontend (Vercel)

```bash
cd frontend
npm run build
vercel --prod
```

Update env vars in Vercel dashboard.

### Backend (Railway/Render/Heroku)

```bash
cd backend
npm run build

# Deploy to your platform of choice
# Set environment variables in platform dashboard
```

### n8n

- Use n8n Cloud (easiest)
- Or deploy self-hosted with Docker Compose
- Update webhook URLs in backend .env

---

## 10. Next Steps

- [ ] Add more documents
- [ ] Create more user accounts
- [ ] Monitor analytics
- [ ] Set up production domain
- [ ] Configure email service for magic links
- [ ] Set up monitoring/alerting
- [ ] Backup strategy for Supabase

---

## Support

For issues, check:

- Backend logs: `backend/` console
- Frontend console: Browser DevTools
- n8n execution logs: n8n dashboard
- Supabase logs: Supabase dashboard → Logs
