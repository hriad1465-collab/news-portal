
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

/* CLOUDINARY CONFIGURATION */

const CLOUDINARY_READY = Boolean(
  process.env.CLOUDINARY_CLOUD_NAME &&
  process.env.CLOUDINARY_API_KEY &&
  process.env.CLOUDINARY_API_SECRET
);

if (CLOUDINARY_READY) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true
  });

  console.log('Cloudinary configured successfully');
} else {
  console.error('WARNING: Cloudinary credentials are incomplete');
}

/* DATABASE */

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 4000),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 5,
  ssl: { minVersion: 'TLSv1.2' }
});

/* DATABASE INITIALIZATION */

async function initDB() {
  const c = await pool.getConnection();

  try {
    await c.query(`
      CREATE TABLE IF NOT EXISTS admins (
        id INT AUTO_INCREMENT PRIMARY KEY,
        email VARCHAR(190) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

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

    const migrations = [
      ['summary', 'TEXT NULL'],
      ['content', 'LONGTEXT NULL'],
      ['category', "VARCHAR(100) DEFAULT 'জাতীয়'"],
      ['author', "VARCHAR(150) DEFAULT 'ডেস্ক রিপোর্ট'"],
      ['cover_url', 'TEXT NULL'],
      ['video_url', 'TEXT NULL'],
      ['status', "ENUM('draft','published') DEFAULT 'draft'"],
      ['created_at', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP'],
      ['updated_at', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP']
    ];

    for (const [column, definition] of migrations) {
      const [found] = await c.query(
        'SHOW COLUMNS FROM news LIKE ?',
        [column]
      );

      if (!found.length) {
        await c.query(
          `ALTER TABLE news ADD COLUMN \`${column}\` ${definition}`
        );
        console.log('Added news.' + column);
      }
    }

    const adminEmail = String(
      process.env.ADMIN_EMAIL ||
      process.env.ADMIN_USERNAME ||
      ''
    ).trim().toLowerCase();

    const adminPassword = process.env.ADMIN_PASSWORD;

    if (!adminEmail || !adminPassword) {
      throw new Error(
        'ADMIN_USERNAME/ADMIN_EMAIL এবং ADMIN_PASSWORD সেট করুন'
      );
    }

    const passwordHash = await bcrypt.hash(adminPassword, 12);

    await c.query(
      `INSERT INTO admins (email,password_hash)
       VALUES (?,?)
       ON DUPLICATE KEY UPDATE
       password_hash=VALUES(password_hash)`,
      [adminEmail, passwordHash]
    );

    console.log('Admin synchronized:', adminEmail);
    console.log('Database initialized');

  } finally {
    c.release();
  }
}

/* AUTHENTICATION */

function auth(req, res, next) {
  if (!JWT_SECRET) {
    return res.status(500).json({
      error: 'JWT_SECRET missing'
    });
  }

  const token = (req.headers.authorization || '')
    .replace(/^Bearer\s+/i, '');

  try {
    req.admin = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({
      error: 'অনুগ্রহ করে Admin Login করুন'
    });
  }
}

/* TEMPORARY UPLOAD DIRECTORY */

const uploadDir = path.join(__dirname, 'uploads');

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

/* MULTER CONFIGURATION */

const disk = multer({
  dest: uploadDir,

  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 1
  },

  fileFilter: (req, file, cb) => {
    if (!file.mimetype || !file.mimetype.startsWith('image/')) {
      return cb(new Error('শুধুমাত্র Image Upload করা যাবে'));
    }

    cb(null, true);
  }
});

/* DELETE TEMPORARY FILE */

function removeTempFile(filePath) {
  if (!filePath) return;

  fs.unlink(filePath, (err) => {
    if (err && err.code !== 'ENOENT') {
      console.error('Temporary file cleanup error:', err);
    }
  });
}

/* CLOUDINARY IMAGE UPLOAD */

async function uploadFile(req, res, next) {
  if (!req.file) {
    return res.status(400).json({
      success: false,
      error: 'ছবি নির্বাচন করুন'
    });
  }

  const tempPath = req.file.path;

  try {

    // Cloudinary credentials বাধ্যতামূলক
    if (!CLOUDINARY_READY) {
      return res.status(503).json({
        success: false,
        error: 'Cloudinary সেটআপ সম্পূর্ণ হয়নি। Render Environment পরীক্ষা করুন।'
      });
    }

    // Cloudinary-তে স্থায়ীভাবে আপলোড
    const result = await cloudinary.uploader.upload(
      tempPath,
      {
        resource_type: 'image',
        folder: 'news-portal',
        quality: 'auto',
        fetch_format: 'auto'
      }
    );

    if (!result || !result.secure_url) {
      throw new Error('Cloudinary থেকে Image URL পাওয়া যায়নি');
    }

    // অস্থায়ী ফাইল মুছে ফেলা
    removeTempFile(tempPath);

    console.log('Image uploaded:', result.secure_url);

    return res.status(200).json({
      success: true,
      url: result.secure_url,
      public_id: result.public_id,
      type: 'image',
      message: 'ছবি সফলভাবে Upload হয়েছে'
    });

  } catch (error) {

    removeTempFile(tempPath);

    console.error('Cloudinary Upload Error:', error);

    return res.status(500).json({
      success: false,
      error: 'ছবি Upload ব্যর্থ হয়েছে: ' + error.message
    });
  }
}

/* ADMIN LOGIN */

app.post('/api/admin/login', async (req, res) => {
  try {
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
      'SELECT * FROM admins WHERE email=? LIMIT 1',
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
        error: 'Email অথবা password ভুল'
      });
    }

    const token = jwt.sign(
      {
        id: rows[0].id,
        email: rows[0].email
      },
      JWT_SECRET,
      { expiresIn: '12h' }
    );

    res.json({
      success: true,
      token,
      email: rows[0].email
    });

  } catch (e) {
    console.error('Login error:', e);

    res.status(500).json({
      error: 'Login failed: ' + e.message
    });
  }
});

/* PUBLIC NEWS LIST */

app.get('/api/news', async (req, res) => {
  try {
    const { category, q, limit = '50' } = req.query;

    let sql = `
      SELECT id,title,slug,summary,content,category,
      author,cover_url,video_url,status,created_at
      FROM news
      WHERE status='published'
    `;

    const params = [];

    if (category) {
      sql += ' AND category=?';
      params.push(category);
    }

    if (q) {
      sql += ' AND (title LIKE ? OR summary LIKE ? OR content LIKE ?)';
      const term = '%' + q + '%';
      params.push(term, term, term);
    }

    const safeLimit = Math.min(
      100,
      Math.max(1, parseInt(limit, 10) || 50)
    );

    sql += ' ORDER BY created_at DESC LIMIT ' + safeLimit;

    const [rows] = await pool.query(sql, params);

    res.json(rows);

  } catch (e) {
    console.error('Public news error:', e);

    res.status(500).json({
      error: 'News load failed: ' + e.message
    });
  }
});

/* SINGLE NEWS DETAILS */

app.get('/api/news/:slug', async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT * FROM news WHERE slug=? AND status='published' LIMIT 1",
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
      error: 'News load failed: ' + e.message
    });
  }
});

/* ADMIN NEWS LIST */

app.get('/api/admin/news', auth, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM news ORDER BY created_at DESC'
    );

    res.json(rows);

  } catch (e) {
    res.status(500).json({
      error: 'News load failed: ' + e.message
    });
  }
});

/* IMAGE UPLOAD API */

app.post(
  '/api/admin/upload',
  auth,
  disk.single('file'),
  uploadFile
);

/* CREATE NEWS */

app.post('/api/admin/news', auth, async (req, res) => {
  try {
    const n = req.body || {};

    const title = String(n.title || '').trim();
    const content = String(n.content || '').trim();

    if (!title) {
      return res.status(400).json({
        error: 'নিউজের শিরোনাম লিখুন'
      });
    }

    if (!content) {
      return res.status(400).json({
        error: 'নিউজের বিস্তারিত লিখুন'
      });
    }

    const coverUrl = String(
      n.cover_url || n.image || ''
    ).trim();

    // নতুন আপলোড করা ছবি Cloudinary URL হতে হবে
    if (
      coverUrl &&
      !/^https:\/\/res\.cloudinary\.com\//i.test(coverUrl)
    ) {
      return res.status(400).json({
        error: 'ছবির স্থায়ী Cloudinary URL পাওয়া যায়নি। আবার ছবি Upload করুন।'
      });
    }

    const baseSlug =
      slugify(title, {
        lower: true,
        strict: true
      }) || 'news';

    const slug = baseSlug + '-' + Date.now();

    const [result] = await pool.query(
      `INSERT INTO news
      (title,slug,summary,content,category,author,
       cover_url,video_url,status)
      VALUES(?,?,?,?,?,?,?,?,?)`,
      [
        title,
        slug,
        n.summary || content.substring(0, 200),
        content,
        n.category || 'জাতীয়',
        n.author || 'ডেস্ক রিপোর্ট',
        coverUrl,
        n.video_url || '',
        n.status === 'draft' ? 'draft' : 'published'
      ]
    );

    console.log('News saved:', {
      id: result.insertId,
      slug,
      cover_url: coverUrl
    });

    res.json({
      success: true,
      id: result.insertId,
      slug,
      cover_url: coverUrl,
      message: 'নিউজ সফলভাবে প্রকাশ হয়েছে'
    });

  } catch (e) {
    console.error('News save error:', e);

    res.status(500).json({
      error: 'News save failed: ' + e.message
    });
  }
});

/* UPDATE NEWS */

app.put('/api/admin/news/:id', auth, async (req, res) => {
  try {
    const n = req.body || {};

    const title = String(n.title || '').trim();
    const content = String(n.content || '').trim();

    if (!title || !content) {
      return res.status(400).json({
        error: 'শিরোনাম ও বিস্তারিত লিখুন'
      });
    }

    const [oldRows] = await pool.query(
      'SELECT cover_url FROM news WHERE id=? LIMIT 1',
      [req.params.id]
    );

    if (!oldRows.length) {
      return res.status(404).json({
        error: 'নিউজটি পাওয়া যায়নি'
      });
    }

    // নতুন ছবি না থাকলে পুরোনো ছবি রাখা হবে
    const coverUrl = String(
      n.cover_url || n.image || oldRows[0].cover_url || ''
    ).trim();

    if (
      coverUrl &&
      !/^https:\/\/res\.cloudinary\.com\//i.test(coverUrl)
    ) {
      return res.status(400).json({
        error: 'সঠিক Cloudinary Image URL পাওয়া যায়নি'
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
        title,
        n.summary || content.substring(0, 200),
        content,
        n.category || 'জাতীয়',
        n.author || 'ডেস্ক রিপোর্ট',
        coverUrl,
        n.video_url || '',
        n.status === 'draft' ? 'draft' : 'published',
        req.params.id
      ]
    );

    res.json({
      success: true,
      cover_url: coverUrl,
      message: 'নিউজ আপডেট হয়েছে'
    });

  } catch (e) {
    console.error('Update error:', e);

    res.status(500).json({
      error: 'Update failed: ' + e.message
    });
  }
});

/* DELETE NEWS */

app.delete('/api/admin/news/:id', auth, async (req, res) => {
  try {
    const [result] = await pool.query(
      'DELETE FROM news WHERE id=?',
      [req.params.id]
    );

    if (!result.affectedRows) {
      return res.status(404).json({
        error: 'নিউজটি পাওয়া যায়নি'
      });
    }

    res.json({
      success: true,
      message: 'নিউজ মুছে ফেলা হয়েছে'
    });

  } catch (e) {
    res.status(500).json({
      error: 'Delete failed: ' + e.message
    });
  }
});

/* HEALTH CHECK */

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');

    res.json({
      ok: true,
      database: 'connected',
      cloudinary: CLOUDINARY_READY ? 'configured' : 'missing'
    });

  } catch (e) {
    res.status(500).json({
      ok: false,
      database: 'error',
      error: e.message
    });
  }
});

/* FRONTEND */

app.get('/', (req, res) => {
  res.sendFile(
    path.join(__dirname, 'public', 'index.html')
  );
});

app.get(/^\/(?!api\/).*/, (req, res) => {
  res.sendFile(
    path.join(__dirname, 'public', 'index.html')
  );
});

/* ERROR HANDLER */

app.use((err, req, res, next) => {
  console.error('Server Error:', err);

  if (err instanceof multer.MulterError) {
    return res.status(400).json({
      error: err.code === 'LIMIT_FILE_SIZE'
        ? 'ছবির সাইজ ১০ MB-এর বেশি। ছোট ছবি নির্বাচন করুন।'
        : 'ছবি Upload করার সময় সমস্যা হয়েছে: ' + err.message
    });
  }

  res.status(500).json({
    error: 'Server error: ' + err.message
  });
});

/* START SERVER */

async function startServer() {
  try {
    if (!JWT_SECRET) {
      throw new Error('JWT_SECRET Environment Variable missing');
    }

    await initDB();

    app.listen(PORT, () => {
      console.log('Server running on port ' + PORT);
      console.log(
        'Cloudinary:',
        CLOUDINARY_READY ? 'READY' : 'NOT CONFIGURED'
      );
    });

  } catch (e) {
    console.error('Server startup error:', e);
    process.exit(1);
  }
}

startServer();
