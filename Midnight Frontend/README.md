# The Midnight News

Serverless TanStack Start site backed by MongoDB, built for Vercel.

## Deploy on Vercel

1. Import the repository in Vercel (framework preset: Other; build command `vite build` is picked up from package.json).
2. In Settings → Environment Variables add `MONGODB_URI` and `COMMUNITY_ENCRYPTION_KEY` (see `.env.example`).
3. Deploy.

## Local development

Copy `.env.example` to `.env`, fill in the values, then run `bun install` and `bun run dev`.
