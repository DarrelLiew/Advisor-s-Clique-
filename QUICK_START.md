# Quick Start Guide

Start here! Follow these steps in order to get your AI chatbot running.

## ✅ What's Already Done

- ✅ Database schema created in Supabase
- ✅ Frontend and backend code implemented
- ✅ Supabase anon key configured
- ✅ Project structure set up

## 🚀 What You Need To Do (30-40 minutes total)

### 1. Get Your Service Role Key (2 min)

1. Go to [Supabase Dashboard](https://supabase.com/dashboard/project/kvgbhaqtvdrdlafbucdw/settings/api)
2. Scroll to "Project API keys"
3. Copy the **`service_role`** key (⚠️ Keep this secret!)
4. Open `backend/.env`
5. Replace `YOUR_SERVICE_ROLE_KEY_FROM_SUPABASE_DASHBOARD` with your key

### 2. Create Storage Bucket (3 min)

1. Go to [Supabase Storage](https://supabase.com/dashboard/project/kvgbhaqtvdrdlafbucdw/storage/buckets)
2. Click "Create bucket"
3. Name: `documents`
4. Set to **Private** (not public)
5. Click "Create"

### 3. Create Your Admin Account (2 min)

1. Go to [Supabase SQL Editor](https://supabase.com/dashboard/project/kvgbhaqtvdrdlafbucdw/sql/new)
2. Paste this (replace with your email/password):

```sql
-- Create admin user
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
  confirmation_token
) VALUES (
  '00000000-0000-0000-0000-000000000000',
  gen_random_uuid(),
  'authenticated',
  'authenticated',
  'your-email@example.com',  -- ⬅️ CHANGE THIS
  crypt('YourPassword123!', gen_salt('bf')),  -- ⬅️ CHANGE THIS
  NOW(),
  '{"role": "admin"}'::jsonb,
  NOW(),
  NOW(),
  ''
) RETURNING id;
```

3. Click "Run"
4. Copy the `id` that's returned (you'll need it for the next step)
5. Run this (replace YOUR_USER_ID with the id from step 4):

```sql
-- Make user admin
UPDATE profiles SET role = 'admin' WHERE id = 'YOUR_USER_ID';
```

### 4. Get OpenAI API Key (3 min)

1. Go to [OpenAI API Keys](https://platform.openai.com/api-keys)
2. Click "Create new secret key"
3. Copy the key (starts with `sk-`)
4. Save it for step 7 (n8n setup)

### 5. Create Telegram Bot (5 min)

1. Open Telegram
2. Search for `@BotFather`
3. Send: `/newbot`
4. Follow prompts:
   - Bot name: "Advisors Clique Bot"
   - Username: something like `your_advisors_bot`
5. Copy the **token** (looks like `1234567890:ABCdef...`)
6. Save for next steps

7. Set bot commands:

```
/setcommands
start - Start conversation
link - Link Telegram account
help - Get help
```

### 6. Set Up n8n (10 min)

**Option A: Use n8n Cloud (Recommended)**

1. Go to [n8n.cloud](https://n8n.cloud)
2. Sign up (free trial available)
3. Create new workflow

**Option B: Run Locally**

```bash
docker run -it --rm --name n8n -p 5678:5678 n8nio/n8n
# Then open http://localhost:5678
```

### 7. Create n8n Workflows (15-20 min)

Follow the detailed instructions in [`n8n-workflows/README.md`](n8n-workflows/README.md)

**You need to create 3 workflows:**

1. Document Processing (upload webhook)
2. Query & RAG (query webhook)
3. Telegram Bot (telegram trigger)

**After creating each workflow:**

- Copy the webhook URL
- Save for step 8

### 8. Configure Backend Environment (3 min)

Open `backend/.env` and fill in these values:

```bash
# From step 1 (already done if you followed step 1)
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key

# From step 7 (n8n webhook URLs)
N8N_UPLOAD_WEBHOOK=https://your-n8n-url/webhook/upload-document
N8N_QUERY_WEBHOOK=https://your-n8n-url/webhook/query

# Generate a random string (32+ characters)
N8N_API_KEY=paste_this_random_key_here_at_least_32_chars

# From step 5 (Telegram bot token)
TELEGRAM_BOT_TOKEN=1234567890:ABCdef...

# Generate another random string
JWT_SECRET=another_random_key_here_at_least_32_chars
```

**To generate random keys (run in terminal):**

```bash
# On Mac/Linux:
openssl rand -hex 32

# On Windows (PowerShell):
[Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Minimum 0 -Maximum 256 }))
```

### 9. Install Dependencies (5 min)

```bash
# In the root project folder:
cd "c:\Users\Darre\Code\Adivsors Clique"

# Install root dependencies
npm install

# Install backend dependencies
cd backend
npm install

# Install frontend dependencies
cd ../frontend
npm install
```

### 10. Start the Application! (2 min)

Open **two terminal windows**:

**Terminal 1 - Backend:**

```bash
cd "c:\Users\Darre\Code\Adivsors Clique\backend"
npm run dev
```

Wait for: `🚀 Server running on port 3001`

**Terminal 2 - Frontend:**

```bash
cd "c:\Users\Darre\Code\Adivsors Clique\frontend"
npm run dev
```

Wait for: `✓ Ready in X.Xs`

### 11. Test It! (10 min)

1. Open http://localhost:3000
2. Login with your admin credentials (from step 3)
3. You should see the admin dashboard
4. Click "Documents"
5. Upload a small PDF (2-5 pages)
6. Watch the status change to "Processing" then "Ready"
7. Click "Users" → Create a test user
8. Copy the magic link
9. Open in incognito/private window
10. Set password and login
11. You should see the chat interface
12. Ask a question about your uploaded PDF
13. You should get an answer with page citations!

**Test Telegram:**

1. Find your bot on Telegram
2. Send `/start`
3. Send `/link`
4. Open the link (while logged into web app)
5. Confirm linking
6. Send a question
7. Get answer with sources!

---

## 🆘 Troubleshooting

### "Backend won't start"

- Check all values in `backend/.env` are filled in
- Make sure service_role key is correct
- Try: `cd backend && rm -rf node_modules && npm install`

### "Can't login"

- Verify you created the admin user in Supabase
- Check the email/password are correct
- Look for errors in browser console (F12)

### "Document stuck in Processing"

- Check n8n workflow is activated
- Check n8n execution logs for errors
- Verify OpenAI API key is working
- Check webhook URL is correct in `backend/.env`

### "No answer from chatbot"

- Verify document status is "Ready"
- Check n8n Query workflow is activated
- Look at n8n execution logs
- Check backend terminal for errors

### "Telegram bot not responding"

- Verify Telegram workflow is activated in n8n
- Check bot token is correct
- Try `/start` first before other commands

---

## 📚 Additional Resources

- **Full Setup Guide:** [`docs/SETUP.md`](docs/SETUP.md)
- **n8n Workflows:** [`n8n-workflows/README.md`](n8n-workflows/README.md)
- **Project Status:** [`PROJECT_STATUS.md`](PROJECT_STATUS.md)
- **Main README:** [`README.md`](README.md)

---

## 🎉 Success Checklist

- [ ] Database schema created ✅ (already done)
- [ ] Admin account created
- [ ] Service role key configured
- [ ] Storage bucket created
- [ ] OpenAI API key obtained
- [ ] Telegram bot created
- [ ] n8n workflows created and activated
- [ ] Backend .env configured
- [ ] Dependencies installed
- [ ] Backend running on port 3001
- [ ] Frontend running on port 3000
- [ ] Can login as admin
- [ ] Can upload document
- [ ] Document processes to "Ready"
- [ ] Can create regular user
- [ ] User can ask questions
- [ ] Chatbot returns answers with page citations
- [ ] Telegram bot responds
- [ ] Telegram account linking works
- [ ] Can query via Telegram

---

## Next Steps After Everything Works

1. Upload more documents
2. Create more user accounts
3. Test question analytics
4. Plan production deployment
5. Set up monitoring

---

**Need help?** Check the troubleshooting section or refer to the full setup guide!

**Ready to deploy?** See section 9 in [`docs/SETUP.md`](docs/SETUP.md)
