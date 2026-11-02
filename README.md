# Bangla News Portal (Render + TiDB + GitHub)

## Included
- Public news homepage, search/category query, single news detail page
- Admin login, create/edit/delete, draft/publish
- Image/video upload endpoint (Cloudinary recommended)
- TiDB MySQL-compatible schema auto-created on server startup
- JWT authentication, bcrypt password hash

## 1. GitHub
Create a repository, upload this project folder, and commit. Do not upload `.env` or real credentials.

## 2. TiDB Cloud
1. Create a TiDB Cloud Serverless cluster and a database named `news_portal`.
2. Get connection details from **Connect**. Copy host, port, username and password.
3. Configure TLS/SSL as required by TiDB Cloud.
4. Tables (`admins`, `news`) are created automatically at startup.

## 3. Render deploy
1. Render → New → Web Service → connect GitHub repository.
2. Runtime: Node. Build command: `npm install`. Start command: `npm start`.
3. Add environment variables in Render (Environment):
   - `PORT` = `10000`
   - `JWT_SECRET` = long random secret
   - `ADMIN_EMAIL` = your admin email
   - `ADMIN_PASSWORD` = strong initial password
   - `DB_HOST`, `DB_PORT` (usually 4000), `DB_USER`, `DB_PASSWORD`, `DB_NAME` (`news_portal`), `DB_SSL` (`true`)
4. Deploy. Open `/admin.html` and login with ADMIN_EMAIL/ADMIN_PASSWORD.
5. Health check: `/api/health`

**Security:** Set a strong password and secret. Once admin is created, changing `ADMIN_PASSWORD` in Render does not reset its DB password. Change it manually in DB or implement a password-change feature. Never share environment values.

## 4. Media storage (important)
Render's local filesystem is ephemeral. Uploaded files saved locally can disappear on redeploy/restart. For persistent uploads:
1. Create a Cloudinary account.
2. Set `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` in Render.
3. Upload images/videos in Admin. Cloudinary returns permanent HTTPS URLs saved in news records.
Without Cloudinary configured, upload is temporary local storage (only suitable for testing).

## 5. Facebook publishing
This starter does **not** automatically publish posts to Facebook. Facebook publishing requires a Meta app, Facebook Page, Page access token with relevant permissions, and usually App Review/business verification depending on use. Add the Page publishing integration only after configuring credentials securely. For now, copy the article URL and share it on your Page. Do not put tokens in frontend code.

## Notes
- This is a starter MVP, not a hardened production CMS. Before public launch add rate limiting, CSRF/security headers, password reset/change, role management, backups, editorial workflow, and proper media validation.
- Upload max size is 100 MB.
- Video embeds are supported via a direct video URL; uploaded video uses Cloudinary.
