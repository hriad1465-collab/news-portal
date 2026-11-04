
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const mysql = require('mysql2/promise');
const slugify = require('slugify');
const { v2: cloudinary } = require('cloudinary');

const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 10000;
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  console.error('ERROR: JWT_SECRET is missing in Environment Variables');
}

/* =========================
   CLOUDINARY CONFIGURATION
========================= */

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

/* =========================
   TIDB DATABASE CONNECTION
========================= */

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 4000),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 5,
  ssl: {
    minVersion: 'TLSv1.2'
  }
});

/* =========================
   DATABASE INITIALIZATION
========================= */

async function initDB() {
  const c = await pool.getConnection();

  try {

    // ADMIN TABLE
    await c.query(`
      CREATE TABLE IF NOT EXISTS admins (
        id INT AUTO_INCREMENT PRIMARY KEY,
        email VARCHAR(190) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // NEWS TABLE
    await c.query(`
      CREATE TABLE IF NOT EXISTS news (
        id INT AUTO_INCREMENT PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        slug VARCHAR(300) UNIQUE NOT NULL,
        summary TEXT,
        content LONGTEXT,
        category VARCHAR(100) DEFAULT 'জাতীয়',
        author VARCHAR(150) DEFAULT 'ডেস্ক রিপোর্ট',
        cover_url TEXT,
        video_url TEXT,
        status ENUM('draft','published') DEFAULT 'draft',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          ON UPDATE CURRENT_TIMESTAMP,
        INDEX(status),
        INDEX(category)
      )
    `);

    // OLD DATABASE MIGRATION
    // summary column না থাকলে তৈরি করবে

    const [summaryColumn] = await c.query(`
      SHOW COLUMNS FROM news LIKE 'summary'
    `);

    if (summaryColumn.length === 0) {
      await c.query(`
        ALTER TABLE news ADD COLUMN summary TEXT
      `);

      console.log('summary column successfully added');
    }

    // ADMIN ACCOUNT SYNC

    const adminEmail = (
      process.env.ADMIN_EMAIL ||
      process.env.ADMIN_USERNAME ||
      ''
    ).trim().toLowerCase();

    const adminPassword = process.env.ADMIN_PASSWORD;

    if (!adminEmail || !adminPassword) {
      throw new Error(
        'ADMIN_EMAIL/ADMIN_USERNAME অথবা ADMIN_PASSWORD Environment-এ সেট করুন'
      );
    }

    const passwordHash = await bcrypt.hash(
      adminPassword,
      12
    );

    await c.query(
      `INSERT INTO admins (email, password_hash)
       VALUES (?, ?)
       ON DUPLICATE KEY UPDATE
       password_hash = VALUES(password_hash)`,
      [adminEmail, passwordHash]
    );

    console.log('Admin account synchronized:', adminEmail);
    console.log('TiDB database initialized successfully');

  } finally {
    c.release();
  }
}

/* =========================
   ADMIN AUTHENTICATION
========================= */

function auth(req, res, next) {

  const token = (req.headers.authorization || '')
    .replace(/^Bearer /, '');

  try {

    req.admin = jwt.verify(token, JWT_SECRET);
    next();

  } catch (e) {

    res.status(401).json({
      error: 'অনুগ্রহ করে Admin হিসেবে লগইন করুন'
    });

  }
}

/* =========================
   FILE UPLOAD
========================= */

const uploadDir = path.join(__dirname, 'uploads');

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const disk = multer({
  dest: uploadDir,
  limits: {
    fileSize: 100 * 1024 * 1024
  }
});

async function uploadFile(req, res, next) {

  if (!req.file) {
    return res.status(400).json({
      error: 'ফাইল নির্বাচন করুন'
    });
  }

  try {

    if (process.env.CLOUDINARY_CLOUD_NAME) {

      const result = await cloudinary.uploader.upload(
        req.file.path,
        {
          resource_type: 'auto',
          folder: 'news-portal'
        }
      );

      fs.unlink(req.file.path, () => {});

      return res.json({
        url: result.secure_url,
        type: result.resource_type
      });

    }

    res.json({
      url: '/uploads/' + req.file.filename,
      type: req.file.mimetype.startsWith('video/')
        ? 'video'
        : 'image',
      warning: 'Local upload: Render restart/redeploy এ ফাইল মুছে যেতে পারে। Cloudinary configure করুন।'
    });

  } catch (e) {

    next(e);

  }
}

app.use('/uploads', express.static(uploadDir));

/* =========================
   ADMIN LOGIN API
========================= */

app.post('/api/admin/login', async (req, res) => {

  try {

    if (!JWT_SECRET) {
      return res.status(500).json({
        error: 'Server JWT_SECRET সেট করা নেই'
      });
    }

    const email = String(
      req.body.email || req.body.username || ''
    ).trim().toLowerCase();

    const password = req.body.password;

    if (!email || !password) {
      return res.status(400).json({
        error: 'Email এবং password দিন'
      });
    }

    const [rows] = await pool.query(
      'SELECT * FROM admins WHERE email = ? LIMIT 1',
      [email]
    );

    if (
      !rows.length ||
      !await bcrypt.compare(
        String(password),
        rows[0].password_hash
      )
    ) {
      return res.status(401).json({
        error: 'Email বা password ভুল'
      });
    }

    const token = jwt.sign(
      {
        id: rows[0].id,
        email: rows[0].email
      },
      JWT_SECRET,
      {
        expiresIn: '12h'
      }
    );

    console.log('Admin login successful:', email);

    res.json({
      success: true,
      token,
      email: rows[0].email
    });

  } catch (e) {

    console.error('Login error:', e);

    res.status(500).json({
      error: 'Login failed'
    });

  }

});

/* =========================
   PUBLIC NEWS API
========================= */

app.get('/api/news', async (req, res) => {

  try {

    const {
      category,
      q,
      limit = '50'
    } = req.query;

    let sql = `
      SELECT id,title,slug,summary,content,category,
      author,cover_url,video_url,status,created_at
      FROM news WHERE status='published'
    `;

    const p = [];

    if (category) {
      sql += ' AND category=?';
      p.push(category);
    }

    if (q) {
      sql += ' AND (title LIKE ? OR summary LIKE ?)';
      p.push('%' + q + '%', '%' + q + '%');
    }

    sql +=
      ' ORDER BY created_at DESC LIMIT ' +
      Math.min(100, Math.max(1, Number(limit) || 50));

    const [rows] = await pool.query(sql, p);

    res.json(rows);

  } catch (e) {

    console.error('News load error:', e);

    res.status(500).json({
      error: 'News load failed'
    });

  }

});

app.get('/api/news/:slug', async (req, res) => {

  try {

    const [rows] = await pool.query(
      "SELECT * FROM news WHERE slug=? AND status='published'",
      [req.params.slug]
    );

    if (!rows.length) {
      return res.status(404).json({
        error: 'News not found'
      });
    }

    res.json(rows[0]);

  } catch (e) {

    console.error('News details error:', e);

    res.status(500).json({
      error: 'News load failed'
    });

  }

});

/* =========================
   ADMIN NEWS LIST API
========================= */

app.get('/api/admin/news', auth, async (req, res) => {

  try {

    const [rows] = await pool.query(
      'SELECT * FROM news ORDER BY created_at DESC'
    );

    res.json(rows);

  } catch (e) {

    console.error('Admin news load error:', e);

    res.status(500).json({
      error: 'News load failed'
    });

  }

});

/* =========================
   ADMIN FILE UPLOAD API
========================= */

app.post(
  '/api/admin/upload',
  auth,
  disk.single('file'),
  uploadFile
);

/* =========================
   CREATE / PUBLISH NEWS
========================= */

app.post('/api/admin/news', auth, async (req, res) => {

  try {

    const n = req.body;

    if (!n.title || !String(n.title).trim()) {
      return res.status(400).json({
        error: 'নিউজের শিরোনাম লিখুন'
      });
    }

    if (!n.content || !String(n.content).trim()) {
      return res.status(400).json({
        error: 'নিউজের বিস্তারিত লিখুন'
      });
    }

    const slug =
      slugify(String(n.title), {
        lower: true,
        strict: true
      }) + '-' + Date.now();

    const [r] = await pool.query(
      `INSERT INTO news
      (title,slug,summary,content,category,author,
      cover_url,video_url,status)
      VALUES(?,?,?,?,?,?,?,?,?)`,
      [
        String(n.title).trim(),
        slug,
        n.summary || String(n.content).substring(0, 200),
        n.content || '',
        n.category || 'জাতীয়',
        n.author || 'ডেস্ক রিপোর্ট',
        n.cover_url || n.image || '',
        n.video_url || '',
        n.status === 'draft' ? 'draft' : 'published'
      ]
    );

    console.log('News published:', r.insertId);

    res.json({
      success: true,
      id: r.insertId,
      slug: slug,
      message: 'নিউজ সফলভাবে প্রকাশ হয়েছে'
    });

  } catch (e) {

    console.error('News save error:', e);

    res.status(500).json({
      error: 'News save failed: ' + e.message
    });

  }

});

/* =========================
   UPDATE NEWS
========================= */

app.put('/api/admin/news/:id', auth, async (req, res) => {

  try {

    const n = req.body;

    if (!n.title || !String(n.title).trim()) {
      return res.status(400).json({
        error: 'নিউজের শিরোনাম লিখুন'
      });
    }

    if (!n.content || !String(n.content).trim()) {
      return res.status(400).json({
        error: 'নিউজের বিস্তারিত লিখুন'
      });
    }

    const [result] = await pool.query(
      `UPDATE news SET
      title=?,
      summary=?,
      content=?,
      category=?,
      author=?,
      cover_url=?,
      video_url=?,
      status=?
      WHERE id=?`,
      [
        String(n.title).trim(),
        n.summary || String(n.content).substring(0, 200),
        n.content || '',
        n.category || 'জাতীয়',
        n.author || 'ডেস্ক রিপোর্ট',
        n.cover_url || n.image || '',
        n.video_url || '',
        n.status === 'draft' ? 'draft' : 'published',
        req.params.id
      ]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        error: 'নিউজটি পাওয়া যায়নি'
      });
    }

    res.json({
      success: true,
      message: 'নিউজ সফলভাবে আপডেট হয়েছে'
    });

  } catch (e) {

    console.error('News update error:', e);

    res.status(500).json({
      error: 'Update failed: ' + e.message
    });

  }

});

/* =========================
   DELETE NEWS
========================= */

app.delete('/api/admin/news/:id', auth, async (req, res) => {

  try {

    const [result] = await pool.query(
      'DELETE FROM news WHERE id=?',
      [req.params.id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        error: 'নিউজটি পাওয়া যায়নি'
      });
    }

    res.json({
      success: true,
      message: 'নিউজ সফলভাবে মুছে ফেলা হয়েছে'
    });

  } catch (e) {

    console.error('News delete error:', e);

    res.status(500).json({
      error: 'Delete failed: ' + e.message
    });

  }

});

/* =========================
   HEALTH CHECK
========================= */

app.get('/api/health', async (req, res) => {

  try {

    await pool.query('SELECT 1');

    res.json({
      ok: true,
      database: 'connected'
    });

  } catch (e) {

    console.error('Health check error:', e);

    res.status(500).json({
      ok: false,
      database: 'error'
    });

  }

});

/* =========================
   FRONTEND
========================= */

// Express 4 ও Express 5 উভয়ের জন্য
app.get(/.*/, (req, res, next) => {

  if (req.path.startsWith('/api/')) {
    return next();
  }

  res.sendFile(
    path.join(__dirname, 'public', 'index.html')
  );

});

/* =========================
   ERROR HANDLER
========================= */

app.use((err, req, res, next) => {

  console.error('Server error:', err);

  res.status(500).json({
    error: 'Server error: ' + err.message
  });

});

/* =========================
   START SERVER
========================= */

async function startServer() {

  try {

    if (!JWT_SECRET) {
      throw new Error('JWT_SECRET Environment Variable missing');
    }

    await initDB();

    app.listen(PORT, () => {
      console.log('Server running on port ' + PORT);
    });

  } catch (e) {

    console.error('Server startup error:', e);

    process.exit(1);

  }

}

startServer();
