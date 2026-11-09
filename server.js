
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

/* =========================
   BASIC CONFIGURATION
========================= */

const PORT = Number(process.env.PORT || 10000);
const JWT_SECRET = process.env.JWT_SECRET;

const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOAD_DIR = path.join(__dirname, 'uploads');

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use(express.static(PUBLIC_DIR));

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

/* =========================
   CLOUDINARY CONFIGURATION
========================= */

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
  console.warn('WARNING: Cloudinary credentials are missing');
}

/* =========================
   DATABASE CONFIGURATION
========================= */

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 4000),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,

  waitForConnections: true,
  connectionLimit: 5,
  maxIdle: 5,
  idleTimeout: 60000,
  queueLimit: 0,

  ssl: {
    minVersion: 'TLSv1.2'
  }
});

/* =========================
   DATABASE HELPERS
========================= */

async function columnExists(connection, table, column) {
  const [rows] = await connection.query(
    `SHOW COLUMNS FROM \`${table}\` LIKE ?`,
    [column]
  );

  return rows.length > 0;
}

async function addColumnIfMissing(
  connection,
  table,
  column,
  definition
) {
  const exists = await columnExists(
    connection,
    table,
    column
  );

  if (!exists) {
    await connection.query(
      `ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`
    );

    console.log(`Added column: ${table}.${column}`);
  }
}

/* =========================
   DATABASE INITIALIZATION
========================= */

async function initDB() {
  const connection = await pool.getConnection();

  try {
    /* ADMIN TABLE */

    await connection.query(`
      CREATE TABLE IF NOT EXISTS admins (
        id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        email VARCHAR(190) NOT NULL UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    /* NEWS TABLE */

    await connection.query(`
      CREATE TABLE IF NOT EXISTS news (
        id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        slug VARCHAR(300) NOT NULL UNIQUE,
        summary TEXT NULL,
        content LONGTEXT NULL,
        category VARCHAR(100) DEFAULT 'জাতীয়',
        author VARCHAR(150) DEFAULT 'ডেস্ক রিপোর্ট',
        cover_url TEXT NULL,
        video_url TEXT NULL,
        status ENUM('draft','published') DEFAULT 'draft',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_news_status (status),
        INDEX idx_news_category (category)
      )
    `);

    /*
      পুরোনো news টেবিলে কোনো কলাম না থাকলে
      স্বয়ংক্রিয়ভাবে যোগ হবে।
    */

    await addColumnIfMissing(
      connection,
      'news',
      'title',
      'VARCHAR(255) NULL'
    );

    await addColumnIfMissing(
      connection,
      'news',
      'slug',
      'VARCHAR(300) NULL'
    );

    await addColumnIfMissing(
      connection,
      'news',
      'summary',
      'TEXT NULL'
    );

    await addColumnIfMissing(
      connection,
      'news',
      'content',
      'LONGTEXT NULL'
    );

    await addColumnIfMissing(
      connection,
      'news',
      'category',
      "VARCHAR(100) DEFAULT 'জাতীয়'"
    );

    await addColumnIfMissing(
      connection,
      'news',
      'author',
      "VARCHAR(150) DEFAULT 'ডেস্ক রিপোর্ট'"
    );

    await addColumnIfMissing(
      connection,
      'news',
      'cover_url',
      'TEXT NULL'
    );

    await addColumnIfMissing(
      connection,
      'news',
      'video_url',
      'TEXT NULL'
    );

    await addColumnIfMissing(
      connection,
      'news',
      'status',
      "ENUM('draft','published') DEFAULT 'draft'"
    );

    await addColumnIfMissing(
      connection,
      'news',
      'created_at',
      'TIMESTAMP DEFAULT CURRENT_TIMESTAMP'
    );

    await addColumnIfMissing(
      connection,
      'news',
      'updated_at',
      'TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'
    );

    /*
      পুরোনো রেকর্ডে title বা slug ফাঁকা থাকলে
      সেগুলো পূরণ করা হবে।
    */

    await connection.query(`
      UPDATE news
      SET title = CONCAT('পুরোনো সংবাদ ', id)
      WHERE title IS NULL OR TRIM(title) = ''
    `);

    await connection.query(`
      UPDATE news
      SET slug = CONCAT('news-', id)
      WHERE slug IS NULL OR TRIM(slug) = ''
    `);

    await connection.query(`
      UPDATE news
      SET category = 'জাতীয়'
      WHERE category = 'জাতীয়'
    `);

    await connection.query(`
      UPDATE news
      SET author = 'ডেস্ক রিপোর্ট'
      WHERE author IS NULL OR TRIM(author) = ''
    `);

    /*
      ADMIN ACCOUNT SYNCHRONIZATION
    */

    const adminEmail = String(
      process.env.ADMIN_EMAIL ||
      process.env.ADMIN_USERNAME ||
      ''
    ).trim().toLowerCase();

    const adminPassword = String(
      process.env.ADMIN_PASSWORD || ''
    );

    if (!adminEmail || !adminPassword) {
      throw new Error(
        'Render Environment-এ ADMIN_EMAIL/ADMIN_USERNAME এবং ADMIN_PASSWORD সেট করুন'
      );
    }

    const passwordHash = await bcrypt.hash(
      adminPassword,
      12
    );

    await connection.query(
      `
        INSERT INTO admins (email, password_hash)
        VALUES (?, ?)
        ON DUPLICATE KEY UPDATE
        password_hash = VALUES(password_hash)
      `,
      [adminEmail, passwordHash]
    );

    console.log('Admin account synchronized:', adminEmail);
    console.log('Database initialization completed');

  } finally {
    connection.release();
  }
}

/* =========================
   AUTHENTICATION
========================= */

function auth(req, res, next) {
  if (!JWT_SECRET) {
    return res.status(500).json({
      success: false,
      error: 'JWT_SECRET Environment Variable missing'
    });
  }

  const authorization = req.headers.authorization || '';

  const token = authorization.replace(
    /^Bearer\s+/i,
    ''
  ).trim();

  if (!token) {
    return res.status(401).json({
      success: false,
      error: 'Admin Login করুন'
    });
  }

  try {
    req.admin = jwt.verify(token, JWT_SECRET);
    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      error: 'আপনার Login Session শেষ হয়েছে। আবার Login করুন।'
    });
  }
}

/* =========================
   MULTER IMAGE UPLOAD
========================= */

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOAD_DIR);
  },

  filename: (req, file, cb) => {
    const extension = path.extname(file.originalname || '')
      .toLowerCase();

    cb(
      null,
      `news-${Date.now()}-${Math.round(Math.random() * 1e9)}${extension}`
    );
  }
});

const upload = multer({
  storage,

  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 1
  },

  fileFilter: (req, file, cb) => {
    if (
      !file.mimetype ||
      !file.mimetype.startsWith('image/')
    ) {
      return cb(
        new Error('শুধুমাত্র Image File Upload করা যাবে')
      );
    }

    cb(null, true);
  }
});

/*
  file, image অথবা cover — তিনটি field name-ই গ্রহণ করবে।
*/

const uploadFields = upload.fields([
  { name: 'file', maxCount: 1 },
  { name: 'image', maxCount: 1 },
  { name: 'cover', maxCount: 1 }
]);

function getUploadedFile(req) {
  if (req.file) return req.file;

  if (!req.files) return null;

  return (
    req.files.file?.[0] ||
    req.files.image?.[0] ||
    req.files.cover?.[0] ||
    null
  );
}

function removeTempFile(filePath) {
  if (!filePath) return;

  fs.unlink(filePath, (error) => {
    if (error && error.code !== 'ENOENT') {
      console.error('Temporary file cleanup error:', error);
    }
  });
}

/* =========================
   CLOUDINARY UPLOAD API
========================= */

async function uploadImage(req, res) {
  const file = getUploadedFile(req);

  if (!file) {
    return res.status(400).json({
      success: false,
      error: 'ছবি নির্বাচন করুন'
    });
  }

  try {
    if (!CLOUDINARY_READY) {
      return res.status(503).json({
        success: false,
        error: 'Cloudinary সেটআপ সম্পূর্ণ হয়নি। Render Environment পরীক্ষা করুন।'
      });
    }

    const result = await cloudinary.uploader.upload(
      file.path,
      {
        resource_type: 'image',
        folder: 'news-portal',
        quality: 'auto',
        fetch_format: 'auto'
      }
    );

    if (!result || !result.secure_url) {
      throw new Error('Cloudinary Image URL পাওয়া যায়নি');
    }

    console.log('Image uploaded:', result.secure_url);

    return res.json({
      success: true,
      url: result.secure_url,
      cover_url: result.secure_url,
      public_id: result.public_id,
      message: 'ছবি সফলভাবে Upload হয়েছে'
    });

  } catch (error) {
    console.error('Cloudinary Upload Error:', error);

    return res.status(500).json({
      success: false,
      error: 'ছবি Upload ব্যর্থ হয়েছে: ' + error.message
    });

  } finally {
    removeTempFile(file.path);
  }
}

/* =========================
   COMMON NEWS HELPERS
========================= */

function getNewsFields(body = {}) {
  return {
    title: String(
      body.title ||
      body.headline ||
      ''
    ).trim(),

    summary: String(
      body.summary ||
      body.description ||
      ''
    ).trim(),

    content: String(
      body.content ||
      body.details ||
      body.body ||
      body.news_content ||
      ''
    ).trim(),

    category: String(
      body.category || 'জাতীয়'
    ).trim(),

    author: String(
      body.author || 'ডেস্ক রিপোর্ট'
    ).trim(),

    coverUrl: String(
      body.cover_url ||
      body.image_url ||
      body.image ||
      ''
    ).trim(),

    videoUrl: String(
      body.video_url ||
      body.video ||
      ''
    ).trim(),

    status: body.status === 'draft'
      ? 'draft'
      : 'published'
  };
}

function validImageUrl(url) {
  if (!url) return true;

  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:';
  } catch (error) {
    return false;
  }
}

function createSlug(title) {
  const base = slugify(title, {
    lower: true,
    strict: true
  });

  /*
    বাংলা শিরোনামে slugify অনেক সময় ফাঁকা ফল দেয়।
    তাই news-timestamp ব্যবহার করা হচ্ছে।
  */

  return `${base || 'news'}-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
}

/* =========================
   ADMIN LOGIN API
========================= */

app.post('/api/admin/login', async (req, res) => {
  try {
    const email = String(
      req.body.email ||
      req.body.username ||
      req.body.user ||
      ''
    ).trim().toLowerCase();

    const password = String(
      req.body.password || ''
    );

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        error: 'Username/Email এবং Password দিন'
      });
    }

    const [rows] = await pool.query(
      'SELECT * FROM admins WHERE email = ? LIMIT 1',
      [email]
    );

    if (!rows.length) {
      return res.status(401).json({
        success: false,
        error: 'Username অথবা Password ভুল'
      });
    }

    const passwordMatched = await bcrypt.compare(
      password,
      rows[0].password_hash
    );

    if (!passwordMatched) {
      return res.status(401).json({
        success: false,
        error: 'Username অথবা Password ভুল'
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

    return res.json({
      success: true,
      token,
      email: rows[0].email,
      message: 'Login successful'
    });

  } catch (error) {
    console.error('Admin Login Error:', error);

    return res.status(500).json({
      success: false,
      error: 'Login failed: ' + error.message
    });
  }
});

/* =========================
   PUBLIC NEWS LIST + SEARCH
========================= */

app.get('/api/news', async (req, res) => {
  try {
    const category = String(
      req.query.category || ''
    ).trim();

    const search = String(
      req.query.q || req.query.search || ''
    ).trim();

    const requestedLimit = parseInt(
      req.query.limit || '50',
      10
    );

    const safeLimit = Math.min(
      100,
      Math.max(
        1,
        Number.isFinite(requestedLimit)
          ? requestedLimit
          : 50
      )
    );

    let sql = `
      SELECT
        id,
        title,
        slug,
        summary,
        content,
        category,
        author,
        cover_url,
        video_url,
        status,
        created_at,
        updated_at
      FROM news
      WHERE status = 'published'
    `;

    const params = [];

    if (category && category !== 'all') {
      sql += ' AND category = ?';
      params.push(category);
    }

    if (search) {
      sql += `
        AND (
          title LIKE ?
          OR summary LIKE ?
          OR content LIKE ?
          OR author LIKE ?
          OR category LIKE ?
        )
      `;

      const term = `%${search}%`;

      params.push(
        term,
        term,
        term,
        term,
        term
      );
    }

    sql += `
      ORDER BY created_at DESC, id DESC
      LIMIT ${safeLimit}
    `;

    const [rows] = await pool.query(sql, params);

    return res.json(rows);

  } catch (error) {
    console.error('Public News/Search Error:', error);

    return res.status(500).json({
      success: false,
      error: 'News load failed: ' + error.message
    });
  }
});

/* =========================
   SINGLE NEWS DETAILS
========================= */

app.get('/api/news/:slug', async (req, res) => {
  try {
    const slug = String(req.params.slug || '').trim();

    const [rows] = await pool.query(
      `
        SELECT *
        FROM news
        WHERE slug = ?
          AND status = 'published'
        LIMIT 1
      `,
      [slug]
    );

    if (!rows.length) {
      return res.status(404).json({
        success: false,
        error: 'এই নিউজটি পাওয়া যায়নি'
      });
    }

    return res.json(rows[0]);

  } catch (error) {
    console.error('News Details Error:', error);

    return res.status(500).json({
      success: false,
      error: 'News details load failed: ' + error.message
    });
  }
});

/* =========================
   ADMIN NEWS LIST
========================= */

app.get('/api/admin/news', auth, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `
        SELECT *
        FROM news
        ORDER BY created_at DESC, id DESC
      `
    );

    return res.json(rows);

  } catch (error) {
    console.error('Admin News List Error:', error);

    return res.status(500).json({
      success: false,
      error: 'Admin news load failed: ' + error.message
    });
  }
});

/* =========================
   ADMIN IMAGE UPLOAD
========================= */

app.post(
  '/api/admin/upload',
  auth,
  uploadFields,
  uploadImage
);

/* =========================
   CREATE / PUBLISH NEWS
========================= */

app.post('/api/admin/news', auth, async (req, res) => {
  try {
    const n = getNewsFields(req.body);

    if (!n.title) {
      return res.status(400).json({
        success: false,
        error: 'নিউজের শিরোনাম লিখুন'
      });
    }

    if (!n.content) {
      return res.status(400).json({
        success: false,
        error: 'নিউজের বিস্তারিত লিখুন'
      });
    }

    if (!validImageUrl(n.coverUrl)) {
      return res.status(400).json({
        success: false,
        error: 'সঠিক HTTPS Image URL দিন অথবা আবার ছবি Upload করুন'
      });
    }

    const slug = createSlug(n.title);

    const summary = n.summary ||
      n.content.substring(0, 250);

    const [result] = await pool.query(
      `
        INSERT INTO news (
          title,
          slug,
          summary,
          content,
          category,
          author,
          cover_url,
          video_url,
          status
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        n.title,
        slug,
        summary,
        n.content,
        n.category || 'জাতীয়',
        n.author || 'ডেস্ক রিপোর্ট',
        n.coverUrl,
        n.videoUrl,
        n.status
      ]
    );

    console.log('News published:', {
      id: result.insertId,
      slug: slug
    });

    return res.status(201).json({
      success: true,
      id: result.insertId,
      slug,
      cover_url: n.coverUrl,
      message: n.status === 'draft'
        ? 'নিউজ Draft হিসেবে সংরক্ষণ হয়েছে'
        : 'নিউজ সফলভাবে প্রকাশ হয়েছে'
    });

  } catch (error) {
    console.error('News Save Error:', error);

    return res.status(500).json({
      success: false,
      error: 'News save failed: ' + error.message
    });
  }
});

/* =========================
   UPDATE NEWS
========================= */

app.put('/api/admin/news/:id', auth, async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json({
        success: false,
        error: 'সঠিক News ID পাওয়া যায়নি'
      });
    }

    const [oldRows] = await pool.query(
      'SELECT * FROM news WHERE id = ? LIMIT 1',
      [id]
    );

    if (!oldRows.length) {
      return res.status(404).json({
        success: false,
        error: 'নিউজটি পাওয়া যায়নি'
      });
    }

    const oldNews = oldRows[0];
    const body = req.body || {};

    const n = getNewsFields(body);

    const title = n.title || oldNews.title;
    const content = n.content || oldNews.content;

    if (!title || !content) {
      return res.status(400).json({
        success: false,
        error: 'নিউজের শিরোনাম ও বিস্তারিত লিখুন'
      });
    }

    const coverUrl = (
      body.cover_url ||
      body.image_url ||
      body.image
    )
      ? n.coverUrl
      : (oldNews.cover_url || '');

    if (!validImageUrl(coverUrl)) {
      return res.status(400).json({
        success: false,
        error: 'সঠিক HTTPS Image URL দিন'
      });
    }

    const summary = n.summary ||
      oldNews.summary ||
      content.substring(0, 250);

    const category = body.category
      ? n.category
      : (oldNews.category || 'জাতীয়');

    const author = body.author
      ? n.author
      : (oldNews.author || 'ডেস্ক রিপোর্ট');

    const videoUrl = (
      body.video_url !== undefined ||
      body.video !== undefined
    )
      ? n.videoUrl
      : (oldNews.video_url || '');

    const status = body.status
      ? n.status
      : (oldNews.status || 'published');

    /*
      আগের slug অপরিবর্তিত রাখা হচ্ছে,
      যাতে পুরোনো News Link নষ্ট না হয়।
    */

    await pool.query(
      `
        UPDATE news
        SET
          title = ?,
          summary = ?,
          content = ?,
          category = ?,
          author = ?,
          cover_url = ?,
          video_url = ?,
          status = ?
        WHERE id = ?
      `,
      [
        title,
        summary,
        content,
        category,
        author,
        coverUrl,
        videoUrl,
        status,
        id
      ]
    );

    return res.json({
      success: true,
      id,
      slug: oldNews.slug,
      cover_url: coverUrl,
      message: 'নিউজ সফলভাবে আপডেট হয়েছে'
    });

  } catch (error) {
    console.error('News Update Error:', error);

    return res.status(500).json({
      success: false,
      error: 'News update failed: ' + error.message
    });
  }
});

/* =========================
   DELETE NEWS
========================= */

app.delete('/api/admin/news/:id', auth, async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json({
        success: false,
        error: 'সঠিক News ID দিন'
      });
    }

    const [result] = await pool.query(
      'DELETE FROM news WHERE id = ?',
      [id]
    );

    if (!result.affectedRows) {
      return res.status(404).json({
        success: false,
        error: 'নিউজটি পাওয়া যায়নি'
      });
    }

    return res.json({
      success: true,
      message: 'নিউজ সফলভাবে মুছে ফেলা হয়েছে'
    });

  } catch (error) {
    console.error('News Delete Error:', error);

    return res.status(500).json({
      success: false,
      error: 'News delete failed: ' + error.message
    });
  }
});

/* =========================
   HEALTH CHECK
========================= */

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');

    return res.json({
      ok: true,
      server: 'running',
      database: 'connected',
      cloudinary: CLOUDINARY_READY
        ? 'configured'
        : 'missing'
    });

  } catch (error) {
    console.error('Health Check Error:', error);

    return res.status(500).json({
      ok: false,
      server: 'running',
      database: 'error',
      cloudinary: CLOUDINARY_READY
        ? 'configured'
        : 'missing',
      error: error.message
    });
  }
});

/* =========================
   UNKNOWN API ROUTES
========================= */

app.use('/api', (req, res) => {
  return res.status(404).json({
    success: false,
    error: 'API endpoint পাওয়া যায়নি',
    path: req.originalUrl
  });
});

/* =========================
   FRONTEND ROUTES
========================= */

app.get('/', (req, res) => {
  res.sendFile(
    path.join(PUBLIC_DIR, 'index.html')
  );
});

/*
  /news/slug বা অন্য Frontend URL সরাসরি
  Open/Refresh করলেও index.html লোড হবে।
*/

app.get(/^\/(?!api(?:\/|$)).*/, (req, res) => {
  res.sendFile(
    path.join(PUBLIC_DIR, 'index.html'),
    (error) => {
      if (error && !res.headersSent) {
        res.status(404).send('Page not found');
      }
    }
  );
});

/* =========================
   GLOBAL ERROR HANDLER
========================= */

app.use((error, req, res, next) => {
  console.error('Server Error:', error);

  if (res.headersSent) {
    return next(error);
  }

  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        success: false,
        error: 'ছবির সাইজ ১০ MB-এর বেশি। ছোট ছবি নির্বাচন করুন।'
      });
    }

    return res.status(400).json({
      success: false,
      error: 'ছবি Upload করার সময় সমস্যা হয়েছে: ' + error.message
    });
  }

  return res.status(500).json({
    success: false,
    error: error.message || 'Internal Server Error'
  });
});

/* =========================
   START SERVER
========================= */

async function startServer() {
  try {
    if (!JWT_SECRET) {
      throw new Error(
        'Render Environment-এ JWT_SECRET সেট করা নেই'
      );
    }

    const requiredDB = [
      'DB_HOST',
      'DB_USER',
      'DB_PASSWORD',
      'DB_NAME'
    ];

    const missingDB = requiredDB.filter(
      key => !process.env[key]
    );

    if (missingDB.length) {
      throw new Error(
        'Database Environment Variable missing: ' +
        missingDB.join(', ')
      );
    }

    await initDB();

    app.listen(PORT, '0.0.0.0', () => {
      console.log('================================');
      console.log(`Server running on port ${PORT}`);
      console.log('Database: CONNECTED');
      console.log(
        'Cloudinary:',
        CLOUDINARY_READY ? 'READY' : 'NOT CONFIGURED'
      );
      console.log('================================');
    });

  } catch (error) {
    console.error('SERVER STARTUP FAILED:', error);
    process.exit(1);
  }
}

startServer();
