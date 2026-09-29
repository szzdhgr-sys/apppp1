require('dotenv').config();
const fs=require('fs'),path=require('path');
// --- démarrage automatique : importe le catalogue et crée le compte administrateur
//     si nécessaire, à partir des seules variables d'environnement (aucune commande à taper).
function bootstrap(){
  const dbPath=process.env.DB_PATH||'data/shop.db';
  fs.mkdirSync(path.dirname(dbPath),{recursive:true});
  const Database=require('better-sqlite3');
  const db=new Database(dbPath);db.pragma('journal_mode=WAL');db.pragma('foreign_keys=ON');
  db.exec(fs.readFileSync(path.join(__dirname,'../db/schema.sql'),'utf8'));
  const already=db.prepare("SELECT COUNT(*) n FROM photos").get().n>0;
  if(!already){
    console.log('Premier démarrage : import du catalogue (614 photos)…');
    const man=JSON.parse(fs.readFileSync(path.join(__dirname,'../data/photos_manifest.json'))),cls=JSON.parse(fs.readFileSync(path.join(__dirname,'../data/classification.json')));
    const ex=new Map(cls.excluded.map(e=>[e.photo,e.reason]));
    const ip=db.prepare('INSERT OR IGNORE INTO photos(id,lot,source_file,width,height,path_full,path_thumb,review_status,exclusion_reason) VALUES(?,?,?,?,?,?,?,?,?)');
    for(const m of man)ip.run(m.id,m.lot,m.src,m.w,m.h,`media/full/${m.id}.webp`,`media/thumb/${m.id}.webp`,ex.has(m.id)?'ecarte':'a_valider',ex.get(m.id)||null);
    const slug=s=>s.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
    const icat=db.prepare('INSERT OR IGNORE INTO categories(slug,name) VALUES(?,?)');
    const ipr=db.prepare('INSERT INTO products(name,category_id,proposal_confidence,proposal_note,split_required) VALUES(?,?,?,?,?)');
    const ipp=db.prepare('INSERT INTO product_photos(product_id,photo_id,position) VALUES(?,?,?)');
    for(const g of cls.groups){ if(!g.photos.length)continue; let cid=null;
      if(!g.category.startsWith('Catégorie incertaine')){icat.run(slug(g.category),g.category);cid=db.prepare('SELECT id FROM categories WHERE slug=?').get(slug(g.category)).id}
      const id=ipr.run(g.name,cid,g.confidence,[g.grouping,g.note].filter(Boolean).join(' — '),g.broad?1:0).lastInsertRowid;
      g.photos.forEach((p,i)=>ipp.run(id,p,i));
    }
    console.log('Import terminé :',db.prepare('SELECT COUNT(*) n FROM photos').get().n,'photos,',db.prepare('SELECT COUNT(*) n FROM products').get().n,'produits à valider.');
  }
  const {ADMIN_EMAIL,ADMIN_PASSWORD}=process.env;
  if(ADMIN_EMAIL&&ADMIN_PASSWORD&&ADMIN_PASSWORD.length>=12){
    const bcrypt=require('bcryptjs');
    db.prepare("INSERT INTO users(email,password_hash,role) VALUES(?,?,'admin') ON CONFLICT(email) DO UPDATE SET password_hash=excluded.password_hash,role='admin'").run(ADMIN_EMAIL.toLowerCase(),bcrypt.hashSync(ADMIN_PASSWORD,12));
    console.log('Compte administrateur prêt :',ADMIN_EMAIL);
  } else if(!already){
    console.log("Aucun ADMIN_EMAIL/ADMIN_PASSWORD défini : pensez à les ajouter dans les variables d'environnement.");
  }
  db.close();
}
bootstrap();
const express=require('express'),Database=require('better-sqlite3'),bcrypt=require('bcryptjs'),jwt=require('jsonwebtoken'),cookie=require('cookie-parser'),helmet=require('helmet'),rate=require('express-rate-limit');
if(!process.env.JWT_SECRET||process.env.JWT_SECRET.length<32){console.error('JWT_SECRET (32+ caractères) requis');process.exit(1)}
const db=new Database(process.env.DB_PATH||'data/shop.db');db.pragma('journal_mode=WAL');db.pragma('foreign_keys=ON');
const app=express();app.use(helmet({contentSecurityPolicy:false}),express.json({limit:'1mb'}),cookie());
app.use(express.static(path.join(__dirname,'../public'),{index:'index.html'}));
app.use('/media',express.static(path.join(__dirname,'../media'),{maxAge:'30d'}));
const sign=u=>jwt.sign({id:u.id,role:u.role},process.env.JWT_SECRET,{expiresIn:'30d'});
const setCk=(res,t)=>res.cookie('t',t,{httpOnly:true,sameSite:'lax',secure:process.env.NODE_ENV==='production',maxAge:2592e6});
const auth=(req,res,next)=>{try{req.user=jwt.verify(req.cookies.t,process.env.JWT_SECRET);next()}catch{res.status(401).json({error:'connexion requise'})}};
const admin=(req,res,next)=>auth(req,res,()=>req.user.role==='admin'?next():res.status(403).json({error:'accès refusé'}));
const lim=rate({windowMs:15*60*1e3,max:30});
// --- comptes
app.post('/api/auth/register',lim,(req,res)=>{const{email,password,first_name,last_name}=req.body||{};
 if(!/^\S+@\S+\.\S+$/.test(email||'')||(password||'').length<8)return res.status(400).json({error:'email valide et mot de passe de 8 caractères minimum requis'});
 try{const id=db.prepare('INSERT INTO users(email,password_hash,first_name,last_name) VALUES(?,?,?,?)').run(email.toLowerCase(),bcrypt.hashSync(password,12),first_name,last_name).lastInsertRowid;
  db.prepare('INSERT INTO carts(user_id) VALUES(?)').run(id);setCk(res,sign({id,role:'customer'}));res.json({id})}catch{res.status(409).json({error:'compte déjà existant'})}});
app.post('/api/auth/login',lim,(req,res)=>{const u=db.prepare('SELECT * FROM users WHERE email=?').get(String(req.body?.email||'').toLowerCase());
 if(!u||!bcrypt.compareSync(String(req.body?.password||''),u.password_hash))return res.status(401).json({error:'identifiants incorrects'});setCk(res,sign(u));res.json({id:u.id,role:u.role})});
app.post('/api/auth/logout',(req,res)=>res.clearCookie('t').json({ok:true}));
// --- catalogue public : UNIQUEMENT produits validés ET publiés
const P=`SELECT p.id,p.name,p.kind,p.description,p.price_cents,p.quality_info,c.name category,b.name brand FROM products p LEFT JOIN categories c ON c.id=p.category_id LEFT JOIN brands b ON b.id=p.brand_id WHERE p.published=1`;
const photos=id=>db.prepare('SELECT ph.path_full full,ph.path_thumb thumb FROM product_photos pp JOIN photos ph ON ph.id=pp.photo_id WHERE pp.product_id=? ORDER BY pp.position').all(id);
const shape=r=>({...r,brand:r.brand||null,price:r.price_cents==null?null:r.price_cents/100,photos:photos(r.id),variants:db.prepare('SELECT id,size,shoe_size,color,stock FROM variants WHERE product_id=?').all(r.id)}); // null => « Prix à confirmer » côté interface
app.get('/api/categories',(q,res)=>res.json(db.prepare('SELECT c.slug,c.name,COUNT(p.id) count FROM categories c JOIN products p ON p.category_id=c.id AND p.published=1 GROUP BY c.id ORDER BY c.sort,c.name').all()));
app.get('/api/products',(req,res)=>{const{category,q}=req.query;let s=P,a=[];if(category){s+=' AND c.slug=?';a.push(category)}if(req.query.brand){s+=' AND b.name=?';a.push(req.query.brand)}if(q){s+=' AND (p.name LIKE ? OR b.name LIKE ?)';a.push(`%${q}%`,`%${q}%`)}res.json(db.prepare(s+' ORDER BY p.id DESC LIMIT 1000').all(...a).map(shape))});
app.get('/api/products/:id',(req,res)=>{const r=db.prepare(P+' AND p.id=?').get(req.params.id);if(!r)return res.status(404).json({error:'introuvable'});
 res.json({...shape(r),variants:db.prepare('SELECT id,size,shoe_size,color,stock FROM variants WHERE product_id=?').all(r.id),reviews:db.prepare("SELECT rating,comment,created_at FROM reviews WHERE product_id=? AND status='approuve'").all(r.id)})});
app.get('/api/settings/public',(q,res)=>res.json(Object.fromEntries(db.prepare("SELECT key,value FROM settings WHERE key LIKE 'delivery_%' OR key LIKE 'returns_%'").all().map(r=>[r.key,r.value]))));
// --- panier persistant
const cartId=uid=>db.prepare('SELECT id FROM carts WHERE user_id=?').get(uid).id;
app.get('/api/cart',auth,(req,res)=>res.json(db.prepare('SELECT ci.product_id,ci.variant_id,ci.quantity,p.name,p.price_cents,v.size,v.shoe_size,v.color,v.stock,(SELECT ph.path_thumb FROM product_photos pp JOIN photos ph ON ph.id=pp.photo_id WHERE pp.product_id=p.id ORDER BY pp.position LIMIT 1) thumb FROM cart_items ci JOIN products p ON p.id=ci.product_id LEFT JOIN variants v ON v.id=ci.variant_id WHERE ci.cart_id=? AND p.published=1').all(cartId(req.user.id))));
app.put('/api/cart',auth,(req,res)=>{const{product_id,variant_id=0,quantity}=req.body||{},c=cartId(req.user.id);
 if(!db.prepare('SELECT 1 FROM products WHERE id=? AND published=1').get(product_id))return res.status(404).json({error:'produit indisponible'});
 quantity>0?db.prepare('INSERT INTO cart_items VALUES(?,?,?,?) ON CONFLICT DO UPDATE SET quantity=excluded.quantity').run(c,product_id,variant_id,quantity):db.prepare('DELETE FROM cart_items WHERE cart_id=? AND product_id=? AND variant_id=?').run(c,product_id,variant_id);res.json({ok:true})});
// --- virement bancaire : coordonnées uniquement depuis l'administration, jamais en dur
const setting=k=>db.prepare('SELECT value FROM settings WHERE key=?').get(k)?.value||null;
const bank=()=>{const iban=setting('bank_iban');return iban?{iban,bic:setting('bank_bic'),holder:setting('bank_holder'),bank_name:setting('bank_name')}:null};
const ibanOk=v=>{const s=String(v).replace(/\s+/g,'').toUpperCase();if(!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(s))return false;const r=(s.slice(4)+s.slice(0,4)).replace(/[A-Z]/g,c=>c.charCodeAt(0)-55);let m=0;for(const d of r)m=(m*10+ +d)%97;return m===1};
// --- commandes : refus si un article n'a pas de prix confirmé
app.post('/api/orders',auth,(req,res)=>{const c=cartId(req.user.id),items=db.prepare('SELECT ci.*,p.name,p.price_cents FROM cart_items ci JOIN products p ON p.id=ci.product_id WHERE ci.cart_id=?').all(c);
 if(!items.length)return res.status(400).json({error:'panier vide'});if(items.some(i=>i.price_cents==null))return res.status(409).json({error:'un article a un prix à confirmer'});
 const a=req.body?.address||{};if(!a.line1||!a.postal_code||!a.city)return res.status(400).json({error:'adresse de livraison requise'});
 if(!bank())return res.status(503).json({error:'Paiement par virement non configuré : les coordonnées bancaires doivent être renseignées en administration.'});
 const tx=db.transaction(()=>{for(const i of items){if(i.variant_id){const v=db.prepare('SELECT stock FROM variants WHERE id=? AND product_id=?').get(i.variant_id,i.product_id);if(!v)throw new Error('variante indisponible');if(v.stock!=null&&v.stock<i.quantity)throw new Error('stock insuffisant pour '+i.name);}}const total=items.reduce((s,i)=>s+i.price_cents*i.quantity,0),num='LCM34-'+Date.now().toString(36).toUpperCase();
  const id=db.prepare('INSERT INTO orders(number,user_id,total_cents,ship_name,ship_line1,ship_postal_code,ship_city,ship_country) VALUES(?,?,?,?,?,?,?,?)').run(num,req.user.id,total,a.name,a.line1,a.postal_code,a.city,a.country||'FR').lastInsertRowid;
  for(const i of items){const v=i.variant_id?db.prepare('SELECT size,shoe_size,color FROM variants WHERE id=?').get(i.variant_id):null,lb=v?[v.size,v.shoe_size&&'pointure '+v.shoe_size,v.color].filter(Boolean).join(' / '):'';db.prepare('INSERT INTO order_items(order_id,product_id,variant_id,name_snapshot,unit_price_cents,quantity) VALUES(?,?,?,?,?,?)').run(id,i.product_id,i.variant_id||null,i.name+(lb?' ('+lb+')':''),i.price_cents,i.quantity);if(i.variant_id)db.prepare('UPDATE variants SET stock=stock-? WHERE id=? AND stock IS NOT NULL').run(i.quantity,i.variant_id)}
  db.prepare('INSERT INTO order_events(order_id,status) VALUES(?,?)').run(id,'recue');db.prepare('DELETE FROM cart_items WHERE cart_id=?').run(c);return{id,number:num}});try{res.json(tx())}catch(e){res.status(409).json({error:e.message})}});
app.get('/api/orders',auth,(req,res)=>res.json(db.prepare('SELECT id,number,status,payment_status,total_cents,tracking_number,created_at,ship_name,ship_line1,ship_postal_code,ship_city FROM orders WHERE user_id=? ORDER BY id DESC').all(req.user.id).map(o=>({...o,items:db.prepare('SELECT id,product_id,name_snapshot name,unit_price_cents,quantity FROM order_items WHERE order_id=?').all(o.id),events:db.prepare('SELECT status,at FROM order_events WHERE order_id=? ORDER BY id').all(o.id)}))));
app.get('/api/orders/:id/payment',auth,(req,res)=>{const o=db.prepare('SELECT number,total_cents,payment_status,paid_at FROM orders WHERE id=? AND user_id=?').get(req.params.id,req.user.id);if(!o)return res.status(404).json({error:'introuvable'});
 const b=bank();res.json({method:'virement',status:o.payment_status,paid_at:o.paid_at,amount:o.total_cents/100,reference:o.number,transfer_reason:o.number,bank:b,message:b?null:'Coordonnées bancaires à compléter'})});
// le client signale son virement : simple information pour l'administrateur, la commande n'est PAS payée pour autant
app.post('/api/orders/:id/declare-transfer',auth,(req,res)=>{const r=db.prepare("UPDATE orders SET payment_status='virement_declare',payment_declared_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=? AND payment_status='attente_virement'").run(req.params.id,req.user.id);
 r.changes?res.json({ok:true,status:'virement_declare',note:'En attente de vérification par la boutique'}):res.status(409).json({error:'action impossible'})});
// --- administration
app.get('/api/admin/settings',admin,(q,res)=>res.json(Object.fromEntries(db.prepare('SELECT key,value FROM settings').all().map(r=>[r.key,r.value]))));
app.post('/api/admin/orders/:id/confirm-payment',admin,(req,res)=>{const id=req.params.id;
 try{db.transaction(()=>{const r=db.prepare("UPDATE orders SET payment_status='paye',paid_at=CURRENT_TIMESTAMP,paid_confirmed_by=?,status='confirmee' WHERE id=? AND payment_status<>'paye' AND status<>'annulee'").run(req.user.id,id);
  if(!r.changes)throw new Error('commande introuvable, annulée ou déjà payée');
  db.prepare('INSERT INTO order_events(order_id,status,by_user) VALUES(?,?,?)').run(id,'confirmee',req.user.id);
  db.prepare('INSERT INTO audit_log(user_id,action,detail) VALUES(?,?,?)').run(req.user.id,'payment.confirm',JSON.stringify({order:id}))})();res.json({ok:true})}catch(e){res.status(409).json({error:e.message})}});
app.put('/api/admin/settings',admin,(req,res)=>{const s=db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');const b=req.body||{};if(b.bank_iban&&!ibanOk(b.bank_iban))return res.status(400).json({error:'IBAN invalide (clé de contrôle incorrecte)'});
 if(b.bank_iban)b.bank_iban=String(b.bank_iban).replace(/\s+/g,'').toUpperCase();
 for(const[k,v]of Object.entries(b).filter(([k])=>/^(bank_|delivery_|returns_)/.test(k)))s.run(k,String(v));db.prepare('INSERT INTO audit_log(user_id,action,detail) VALUES(?,?,?)').run(req.user.id,'settings.update',JSON.stringify(Object.keys(b)));res.json({ok:true})});
app.patch('/api/admin/reviews/:id',admin,(req,res)=>{db.prepare('UPDATE reviews SET status=? WHERE id=?').run(req.body.status,req.params.id);res.json({ok:true})});
// --- administration étendue
const boom=(res,fn)=>{try{res.json(fn()??{ok:true})}catch(e){res.status(409).json({error:e.message})}};
const audit=(u,a,d)=>db.prepare('INSERT INTO audit_log(user_id,action,detail) VALUES(?,?,?)').run(u,a,JSON.stringify(d));
const unpublishEmpty=()=>db.prepare("UPDATE products SET published=0 WHERE published=1 AND NOT EXISTS(SELECT 1 FROM product_photos WHERE product_id=products.id)").run();
const slug=s=>s.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
app.get('/api/me',auth,(req,res)=>res.json(db.prepare('SELECT id,email,role FROM users WHERE id=?').get(req.user.id)));
app.use('/admin',express.static(path.join(__dirname,'../admin')));
app.get('/api/admin/overview',admin,(q,res)=>res.json({
 products:db.prepare('SELECT review_status s,COUNT(*) n FROM products GROUP BY 1').all(),published:db.prepare('SELECT COUNT(*) n FROM products WHERE published=1').get().n,
 photos:db.prepare('SELECT review_status s,COUNT(*) n FROM photos GROUP BY 1').all(),
 orphan:db.prepare("SELECT COUNT(*) n FROM photos WHERE review_status<>'ecarte' AND id NOT IN(SELECT photo_id FROM product_photos)").get().n,
 orders:db.prepare('SELECT payment_status s,COUNT(*) n FROM orders GROUP BY 1').all(),
 bank_configured:!!bank(),ai_configured:!!process.env.AI_API_KEY,vision_configured:!!process.env.VISION_API_KEY}));
app.get('/api/admin/categories',admin,(q,res)=>res.json(db.prepare('SELECT id,slug,name FROM categories ORDER BY sort,name').all()));
app.post('/api/admin/categories',admin,(req,res)=>boom(res,()=>{const n=String(req.body?.name||'').trim();if(!n)throw new Error('nom requis');db.prepare('INSERT OR IGNORE INTO categories(slug,name) VALUES(?,?)').run(slug(n),n);return db.prepare('SELECT id,slug,name FROM categories WHERE slug=?').get(slug(n))}));
app.get('/api/admin/brands',admin,(q,res)=>res.json(db.prepare('SELECT id,name FROM brands ORDER BY name').all()));
app.post('/api/admin/brands',admin,(req,res)=>boom(res,()=>{const n=String(req.body?.name||'').trim();if(!n)throw new Error('nom requis');db.prepare('INSERT OR IGNORE INTO brands(name) VALUES(?)').run(n);return db.prepare('SELECT id,name FROM brands WHERE name=?').get(n)}));
const prodRow='SELECT p.*,c.name category,b.name brand FROM products p LEFT JOIN categories c ON c.id=p.category_id LEFT JOIN brands b ON b.id=p.brand_id';
const withPh=r=>({...r,photos:db.prepare('SELECT ph.id,ph.path_thumb thumb,ph.path_full full FROM product_photos pp JOIN photos ph ON ph.id=pp.photo_id WHERE pp.product_id=? ORDER BY pp.position,ph.id').all(r.id),variants:db.prepare('SELECT id,size,shoe_size,color,stock FROM variants WHERE product_id=?').all(r.id)});
app.get('/api/admin/products',admin,(req,res)=>{const st=req.query.status;const w=st==='publie'?' WHERE p.published=1':(st&&st!=='all'?' WHERE p.review_status=:st':'');res.json(db.prepare(prodRow+w+' ORDER BY p.id').all(w.includes(':st')?{st}:{}).map(withPh))});
app.get('/api/admin/products/:id',admin,(req,res)=>{const r=db.prepare(prodRow+' WHERE p.id=?').get(req.params.id);r?res.json(withPh(r)):res.status(404).json({error:'introuvable'})});
app.post('/api/admin/products',admin,(req,res)=>boom(res,()=>({id:db.prepare('INSERT INTO products(name,category_id) VALUES(?,?)').run(String(req.body?.name||'Produit à valider'),req.body?.category_id||null).lastInsertRowid})));
const PF=['name','description','price_cents','quality_info','category_id','brand_id','review_status','kind','split_required'];
app.patch('/api/admin/products/:id',admin,(req,res)=>boom(res,()=>{const b=req.body||{},id=req.params.id,k=PF.filter(x=>x in b);
 db.transaction(()=>{if('review_status'in b&&b.review_status!=='valide')db.prepare('UPDATE products SET published=0 WHERE id=?').run(id);
  if(k.length)db.prepare(`UPDATE products SET ${k.map(x=>x+'=?').join(',')},updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(...k.map(x=>b[x]===''?null:b[x]),id);
  if('published'in b)db.prepare('UPDATE products SET published=? WHERE id=?').run(b.published?1:0,id);audit(req.user.id,'product.patch',{id,...b})})()}));
app.post('/api/admin/products/bulk',admin,(req,res)=>boom(res,()=>{const{ids=[],patch={}}=req.body||{},k=['category_id','brand_id','review_status'].filter(x=>x in patch);if(!ids.length||!k.length)throw new Error('sélection ou modification vide');
 const skipped=[];db.transaction(()=>{for(const id of ids){if(patch.review_status==='valide'&&db.prepare('SELECT split_required s FROM products WHERE id=?').get(id)?.s){skipped.push(id);continue}if(patch.review_status&&patch.review_status!=='valide')db.prepare('UPDATE products SET published=0 WHERE id=?').run(id);db.prepare(`UPDATE products SET ${k.map(x=>x+'=?').join(',')},updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(...k.map(x=>patch[x]),id)}audit(req.user.id,'product.bulk',{ids,patch,skipped})})();return{ok:true,skipped}}));
app.put('/api/admin/products/:id/variants',admin,(req,res)=>boom(res,()=>{db.transaction(()=>{db.prepare('DELETE FROM variants WHERE product_id=?').run(req.params.id);
 for(const v of req.body||[]){const n=x=>(x===''||x==null)?null:x;db.prepare('INSERT INTO variants(product_id,size,shoe_size,color,stock) VALUES(?,?,?,?,?)').run(req.params.id,n(v.size),n(v.shoe_size),n(v.color),n(v.stock)==null?null:Math.max(0,parseInt(v.stock,10)||0))}})()}));
app.put('/api/admin/products/:id/photos',admin,(req,res)=>boom(res,()=>{const ids=req.body?.photo_ids||[];db.transaction(()=>{db.prepare('DELETE FROM product_photos WHERE product_id=?').run(req.params.id);
 ids.forEach((p,i)=>{db.prepare('DELETE FROM product_photos WHERE photo_id=?').run(p);db.prepare('INSERT INTO product_photos(product_id,photo_id,position) VALUES(?,?,?)').run(req.params.id,p,i)});unpublishEmpty()})()}));
app.post('/api/admin/products/:id/split',admin,(req,res)=>boom(res,()=>{const ids=req.body?.photo_ids||[];if(!ids.length)throw new Error('aucune photo sélectionnée');const o=db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id);
 return db.transaction(()=>{const nid=db.prepare('INSERT INTO products(name,category_id,brand_id,proposal_note) VALUES(?,?,?,?)').run(req.body?.name||'Produit à valider',o.category_id,o.brand_id,'Séparé manuellement — à valider').lastInsertRowid;
  ids.forEach((p,i)=>{db.prepare('DELETE FROM product_photos WHERE photo_id=?').run(p);db.prepare('INSERT INTO product_photos(product_id,photo_id,position) VALUES(?,?,?)').run(nid,p,i)});unpublishEmpty();audit(req.user.id,'product.split',{from:o.id,to:nid,ids});return{id:nid}})()}));
app.post('/api/admin/products/merge',admin,(req,res)=>boom(res,()=>{const{into,from}=req.body||{};if(!into||!from||into==from)throw new Error('fusion invalide');db.transaction(()=>{const n=db.prepare('SELECT COALESCE(MAX(position),-1)+1 n FROM product_photos WHERE product_id=?').get(into).n;
 db.prepare('SELECT photo_id FROM product_photos WHERE product_id=? ORDER BY position').all(from).forEach((r,i)=>db.prepare('UPDATE product_photos SET product_id=?,position=? WHERE photo_id=?').run(into,n+i,r.photo_id));
 db.prepare('DELETE FROM products WHERE id=?').run(from);db.prepare("UPDATE products SET review_status='a_valider',published=0,split_required=1 WHERE id=?").run(into);audit(req.user.id,'product.merge',{into,from})})()}));
app.get('/api/admin/photos',admin,(req,res)=>res.json(db.prepare(req.query.filter==='ecarte'?"SELECT id,path_thumb thumb,path_full full,exclusion_reason reason FROM photos WHERE review_status='ecarte' ORDER BY id":"SELECT id,path_thumb thumb,path_full full FROM photos WHERE review_status<>'ecarte' AND id NOT IN(SELECT photo_id FROM product_photos) ORDER BY id").all()));
app.post('/api/admin/photos/exclude',admin,(req,res)=>boom(res,()=>{const{photo_ids=[],restore=false,reason='Écartée par l\'administrateur'}=req.body||{};db.transaction(()=>{for(const p of photo_ids){if(restore)db.prepare("UPDATE photos SET review_status='a_valider',exclusion_reason=NULL WHERE id=?").run(p);
 else{db.prepare("UPDATE photos SET review_status='ecarte',exclusion_reason=? WHERE id=?").run(reason,p);db.prepare('DELETE FROM product_photos WHERE photo_id=?').run(p)}}unpublishEmpty();audit(req.user.id,restore?'photo.restore':'photo.exclude',{photo_ids})})()}));
app.get('/api/admin/orders',admin,(req,res)=>{const ps=req.query.payment_status||null;res.json(db.prepare('SELECT o.*,u.email,u.first_name,u.last_name FROM orders o JOIN users u ON u.id=o.user_id WHERE (:ps IS NULL OR o.payment_status=:ps) ORDER BY o.id DESC').all({ps}).map(o=>({...o,items:db.prepare('SELECT name_snapshot name,unit_price_cents,quantity FROM order_items WHERE order_id=?').all(o.id)})))});
app.patch('/api/admin/orders/:id',admin,(req,res)=>boom(res,()=>{const{status,tracking_number}=req.body||{};if(status&&!['recue','confirmee','preparation','expediee','en_livraison','livree','annulee'].includes(status))throw new Error('statut inconnu');
 db.transaction(()=>{if(status==='annulee'){const o=db.prepare('SELECT status FROM orders WHERE id=?').get(req.params.id);if(o&&o.status!=='annulee')for(const i of db.prepare('SELECT variant_id,quantity FROM order_items WHERE order_id=? AND variant_id IS NOT NULL').all(req.params.id))db.prepare('UPDATE variants SET stock=stock+? WHERE id=? AND stock IS NOT NULL').run(i.quantity,i.variant_id)}db.prepare('UPDATE orders SET status=COALESCE(?,status),tracking_number=COALESCE(?,tracking_number) WHERE id=?').run(status||null,tracking_number||null,req.params.id);if(status)db.prepare('INSERT INTO order_events(order_id,status,by_user) VALUES(?,?,?)').run(req.params.id,status,req.user.id)})()}));
// --- vitrine : marques, compte, avis, retours
app.get('/api/brands',(q,res)=>res.json(db.prepare('SELECT b.name,COUNT(p.id) count FROM brands b JOIN products p ON p.brand_id=b.id AND p.published=1 GROUP BY b.id ORDER BY b.name').all()));
app.get('/api/account',auth,(req,res)=>res.json(db.prepare('SELECT id,email,first_name,last_name,phone,role FROM users WHERE id=?').get(req.user.id)));
app.patch('/api/account',auth,(req,res)=>{const{first_name,last_name,phone}=req.body||{};db.prepare('UPDATE users SET first_name=?,last_name=?,phone=? WHERE id=?').run(first_name||null,last_name||null,phone||null,req.user.id);res.json({ok:true})});
// un avis n'est possible que pour un produit réellement commandé et dont le paiement est confirmé ; il reste en attente de modération
app.post('/api/reviews',auth,(req,res)=>{const{product_id,rating,comment}=req.body||{};const r=parseInt(rating,10);if(!(r>=1&&r<=5))return res.status(400).json({error:'note de 1 à 5 requise'});
 const ok=db.prepare("SELECT 1 FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.user_id=? AND oi.product_id=? AND o.payment_status='paye'").get(req.user.id,product_id);if(!ok)return res.status(403).json({error:'seuls les clients ayant commandé ce produit peuvent laisser un avis'});
 db.prepare('INSERT INTO reviews(product_id,user_id,rating,comment) VALUES(?,?,?,?)').run(product_id,req.user.id,r,String(comment||'').slice(0,1500)||null);res.json({ok:true,status:'en_attente'})});
app.post('/api/returns',auth,(req,res)=>{const{order_item_id,reason,comment}=req.body||{};if(!reason)return res.status(400).json({error:'motif requis'});
 const it=db.prepare("SELECT oi.id,o.status FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE oi.id=? AND o.user_id=? AND o.payment_status='paye'").get(order_item_id,req.user.id);if(!it)return res.status(404).json({error:'article introuvable'});
 if(!['expediee','en_livraison','livree'].includes(it.status))return res.status(409).json({error:'retour possible une fois la commande expédiée'});
 db.prepare('INSERT INTO returns(order_item_id,user_id,reason,comment) VALUES(?,?,?,?)').run(order_item_id,req.user.id,String(reason).slice(0,200),String(comment||'').slice(0,1500)||null);res.json({ok:true})});
app.get('/api/returns',auth,(req,res)=>res.json(db.prepare('SELECT r.id,r.reason,r.status,r.created_at,oi.name_snapshot name FROM returns r JOIN order_items oi ON oi.id=r.order_item_id WHERE r.user_id=? ORDER BY r.id DESC').all(req.user.id)));
app.get('/api/admin/reviews',admin,(q,res)=>res.json(db.prepare('SELECT rv.*,p.name product,u.email FROM reviews rv JOIN products p ON p.id=rv.product_id JOIN users u ON u.id=rv.user_id ORDER BY (rv.status=\'en_attente\') DESC,rv.id DESC').all()));
app.get('/api/admin/returns',admin,(q,res)=>res.json(db.prepare('SELECT r.*,oi.name_snapshot name,o.number,u.email FROM returns r JOIN order_items oi ON oi.id=r.order_item_id JOIN orders o ON o.id=oi.order_id JOIN users u ON u.id=r.user_id ORDER BY r.id DESC').all()));
app.patch('/api/admin/returns/:id',admin,(req,res)=>boom(res,()=>{if(!['demandee','acceptee','refusee','recue','remboursee'].includes(req.body?.status))throw new Error('statut inconnu');db.prepare('UPDATE returns SET status=? WHERE id=?').run(req.body.status,req.params.id);audit(req.user.id,'return.status',{id:req.params.id,status:req.body.status})}));
// --- IA / vision : non configurées => réponse explicite, aucune simulation
app.post('/api/assistant',(q,res)=>res.status(503).json({error:'Assistant IA non configuré : renseigner un fournisseur IA dans l\'administration.'}));
app.post('/api/search/photo',(q,res)=>res.status(503).json({error:'Analyse d\'image non configurée : service de vision requis (voir administration).'}));
app.listen(process.env.PORT||3000,()=>console.log('LE COIN MALIN 34 — API prête'));
