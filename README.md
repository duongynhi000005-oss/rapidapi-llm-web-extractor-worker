# LLM-Ready Web-to-Markdown, JSON-LD & Email Extractor API

Sub-100ms global edge API running on Cloudflare Workers. Built for RapidAPI Hub monetization.

## Endpoints
- `POST /v1/extract`: Full extraction (Markdown + Schema.org + OpenGraph + Email addresses)
- `GET /v1/extract?url=https://example.com`: Quick single-URL fetch
- `GET /v1/health`: Health status & Cloudflare edge colo code

## Deployment
```bash
npm install
npx wrangler deploy
```
Import `openapi-rapidapi.json` into RapidAPI Provider Dashboard with 1 click.
