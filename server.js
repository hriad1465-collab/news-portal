require('dotenv').config();
const express=require('express'), cors=require('cors'), path=require('path'), fs=require('fs');
const bcrypt=require('bcryptjs'), jwt=require('jsonwebtoken'), multer=require('multer');
const mysql=require('mysql2/promise'), slugify=require('slugify');
const {v2:cloudinary}=require('cloudinary');
const app=express();
app.use(cors()); app.use(express.json({limit:'10mb'})); app.use(express.urlencoded({extended:true}));
app.use(express.static(path.join(__dirname,'public')));
const PORT=process.env.PORT||10000, JWT_SECRET=process.env.JWT_SECRET;
if(!JWT_SECRET) console.warn('WARNING: Set JWT_SECRET in environment');
cloudinary.config({cloud_name:process.env.CLOUDINARY_CLOUD_NAME,api_key:process.env.CLOUDINARY_API_KEY,api_secret:process.env.CLOUDINARY_API_SECRET});
const pool=mysql.createPool({
 host:process.env.DB_HOST,port:Number(process.env.DB_PORT||4000),user:process.env.DB_USER,
 password:process.env.DB_PASSWORD,database:process.env.DB_NAME,waitForConnections:true,
 connectionLimit:5,ssl:process.env.DB_SSL==='true'?{rejectUnauthorized:true}:undefined
});
async function initDB(){
 const c=await pool.getConnection();
 try{
  await c.query(`CREATE TABLE IF NOT EXISTS admins(id INT AUTO_INCREMENT PRIMARY KEY,email VARCHAR(190) UNIQUE NOT NULL,password_hash VARCHAR(255) NOT NULL,created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
  await c.query(`CREATE TABLE IF NOT EXISTS news(id INT AUTO_INCREMENT PRIMARY KEY,title VARCHAR(255) NOT NULL,slug VARCHAR(300) UNIQUE NOT NULL,summary TEXT,content LONGTEXT,category VARCHAR(100) DEFAULT 'জাতীয়',author VARCHAR(150) DEFAULT 'ডেস্ক রিপোর্ট',cover_url TEXT,video_url TEXT,status ENUM('draft','published') DEFAULT 'draft',created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,INDEX(status),INDEX(category))`);
  const [rows]=await c.query('SELECT id FROM admins WHERE email=?',[process.env.ADMIN_EMAIL||'admin@example.com']);
  if(!rows.length && process.env.ADMIN_PASSWORD){
   const hash=await bcrypt.hash(process.env.ADMIN_PASSWORD,12);
   await c.query('INSERT INTO admins(email,password_hash) VALUES(?,?)',[process.env.ADMIN_EMAIL||'admin@example.com',hash]);
   console.log('Initial admin account created:',process.env.ADMIN_EMAIL);
  }
 }finally{c.release()}
}
function auth(req,res,next){const token=(req.headers.authorization||'').replace(/^Bearer /,'');try{req.admin=jwt.verify(token,JWT_SECRET);next()}catch(e){res.status(401).json({error:'অনুগ্রহ করে Admin হিসেবে লগইন করুন'})}}
const disk=multer({dest:'uploads/',limits:{fileSize:100*1024*1024}});
async function uploadFile(req,res,next){
 if(!req.file)return res.status(400).json({error:'ফাইল নির্বাচন করুন'});
 try{
  if(process.env.CLOUDINARY_CLOUD_NAME){
   const result=await cloudinary.uploader.upload(req.file.path,{resource_type:'auto',folder:'news-portal'});
   fs.unlink(req.file.path,()=>{});return res.json({url:result.secure_url,type:result.resource_type});
  }
  res.json({url:'/uploads/'+req.file.filename,type:req.file.mimetype.startsWith('video/')?'video':'image',warning:'Local upload: Render redeploy/restart এ ফাইল মুছে যেতে পারে। Cloudinary configure করুন।'});
 }catch(e){next(e)}
}
app.use('/uploads',express.static(path.join(__dirname,'uploads')));
app.post('/api/admin/login',async(req,res)=>{try{const {email,password}=req.body;const [r]=await pool.query('SELECT * FROM admins WHERE email=?',[email]);if(!r.length||!await bcrypt.compare(password,r[0].password_hash))return res.status(401).json({error:'Email বা password ভুল'});res.json({token:jwt.sign({id:r[0].id,email:r[0].email},JWT_SECRET,{expiresIn:'12h'}),email:r[0].email})}catch(e){res.status(500).json({error:'Login failed'})}});
app.get('/api/news',async(req,res)=>{try{const {category,q,limit='50'}=req.query;let sql="SELECT id,title,slug,summary,content,category,author,cover_url,video_url,status,created_at FROM news WHERE status='published'",p=[];if(category){sql+=' AND category=?';p.push(category)}if(q){sql+=' AND (title LIKE ? OR summary LIKE ?)';p.push('%'+q+'%','%'+q+'%')}sql+=' ORDER BY created_at DESC LIMIT '+Math.min(100,Math.max(1,Number(limit)||50));const [rows]=await pool.query(sql,p);res.json(rows)}catch(e){res.status(500).json({error:'News load failed'})}});
app.get('/api/news/:slug',async(req,res)=>{try{const [r]=await pool.query("SELECT * FROM news WHERE slug=? AND status='published'",[req.params.slug]);if(!r.length)return res.status(404).json({error:'News not found'});res.json(r[0])}catch(e){res.status(500).json({error:'News load failed'})}});
app.get('/api/admin/news',auth,async(req,res)=>{const [r]=await pool.query('SELECT * FROM news ORDER BY created_at DESC');res.json(r)});
app.post('/api/admin/upload',auth,disk.single('file'),uploadFile);
app.post('/api/admin/news',auth,async(req,res)=>{try{const n=req.body;const slug=slugify(n.title,{lower:true,strict:true})+'-'+Date.now();const [r]=await pool.query('INSERT INTO news(title,slug,summary,content,category,author,cover_url,video_url,status) VALUES(?,?,?,?,?,?,?,?,?)',[n.title,slug,n.summary||'',n.content||'',n.category||'জাতীয়',n.author||'ডেস্ক রিপোর্ট',n.cover_url||'',n.video_url||'',n.status||'draft']);res.json({id:r.insertId,slug})}catch(e){res.status(500).json({error:'News save failed: '+e.message})}});
app.put('/api/admin/news/:id',auth,async(req,res)=>{try{const n=req.body;await pool.query('UPDATE news SET title=?,summary=?,content=?,category=?,author=?,cover_url=?,video_url=?,status=? WHERE id=?',[n.title,n.summary||'',n.content||'',n.category||'জাতীয়',n.author||'ডেস্ক রিপোর্ট',n.cover_url||'',n.video_url||'',n.status||'draft',req.params.id]);res.json({ok:true})}catch(e){res.status(500).json({error:'Update failed'})}});
app.delete('/api/admin/news/:id',auth,async(req,res)=>{await pool.query('DELETE FROM news WHERE id=?',[req.params.id]);res.json({ok:true})});
app.get('/api/health',async(req,res)=>{try{await pool.query('SELECT 1');res.json({ok:true,database:'connected'})}catch(e){res.status(500).json({ok:false,database:'error'})}});
app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.use((err,req,res,next)=>{console.error(err);res.status(500).json({error:'Server error'})});
initDB().then(()=>app.listen(PORT,()=>console.log('Server running on '+PORT))).catch(e=>{console.error('DB init error',e);process.exit(1)});
