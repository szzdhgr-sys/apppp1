PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,email TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,first_name TEXT,last_name TEXT,phone TEXT,role TEXT NOT NULL DEFAULT 'customer' CHECK(role IN('customer','admin')),created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS addresses(id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,label TEXT,line1 TEXT NOT NULL,line2 TEXT,postal_code TEXT NOT NULL,city TEXT NOT NULL,country TEXT NOT NULL DEFAULT 'FR');
CREATE TABLE IF NOT EXISTS categories(id INTEGER PRIMARY KEY,slug TEXT UNIQUE NOT NULL,name TEXT NOT NULL,sort INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS brands(id INTEGER PRIMARY KEY,name TEXT UNIQUE NOT NULL);
CREATE TABLE IF NOT EXISTS photos(id TEXT PRIMARY KEY,lot TEXT,source_file TEXT,width INTEGER,height INTEGER,path_full TEXT NOT NULL,path_thumb TEXT NOT NULL,
  review_status TEXT NOT NULL DEFAULT 'a_valider' CHECK(review_status IN('a_valider','valide','a_corriger','ecarte')),exclusion_reason TEXT);
CREATE TABLE IF NOT EXISTS products(id INTEGER PRIMARY KEY,name TEXT NOT NULL,kind TEXT NOT NULL DEFAULT 'produit' CHECK(kind IN('produit','ensemble','lot','coffret')),
  category_id INTEGER REFERENCES categories(id),brand_id INTEGER REFERENCES brands(id),description TEXT,
  price_cents INTEGER,currency TEXT DEFAULT 'EUR',quality_info TEXT,
  proposal_confidence TEXT,proposal_note TEXT,
  review_status TEXT NOT NULL DEFAULT 'a_valider' CHECK(review_status IN('a_valider','valide','a_corriger')),
  split_required INTEGER NOT NULL DEFAULT 0,published INTEGER NOT NULL DEFAULT 0,created_at TEXT DEFAULT CURRENT_TIMESTAMP,updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
-- garde-fou : impossible de publier un produit non validé, sans catégorie ou sans photo
CREATE TRIGGER IF NOT EXISTS products_publish_guard BEFORE UPDATE OF published ON products WHEN NEW.published=1
BEGIN SELECT RAISE(ABORT,'publication refusée : produit non validé, sans catégorie ou sans photo')
 WHERE NEW.review_status<>'valide' OR NEW.category_id IS NULL OR NOT EXISTS(SELECT 1 FROM product_photos WHERE product_id=NEW.id); END;
CREATE TABLE IF NOT EXISTS product_photos(product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,photo_id TEXT NOT NULL REFERENCES photos(id),position INTEGER DEFAULT 0,PRIMARY KEY(product_id,photo_id));
CREATE TABLE IF NOT EXISTS variants(id INTEGER PRIMARY KEY,product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,size TEXT,shoe_size TEXT,color TEXT,sku TEXT,stock INTEGER,price_cents INTEGER);  -- stock NULL = « Stock à confirmer »
CREATE TABLE IF NOT EXISTS carts(id INTEGER PRIMARY KEY,user_id INTEGER UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS cart_items(cart_id INTEGER NOT NULL REFERENCES carts(id) ON DELETE CASCADE,product_id INTEGER NOT NULL REFERENCES products(id),variant_id INTEGER NOT NULL DEFAULT 0,quantity INTEGER NOT NULL CHECK(quantity>0),PRIMARY KEY(cart_id,product_id,variant_id));
CREATE TABLE IF NOT EXISTS orders(id INTEGER PRIMARY KEY,number TEXT UNIQUE NOT NULL,user_id INTEGER NOT NULL REFERENCES users(id),status TEXT NOT NULL DEFAULT 'recue' CHECK(status IN('recue','confirmee','preparation','expediee','en_livraison','livree','annulee')),
  total_cents INTEGER,payment_method TEXT NOT NULL DEFAULT 'virement' CHECK(payment_method='virement'),payment_status TEXT NOT NULL DEFAULT 'attente_virement' CHECK(payment_status IN('attente_virement','virement_declare','paye')),payment_declared_at TEXT,paid_at TEXT,paid_confirmed_by INTEGER REFERENCES users(id),ship_name TEXT,ship_line1 TEXT,ship_postal_code TEXT,ship_city TEXT,ship_country TEXT,tracking_number TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS order_items(id INTEGER PRIMARY KEY,order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,product_id INTEGER REFERENCES products(id),variant_id INTEGER,name_snapshot TEXT NOT NULL,unit_price_cents INTEGER NOT NULL,quantity INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS order_events(id INTEGER PRIMARY KEY,order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,status TEXT NOT NULL,at TEXT DEFAULT CURRENT_TIMESTAMP,by_user INTEGER REFERENCES users(id));
CREATE TABLE IF NOT EXISTS returns(id INTEGER PRIMARY KEY,order_item_id INTEGER NOT NULL REFERENCES order_items(id),user_id INTEGER NOT NULL REFERENCES users(id),reason TEXT NOT NULL,comment TEXT,status TEXT NOT NULL DEFAULT 'demandee' CHECK(status IN('demandee','acceptee','refusee','recue','remboursee')),created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS reviews(id INTEGER PRIMARY KEY,product_id INTEGER NOT NULL REFERENCES products(id),user_id INTEGER NOT NULL REFERENCES users(id),rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),comment TEXT,photo_path TEXT,status TEXT NOT NULL DEFAULT 'en_attente' CHECK(status IN('en_attente','approuve','rejete')),created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT);  -- delivery_text, delivery_min_days, delivery_max_days, returns_*, vision_provider, ai_provider…
CREATE TABLE IF NOT EXISTS audit_log(id INTEGER PRIMARY KEY,user_id INTEGER,action TEXT,detail TEXT,at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS ix_products_pub ON products(published,category_id);

-- garde-fou : une commande ne peut passer en préparation/expédition/livraison que si le virement a été confirmé par l'administrateur
CREATE TRIGGER IF NOT EXISTS orders_paid_guard BEFORE UPDATE OF status ON orders WHEN NEW.status IN('preparation','expediee','en_livraison','livree') AND NEW.payment_status<>'paye'
BEGIN SELECT RAISE(ABORT,'virement non confirmé : préparation impossible'); END;
-- garde-fou : seul le serveur (route admin) peut poser payment_status='paye' ; le champ ne peut pas être remis à 'paye' sans paid_confirmed_by
CREATE TRIGGER IF NOT EXISTS orders_paid_needs_admin BEFORE UPDATE OF payment_status ON orders WHEN NEW.payment_status='paye' AND NEW.paid_confirmed_by IS NULL
BEGIN SELECT RAISE(ABORT,'confirmation administrateur requise'); END;

-- garde-fou : un regroupement signalé « trop large » ne peut pas être validé tant que l'administrateur ne l'a pas séparé ou explicitement confirmé
CREATE TRIGGER IF NOT EXISTS products_split_guard BEFORE UPDATE OF review_status ON products WHEN NEW.review_status='valide' AND NEW.split_required=1
BEGIN SELECT RAISE(ABORT,'regroupement à séparer ou à confirmer avant validation'); END;
