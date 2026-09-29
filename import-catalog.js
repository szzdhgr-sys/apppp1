// Importe photos + propositions de classement. TOUT arrive « À valider », rien n'est publié, aucun prix/stock/marque inventé.
const Database=require('better-sqlite3'),fs=require('fs'),path=require('path');
const db=new Database(process.env.DB_PATH||'data/shop.db');db.exec(fs.readFileSync('db/schema.sql','utf8'));
const man=JSON.parse(fs.readFileSync('data/photos_manifest.json')),cls=JSON.parse(fs.readFileSync('data/classification.json'));
const ex=new Map(cls.excluded.map(e=>[e.photo,e.reason]));
const slug=s=>s.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
db.transaction(()=>{
 const st=db.prepare('INSERT OR IGNORE INTO settings VALUES(?,?)');st.run('delivery_min_days','8');st.run('delivery_max_days','15');st.run('delivery_text','Après validation de votre commande, la livraison est généralement estimée entre 8 et 15 jours. Les délais peuvent varier selon le produit et la destination.');
 const ip=db.prepare('INSERT OR IGNORE INTO photos(id,lot,source_file,width,height,path_full,path_thumb,review_status,exclusion_reason) VALUES(?,?,?,?,?,?,?,?,?)');
 for(const m of man)ip.run(m.id,m.lot,m.src,m.w,m.h,`media/full/${m.id}.webp`,`media/thumb/${m.id}.webp`,ex.has(m.id)?'ecarte':'a_valider',ex.get(m.id)||null);
 const ic=db.prepare('INSERT OR IGNORE INTO categories(slug,name) VALUES(?,?)'),gc=db.prepare('SELECT id FROM categories WHERE slug=?');
 const ipr=db.prepare('INSERT INTO products(name,category_id,proposal_confidence,proposal_note,split_required) VALUES(?,?,?,?,?)'),ipp=db.prepare('INSERT INTO product_photos(product_id,photo_id,position) VALUES(?,?,?)');
 for(const g of cls.groups){ if(!g.photos.length)continue;
  const cat=g.category.startsWith('Catégorie incertaine')?null:(ic.run(slug(g.category),g.category),gc.get(slug(g.category)).id);
  const id=ipr.run(g.name,cat,g.confidence,[g.grouping,g.note].filter(Boolean).join(' — '),g.broad?1:0).lastInsertRowid;
  g.photos.forEach((p,i)=>ipp.run(id,p,i)); }
})();
console.log('import terminé :',db.prepare('SELECT COUNT(*) n FROM photos').get().n,'photos,',db.prepare('SELECT COUNT(*) n FROM products').get().n,'produits à valider, 0 publié');
