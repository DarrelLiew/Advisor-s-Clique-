# CLAUDE.md

This file provides guidance to Claude Code when working with this repository.

---

# Project Overview

Advisors Clique is a **RAG-powered AI assistant for financial advisors**.

Users ask questions about uploaded PDF documents and receive answers with page citations.

The system supports:

- Web application (Next.js)
- Telegram bot (webhook via Express)

---

# Tech Stack

## Frontend

- Next.js 14 (App Router)
- React 18
- TailwindCSS
- Supabase Auth (`@supabase/ssr`)

## Backend

- Express.js + TypeScript
- OpenAI
  - `gpt-4o-mini` (generation)
  - `text-embedding-3-small` (embeddings)
- Supabase service-role client

## Database

- Supabase PostgreSQL
- pgvector (1536-dim embeddings)
- Row Level Security enabled

## Bot

Telegram webhook handled inside the Express backend.

## Monorepo

Root `package.json` runs frontend and backend concurrently.

---

# Development Commands

Install dependencies:

```bash
npm run install:all
```
