# LE COIN MALIN 34 — Backend & base de données

## Stack
Node 20 + Express, SQLite (better-sqlite3, mode WAL) dans `data/shop.db`, photos dans `media/`.
Conçu pour un seul serveur (VPS ou conteneur) derrière HTTPS. Migration possible vers PostgreSQL si le trafic l'exige.
Aucune dépendance Telegram : pas de BOT_TOKEN, d'API ni de webhook.

## Mise en route
1. `cp .env.example .env` puis renseigner `JWT_SECRET`
2. `npm install`
3. `npm run import` — charge 614 photos et les propositions de classement (tout « À valider », 0 publié)
4. `ADMIN_EMAIL=… ADMIN_PASSWORD=… npm run admin`
5. `npm start`
Domaine propre : reverse proxy HTTPS (Caddy/Nginx) vers le port 3000 ; sauvegarder `data/` chaque jour.

## Règles de données (appliquées par la base)
- Un produit ne peut passer `published=1` que s'il est `valide`, catégorisé et avec au moins une photo (trigger SQL).
- Prix, stock, marque, qualité : NULL tant que non saisis. L'interface affiche « Prix à confirmer », « Stock à confirmer », « Marque non renseignée ».
- Une commande est refusée si un article n'a pas de prix confirmé.
- Les avis ne s'affichent qu'une fois `approuve`.
- Assistant IA et recherche par photo : répondent 503 « non configuré » tant qu'aucun fournisseur n'est branché.

## Paiement par virement bancaire (seul moyen de paiement)
Pas de Stripe, pas de carte bancaire. Aucun IBAN n'est écrit dans le code ni dans la base : il est saisi en administration.
- Réglages admin (`PUT /api/admin/settings`) : `bank_iban` (contrôlé : clé modulo 97), `bank_bic`, `bank_holder`, `bank_name`.
- Tant que l'IBAN est vide, la création de commande répond 503 « Paiement par virement non configuré ».
- `GET /api/orders/:id/payment` (client propriétaire uniquement) : montant, coordonnées bancaires, référence = numéro de commande (à indiquer comme motif). L'interface affiche un bouton « Copier l'IBAN ».
- Statuts de paiement : `attente_virement` → `virement_declare` (le client dit avoir viré, information seulement) → `paye` (uniquement par l'administrateur).
- `POST /api/admin/orders/:id/confirm-payment` : seule voie vers `paye` ; passe la commande en « confirmée », journalise l'administrateur.
- Garde-fous SQL : `paye` impossible sans administrateur ; préparation, expédition, livraison impossibles tant que le paiement n'est pas confirmé.

## Administration (`/admin`)
Interface web protégée (compte `role=admin` uniquement, toutes les routes `/api/admin/*` exigent le cookie admin).
- **À valider / Validés / À corriger / Publiés** : cartes avec galerie, confiance, « Regroupement à valider », sélection multiple, actions en masse (catégorie, marque, validation, fusion).
- **Fiche produit** : galerie ordonnable, séparation d'un sous-ensemble de photos en nouveau produit, fusion, suppression du catalogue (photo écartée), nom, type (produit/ensemble/lot/coffret), catégorie, marque, prix, description, qualité, variantes (taille, pointure, couleur, stock).
- **Publication** : un produit doit d'abord être « Validé » ; la base refuse sinon. Valider ne publie jamais.
- **Photos** : non rattachées / écartées (captures, stories, publicités), rattachement ou remise à trier.
- **Commandes** : statut de virement, bouton « Virement reçu / Confirmer le paiement » avec case de vérification bancaire obligatoire ; préparation possible uniquement après confirmation.
- **Paramètres** : IBAN/BIC/titulaire/banque, livraison (8–15 jours), retours.


## Vitrine client (`/`) — PWA noir et or
Fichier unique `public/index.html` servi par Express, plus `manifest.webmanifest`, `sw.js` (cache hors-ligne de la coquille et des photos) et les icônes.
- **Ouverture** : logo réel en fondu avec halo doré, slogan « Votre bon plan, notre priorité », 2 à 3 s, respecte `prefers-reduced-motion`, ne s'affiche qu'une fois par session.
- **Accueil** : uniquement les produits `published=1` (donc validés ET publiés). Catégories avec vraie photo et vrai nombre, section Nouveautés, une section par catégorie garnie, marques avec compteur — rien de vide ne s'affiche.
- **Catégories / marques** : filtres (marque, couleur, taille/pointure, disponibilité) générés uniquement à partir des données réellement présentes.
- **Recherche** : uniquement sur le catalogue publié ; tolère fautes, langage familier, tailles/pointures ; renvoie « information non disponible » plutôt que d'inventer un résultat.
- **Recherche par photo** et **Assistant IA** : appellent l'API (503 si non configurée) ; aucun résultat n'est simulé, message clair invitant à configurer le service.
- **Fiche produit** : galerie ordonnée, badge Ensemble/Lot/Coffret, prix ou « Prix à confirmer », variantes ou « Information non disponible », section Qualité (« Informations qualité à compléter » si vide), avis réels avec formulaire réservé aux clients ayant payé leur commande.
- **Panier** : persiste côté serveur si connecté (fusion du panier local à la connexion), sinon dans le navigateur ; bloque la commande si un article n'a pas de prix confirmé.
- **Compte / commandes** : inscription, connexion, profil, historique. Chaque commande affiche le statut de virement (« En attente de virement » → « Virement déclaré — à vérifier » → « Paiement confirmé » uniquement après action de l'administrateur), les coordonnées bancaires et la référence à indiquer, un bouton « Copier », le suivi par étapes et les demandes de retour (ouvertes seulement après expédition et paiement confirmé).
- **Retours / Livraison** : page dédiée reprenant les réglages saisis en administration ; « Les conditions de retour seront précisées prochainement. » si rien n'est configuré.
- **Navigation mobile** : barre basse Accueil / Catégories / Recherche / Panier / Compte, avec accès à la recherche par photo et à l'Assistant IA depuis l'accueil et la recherche.
- Aucune trace de Telegram dans ce fichier.

## Garde-fou « regroupement à séparer »
La classification proposée marque 47 des 59 fiches (`split_required=1` en base) comme regroupements trop larges à vérifier — maillots de football, vêtements On, casquettes GG, montres/écouteurs/appareils en plusieurs coloris, etc. La base **refuse de les valider** tant que l'administrateur n'a pas utilisé « Séparer en nouveau produit », ou coché « Je confirme que toutes ces photos montrent le même produit » dans la fiche. 12 fiches cohérentes (un seul article, vues multiples) peuvent être validées directement.


## Mise à jour du classement (analyse fine des maillots, vêtements On/R/Nike, casquettes GG)
- **121 photos de maillots/ensembles de football** analysées une par une → 97 fiches individuelles (au lieu de 2 gros blocs). 88 sont directement validables (article unique confirmé) ; 9 restent « à confirmer » (ex. deux maillots roses Maroc Puma dont il faut vérifier s'il s'agit d'un seul maillot photographié des deux côtés).
- **71 photos « vêtements On »** analysées → 66 fiches. 23 sont directement validables (article unique et net). 37 photos montrent plusieurs coloris/articles ensemble sur une seule image : elles restent regroupées dans une fiche marquée « à séparer en administration », car je ne peux pas découper une photo en plusieurs fiches sans risquer d'inventer un article. 6 fiches signalent une incertitude précise (ex. deux vestes qui pourraient être la même sous deux angles).
- **Erreur corrigée** : certains articles mêlés au lot « On » portent en réalité un logo différent (« R ») ou la marque Nike — ils ont été sortis de la catégorie « On » et marqués avec la bonne marque, ou « marque non confirmée » quand le doute persiste.
- **Casquettes GG corrigées** : le regroupement initial contenait par erreur une photo de sandale et une photo d'intérieur de pochette, qui n'étaient pas des casquettes. Elles ont été retirées et classées à part. Les vraies casquettes ont été séparées en deux fiches : celles visibles en arrière-plan de photos de maillots (probablement le même exemplaire, à vérifier) et celle photographiée seule avec sa boîte (haute confiance).
- Une photo orpheline (détail de sangle/boucle Gucci, sans contexte suffisant) a été classée dans « Non classées — produit à valider ».
- Total vérifié : 614 photos = 536 rattachées à une fiche + 78 écartées (captures, stories, publicités, photo de contexte boutique).


## Démarrage automatique (aucune commande à taper)
Le serveur (`server/index.js`) importe désormais le catalogue tout seul au premier démarrage (614 photos, 221 fiches) s'il détecte une base de données vide, et crée/mets à jour le compte administrateur à partir des variables d'environnement `ADMIN_EMAIL` et `ADMIN_PASSWORD` si elles sont définies — sans jamais réimporter au redémarrage suivant. Tout se pilote donc par variables d'environnement, sans terminal ni commande.

## Déploiement sur Railway (guide non technique)
Le fichier `railway.json` et le `Dockerfile` sont prêts pour un déploiement en un clic depuis un dépôt GitHub. Seule la base de données (`/app/data`) a besoin d'un volume persistant — les photos sont déjà incluses dans l'image et ne changent pas.
