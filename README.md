# WordPress Media SEO Optimizer (Safe In-Place Overwrite)

This project now includes a production-oriented CLI + minimal dashboard to SEO-optimize and compress existing WordPress/WooCommerce media images **without changing attachment ID, URL, filename, extension, or uploads relative path**.

A new UI tab `媒体库SEO压缩` has also been added to the app (`App.tsx`) as an operational entry panel.

## Guarantees

- Keeps attachment ID unchanged.
- Keeps `source_url` unchanged.
- Keeps filename unchanged.
- Keeps file extension unchanged.
- Overwrites at exact path under `wp-content/uploads/YYYY/MM/filename.ext`.
- Stores local backup before overwrite for rollback.
- Supports dry-run, pagination, concurrency limits, retries, and resume by SQLite state.

## Implemented Structure

- `src/wp.ts` - WordPress REST client (scan, metadata update, download)
- `src/sftp.ts` - SFTP backup/overwrite/verification
- `src/optimize.ts` - same-extension image compression with `sharp`
- `src/seo.ts` - pluggable SEO generator (deterministic stub enabled)
- `src/db.ts` - SQLite state/cache/snapshots/runs
- `src/cli.ts` - commands: `scan`, `run`, `rollback`, `report`, `dashboard`

## Prerequisites

- Node.js 20+
- Access to WordPress REST API
- WordPress Application Password (recommended default auth)
- SFTP access to WordPress host (Cloudways-compatible)

If Cloudflare is enabled, treat SFTP as the primary replacement path. Custom `POST /wp-json/lenscraft/v1/media/*/replace` requests can be blocked by a managed challenge even when normal REST `GET` requests still work.

## Installation

```bash
npm install
```

## Environment

Copy `.env.example` to `.env` and fill values.

Required key settings:

- `WP_BASE_URL`
- `WP_USER`
- `WP_APP_PASSWORD` (or `WP_JWT`)
- `SFTP_HOST`
- `SFTP_USER`
- `REMOTE_WP_ROOT`
- `UPLOADS_RELATIVE` (default: `wp-content/uploads`)

## Commands

```bash
# 1) Scan media library into local SQLite state
npm run media:scan

# 2) Execute pipeline (recommended to run dry-run first)
npm run media:run -- --dry-run true
npm run media:run -- --dry-run false

# 3) Rollback specific media IDs
npm run media:rollback -- --ids 123,456

# 4) Report
npm run media:report

# 5) Minimal local dashboard
npm run media:dashboard
# open http://127.0.0.1:8787
```

Filter examples:

```bash
npm run media:run -- --mime webp --min-size-kb 120 --limit 500
npm run media:run -- --ids 101,202,303
npm run media:run -- --since 2026-01-01T00:00:00Z
```

## Cloudways + WP Application Password Setup

1. In WordPress Admin, create an Application Password for a user with media edit permissions.
2. Set `.env`:
   - `WP_BASE_URL=https://your-site.com`
   - `WP_USER=your_wp_user`
   - `WP_APP_PASSWORD=xxxx xxxx xxxx xxxx xxxx xxxx`
3. In Cloudways panel, confirm SFTP credentials and application path.
4. Set:
   - `REMOTE_WP_ROOT=/home/master/applications/<app_id>/public_html`
   - `UPLOADS_RELATIVE=wp-content/uploads`
5. Run dry-run first:
   - `npm run media:run -- --dry-run true`
6. Verify report and then run real overwrite:
   - `npm run media:run -- --dry-run false`
7. Purge caches after completed run:
   - WP Rocket
   - Cloudways Varnish
   - Cloudflare (if enabled)

If you still want to try `--use-rest-replace`, add a Cloudflare bypass rule for `/wp-json/lenscraft/v1/media/*` from your runner IP. Otherwise the CLI now falls back to SFTP automatically when both transports are configured.

## Safety and Rollback

- Every overwrite first downloads remote original file to `backup/remote/{mediaId}/filename.ext`.
- Previous metadata is snapshot-saved in SQLite.
- `rollback` uploads backup to original remote path and restores old metadata.

## Acceptance Checklist

- WooCommerce product image still displays after run.
- Attachment ID unchanged.
- `source_url` unchanged.
- Majority of images are smaller where optimization is possible.
- SEO fields in Media Library are updated.
