// usage : ADMIN_EMAIL=... ADMIN_PASSWORD=... node scripts/create-admin.js
const Database=require('better-sqlite3'),bcrypt=require('bcryptjs');const db=new Database(process.env.DB_PATH||'data/shop.db');
const{ADMIN_EMAIL:e,ADMIN_PASSWORD:p}=process.env;if(!e||!p||p.length<12){console.error('ADMIN_EMAIL et ADMIN_PASSWORD (12+ car.) requis');process.exit(1)}
db.prepare("INSERT INTO users(email,password_hash,role) VALUES(?,?,'admin') ON CONFLICT(email) DO UPDATE SET password_hash=excluded.password_hash,role='admin'").run(e.toLowerCase(),bcrypt.hashSync(p,12));console.log('admin créé');
