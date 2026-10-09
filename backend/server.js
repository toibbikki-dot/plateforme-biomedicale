const express = require("express");
const Database = require("better-sqlite3");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || "biomedical_secret_key_2026";

const corsOptions = {
  origin: [
    'https://plateforme-biomedicale.vercel.app',
    'https://plateforme-biomedicale-b4ut559hh-tgbm.vercel.app',
    'http://localhost:5173',
    'http://localhost:3000'
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
};
app.use(cors(corsOptions));
app.use(express.json());

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "biomedical.db");
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
console.log(`✅ Base de données connectée (${DB_PATH})`);

db.exec(`
  CREATE TABLE IF NOT EXISTS organisations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nom TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'ORGANISATION',
    code_invitation TEXT UNIQUE,
    createdAt TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS utilisateurs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    organisation_id INTEGER NOT NULL,
    nom TEXT NOT NULL,
    prenom TEXT,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'TECHNICIEN',
    actif INTEGER DEFAULT 1,
    createdAt TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (organisation_id) REFERENCES organisations(id)
  );
  CREATE TABLE IF NOT EXISTS equipements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    organisation_id INTEGER NOT NULL,
    nom TEXT NOT NULL,
    marque TEXT,
    numeroSerie TEXT,
    service TEXT,
    statut TEXT DEFAULT 'En service',
    scoreRisque INTEGER DEFAULT 0,
    dateAcquisition TEXT,
    prochaineMaintenance TEXT,
    createdAt TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (organisation_id) REFERENCES organisations(id)
  );
  CREATE TABLE IF NOT EXISTS maintenances (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    organisation_id INTEGER NOT NULL,
    equipementId INTEGER,
    equipementNom TEXT,
    type TEXT DEFAULT 'Préventive',
    statut TEXT DEFAULT 'Planifiée',
    datePlanifiee TEXT,
    technicien TEXT,
    description TEXT,
    createdAt TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (organisation_id) REFERENCES organisations(id)
  );
  CREATE TABLE IF NOT EXISTS alertes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    organisation_id INTEGER NOT NULL,
    equipement_id INTEGER,
    type TEXT,
    severite TEXT,
    message TEXT,
    source TEXT,
    estLue INTEGER DEFAULT 0,
    createdAt TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (organisation_id) REFERENCES organisations(id)
  );
  CREATE TABLE IF NOT EXISTS equipement_capteurs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    equipement_id INTEGER UNIQUE NOT NULL,
    organisation_id INTEGER NOT NULL,
    nb_capteurs_actifs INTEGER DEFAULT 2,
    param1_nom TEXT DEFAULT 'Température',
    param1_unite TEXT DEFAULT '°C',
    param2_nom TEXT DEFAULT 'Vibration',
    param2_unite TEXT DEFAULT 'g',
    param3_nom TEXT DEFAULT 'Paramètre 3',
    param3_unite TEXT DEFAULT '',
    param4_nom TEXT DEFAULT 'Paramètre 4',
    param4_unite TEXT DEFAULT '',
    param5_nom TEXT DEFAULT 'Paramètre 5',
    param5_unite TEXT DEFAULT '',
    param6_nom TEXT DEFAULT 'Paramètre 6',
    param6_unite TEXT DEFAULT '',
    param7_nom TEXT DEFAULT 'Paramètre 7',
    param7_unite TEXT DEFAULT '',
    param8_nom TEXT DEFAULT 'Paramètre 8',
    param8_unite TEXT DEFAULT '',
    FOREIGN KEY (equipement_id) REFERENCES equipements(id)
  );
  CREATE TABLE IF NOT EXISTS iot_data (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    organisation_id INTEGER NOT NULL,
    equipement_id INTEGER,
    etat INTEGER,
    panne INTEGER,
    param1 REAL,
    param2 REAL,
    param3 REAL,
    param4 REAL,
    param5 REAL,
    param6 REAL,
    param7 REAL,
    param8 REAL,
    timestamp TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (equipement_id) REFERENCES equipements(id)
  );
  CREATE TABLE IF NOT EXISTS preferences (
    user_id INTEGER PRIMARY KEY,
    monitoring_actif INTEGER DEFAULT 0,
    monitoring_equip_id INTEGER DEFAULT 1
  );
`);
console.log("✅ Tables vérifiées/créées (mode multi-organisation)");

// ════════════════════════════════════════════════════════════
// MIGRATION — Clé d'appareil (une clé secrète par équipement)
// L'ESP32 envoie cette clé : le serveur en déduit l'organisation
// et l'équipement, et refuse toute clé inconnue.
// ════════════════════════════════════════════════════════════
const colonnesEquip = db.prepare("PRAGMA table_info(equipements)").all().map(c => c.name);
if (!colonnesEquip.includes("cle_appareil")) {
  db.exec("ALTER TABLE equipements ADD COLUMN cle_appareil TEXT");
  console.log("✅ Colonne cle_appareil ajoutée");
}
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_equipements_cle ON equipements(cle_appareil)");
{
  const equipSansCle = db.prepare("SELECT id FROM equipements WHERE cle_appareil IS NULL").all();
  const majCle = db.prepare("UPDATE equipements SET cle_appareil=? WHERE id=?");
  for (const e of equipSansCle) majCle.run(genererCleAppareil(), e.id);
  if (equipSansCle.length) console.log(`✅ ${equipSansCle.length} clé(s) d'appareil générée(s)`);
}

// ════════════════════════════════════════════════════════════
// MIGRATION — Seuils min/max par capteur + indicateur d'anomalie
// (colonnes ajoutées sans toucher aux données existantes)
// ════════════════════════════════════════════════════════════
{
  const colsCapteurs = db.prepare("PRAGMA table_info(equipement_capteurs)").all().map(c => c.name);
  let ajoutees = 0;
  for (let i = 1; i <= 8; i++) {
    for (const suffixe of ["min", "max"]) {
      const col = `param${i}_${suffixe}`;
      if (!colsCapteurs.includes(col)) { db.exec(`ALTER TABLE equipement_capteurs ADD COLUMN ${col} REAL`); ajoutees++; }
    }
  }
  const colsIot = db.prepare("PRAGMA table_info(iot_data)").all().map(c => c.name);
  if (!colsIot.includes("anomalie")) { db.exec("ALTER TABLE iot_data ADD COLUMN anomalie INTEGER DEFAULT 0"); ajoutees++; }
  if (ajoutees) console.log(`✅ ${ajoutees} colonne(s) de seuils/anomalie ajoutée(s)`);
}

// ════════════════════════════════════════════════════════════
// MIGRATION — Codes d'invitation par rôle
//   code_invitation : code TECHNICIEN (partagé avec l'équipe de terrain)
//   code_ingenieur  : code INGÉNIEUR (donné aux ingénieurs seulement)
// ════════════════════════════════════════════════════════════
{
  const colsOrg = db.prepare("PRAGMA table_info(organisations)").all().map(c => c.name);
  if (!colsOrg.includes("code_ingenieur")) {
    db.exec("ALTER TABLE organisations ADD COLUMN code_ingenieur TEXT");
    console.log("✅ Colonne code_ingenieur ajoutée");
  }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_org_code_ingenieur ON organisations(code_ingenieur)");
}
// ════════════════════════════════════════════════════════════
// MIGRATION — Propriétaire de l'organisation (le créateur)
// ════════════════════════════════════════════════════════════
{
  const colsOrg = db.prepare("PRAGMA table_info(organisations)").all().map(c => c.name);
  if (!colsOrg.includes("proprietaire_id")) {
    db.exec("ALTER TABLE organisations ADD COLUMN proprietaire_id INTEGER");
    console.log("✅ Colonne proprietaire_id ajoutée");
  }
}
// Propriétaire = premier administrateur créé dans l'organisation
function completerProprietaires() {
  return db.prepare(`UPDATE organisations SET proprietaire_id =
      (SELECT MIN(id) FROM utilisateurs u WHERE u.organisation_id = organisations.id AND u.role = 'ADMIN')
    WHERE proprietaire_id IS NULL`).run().changes;
}

function completerCodesIngenieur() {
  const orgs = db.prepare("SELECT id FROM organisations WHERE type='ORGANISATION' AND code_ingenieur IS NULL").all();
  for (const o of orgs) db.prepare("UPDATE organisations SET code_ingenieur=? WHERE id=?").run(genererCodeInvitation(), o.id);
  if (orgs.length) console.log(`✅ ${orgs.length} code(s) ingénieur générés`);
}

// ════════════════════════════════════════════════════════════
// MIGRATION — Date de fin des maintenances
// ════════════════════════════════════════════════════════════
{
  const colsMaint = db.prepare("PRAGMA table_info(maintenances)").all().map(c => c.name);
  if (!colsMaint.includes("dateTerminee")) {
    db.exec("ALTER TABLE maintenances ADD COLUMN dateTerminee TEXT");
    // Les maintenances déjà terminées comptent à partir de leur création
    db.exec("UPDATE maintenances SET dateTerminee=createdAt WHERE statut='Terminée' AND dateTerminee IS NULL");
    console.log("✅ Colonne dateTerminee ajoutée");
  }
}

// ════════════════════════════════════════════════════════════
// MIGRATION — Fiches d'intervention (traçabilité des maintenances)
// Les informations de l'équipement sont recopiées dans la fiche au moment
// de l'intervention : la fiche reste exacte même si l'équipement est
// renommé ou supprimé plus tard (archive).
// ════════════════════════════════════════════════════════════
{
  const colsMaint = db.prepare("PRAGMA table_info(maintenances)").all().map(c => c.name);
  if (!colsMaint.includes("dateDebut")) {
    db.exec("ALTER TABLE maintenances ADD COLUMN dateDebut TEXT");
    console.log("✅ Colonne dateDebut ajoutée");
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS fiches_intervention (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      organisation_id INTEGER NOT NULL,
      maintenance_id INTEGER UNIQUE,
      equipement_id INTEGER,
      numero TEXT NOT NULL,
      annee INTEGER NOT NULL,
      sequence INTEGER NOT NULL,
      etablissement TEXT,
      telephone TEXT,
      equipement_nom TEXT,
      marque TEXT,
      numero_serie TEXT,
      lieu TEXT,
      type_maintenance TEXT,
      date_debut TEXT,
      date_fin TEXT,
      travaux TEXT NOT NULL,
      pieces TEXT,
      etat_final TEXT NOT NULL,
      technicien_nom TEXT NOT NULL,
      technicien_date TEXT,
      client_nom TEXT,
      client_date TEXT,
      cree_par INTEGER,
      cree_par_nom TEXT,
      createdAt TEXT DEFAULT (datetime('now','localtime')),
      UNIQUE (organisation_id, annee, sequence)
    );
    CREATE INDEX IF NOT EXISTS idx_fiches_org ON fiches_intervention(organisation_id);
  `);
}

// ════════════════════════════════════════════════════════════
// SCORE DE RISQUE — recalculé (et non additionné à l'infini)
// Fenêtre : événements depuis la dernière maintenance terminée,
// sur 30 jours au maximum.
//   Équipement en panne actuellement ........ +40
//   Chaque panne signalée ................... +15 (max 45)
//   Chaque anomalie de seuil ................ +5  (max 20)
//   Chaque maintenance corrective (90 jours)  +10 (max 30)
// Total plafonné à 100.
// ════════════════════════════════════════════════════════════
const REGLE_SCORE = { enPanne: 40, parPanne: 15, maxPannes: 45, parAnomalie: 5, maxAnomalies: 20, parCorrective: 10, maxCorrectives: 30, joursEvenements: 30, joursCorrectives: 90 };

const sqlDebutFenetre = `
  SELECT MAX(datetime('now','localtime','-${REGLE_SCORE.joursEvenements} days'),
             COALESCE((SELECT MAX(dateTerminee) FROM maintenances WHERE equipementId=? AND statut='Terminée'), '0')) AS debut`;

function detailScore(equipementId) {
  const equip = db.prepare("SELECT id, statut FROM equipements WHERE id=?").get(equipementId);
  if (!equip) return null;
  const { debut } = db.prepare(sqlDebutFenetre).get(equipementId);
  const pannes = db.prepare("SELECT COUNT(*) AS n FROM alertes WHERE equipement_id=? AND type='PANNE' AND createdAt > ?").get(equipementId, debut).n;
  const anomalies = db.prepare("SELECT COUNT(*) AS n FROM alertes WHERE equipement_id=? AND type='ANOMALIE' AND createdAt > ?").get(equipementId, debut).n;
  const correctives = db.prepare(`SELECT COUNT(*) AS n FROM maintenances WHERE equipementId=? AND type='Corrective' AND createdAt > datetime('now','localtime','-${REGLE_SCORE.joursCorrectives} days')`).get(equipementId).n;
  const R = REGLE_SCORE;
  const points = {
    en_panne: equip.statut === "En panne" ? R.enPanne : 0,
    pannes: Math.min(R.maxPannes, pannes * R.parPanne),
    anomalies: Math.min(R.maxAnomalies, anomalies * R.parAnomalie),
    correctives: Math.min(R.maxCorrectives, correctives * R.parCorrective),
  };
  const score = Math.min(100, points.en_panne + points.pannes + points.anomalies + points.correctives);
  return { score, depuis: debut, nb_pannes: pannes, nb_anomalies: anomalies, nb_correctives: correctives, points };
}

function recalculerScore(equipementId) {
  const d = detailScore(equipementId);
  if (!d) return null;
  db.prepare("UPDATE equipements SET scoreRisque=? WHERE id=?").run(d.score, equipementId);
  return d.score;
}

function recalculerTousLesScores() {
  const ids = db.prepare("SELECT id FROM equipements").all();
  for (const { id } of ids) recalculerScore(id);
  return ids.length;
}

// ════════════════════════════════════════════════════════════
// UTILITAIRES
// ════════════════════════════════════════════════════════════
function genererCleAppareil() {
  return "bm_" + crypto.randomBytes(16).toString("hex");
}

// Retire la clé secrète des objets équipement envoyés au navigateur
function sansCle(equipement) {
  if (!equipement) return equipement;
  const { cle_appareil, ...reste } = equipement;
  return reste;
}

function requireIngenieur(req, res, next) {
  if (req.user.role !== "ADMIN" && req.user.role !== "INGENIEUR") return res.status(403).json({ erreur: "Accès réservé à l'administrateur ou à l'ingénieur" });
  next();
}

function genererCodeInvitation() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (;;) {
    let code = "";
    for (let i = 0; i < 8; i++) code += chars[crypto.randomInt(chars.length)];
    const existe = db.prepare("SELECT 1 FROM organisations WHERE code_invitation=? OR code_ingenieur=?").get(code, code);
    if (!existe) return code;
  }
}

function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ erreur: "Token manquant" });
  const token = auth.split(" ")[1];
  let jetonDecode;
  try {
    jetonDecode = jwt.verify(token, JWT_SECRET);
  } catch {
    return res.status(401).json({ erreur: "Token invalide ou expiré" });
  }
  // Rôle, organisation et statut actif relus en base : un changement de rôle
  // ou une désactivation s'applique immédiatement, sans attendre l'expiration du jeton.
  const actuel = db.prepare("SELECT id, role, organisation_id, actif, nom, prenom, email FROM utilisateurs WHERE id=?").get(jetonDecode.id);
  if (!actuel) return res.status(401).json({ erreur: "Compte introuvable" });
  if (!actuel.actif) return res.status(401).json({ erreur: "Compte désactivé par l'administrateur" });
  req.user = { ...jetonDecode, role: actuel.role, organisation_id: actuel.organisation_id, nom: actuel.nom, prenom: actuel.prenom, email: actuel.email };
  next();
}

function requireAdmin(req, res, next) {
  if (req.user.role !== "ADMIN") return res.status(403).json({ erreur: "Accès réservé à l'administrateur" });
  next();
}

// ════════════════════════════════════════════════════════════
// AUTH — INSCRIPTION
// ════════════════════════════════════════════════════════════
app.post("/api/auth/inscription", (req, res) => {
  const { nom, prenom, email, password, mode, nomOrganisation, codeInvitation } = req.body;
  if (!nom || !email || !password || !mode) return res.status(400).json({ erreur: "Champs obligatoires manquants" });
  if (password.length < 6) return res.status(400).json({ erreur: "Le mot de passe doit contenir au moins 6 caractères" });

  try {
    if (db.prepare("SELECT id FROM utilisateurs WHERE email=?").get(email))
      return res.status(409).json({ erreur: "Cet email est déjà utilisé" });

    const hash = bcrypt.hashSync(password, 10);

    if (mode === "INDIVIDUEL") {
      const orgId = db.prepare("INSERT INTO organisations (nom, type) VALUES (?, 'INDIVIDUEL')").run(`Espace de ${prenom || nom}`).lastInsertRowid;
      const userId = db.prepare("INSERT INTO utilisateurs (organisation_id, nom, prenom, email, password, role) VALUES (?,?,?,?,?,'ADMIN')").run(orgId, nom, prenom || " ", email, hash).lastInsertRowid;
      db.prepare("UPDATE organisations SET proprietaire_id=? WHERE id=?").run(userId, orgId);
      return creerSessionEtRepondre(userId, res);
    }

    if (mode === "CREER_ORGANISATION") {
      if (!nomOrganisation) return res.status(400).json({ erreur: "Le nom de l'organisation est obligatoire" });
      const code = genererCodeInvitation();
      const codeIngenieur = genererCodeInvitation();
      const orgId = db.prepare("INSERT INTO organisations (nom, type, code_invitation, code_ingenieur) VALUES (?, 'ORGANISATION', ?, ?)").run(nomOrganisation, code, codeIngenieur).lastInsertRowid;
      const userId = db.prepare("INSERT INTO utilisateurs (organisation_id, nom, prenom, email, password, role) VALUES (?,?,?,?,?,'ADMIN')").run(orgId, nom, prenom || " ", email, hash).lastInsertRowid;
      db.prepare("UPDATE organisations SET proprietaire_id=? WHERE id=?").run(userId, orgId);
      return creerSessionEtRepondre(userId, res, { codeGenere: code, codeIngenieur });
    }

    if (mode === "REJOINDRE_ORGANISATION") {
      if (!codeInvitation) return res.status(400).json({ erreur: "Le code d'invitation est obligatoire" });
      const codeSaisi = codeInvitation.toUpperCase().trim();
      const org = db.prepare("SELECT * FROM organisations WHERE type='ORGANISATION' AND (code_invitation=? OR code_ingenieur=?)").get(codeSaisi, codeSaisi);
      if (!org) return res.status(404).json({ erreur: "Code d'invitation invalide" });
      // Le rôle est déterminé par le code reçu de l'administrateur, pas choisi par l'utilisateur
      const role = org.code_ingenieur === codeSaisi ? "INGENIEUR" : "TECHNICIEN";
      const userId = db.prepare("INSERT INTO utilisateurs (organisation_id, nom, prenom, email, password, role) VALUES (?,?,?,?,?,?)").run(org.id, nom, prenom || " ", email, hash, role).lastInsertRowid;
      return creerSessionEtRepondre(userId, res);
    }

    return res.status(400).json({ erreur: "Mode d'inscription invalide" });
  } catch (err) {
    console.error("❌ Erreur inscription:", err);
    return res.status(500).json({ erreur: err.message });
  }
});

function creerSessionEtRepondre(userId, res, extra = {}) {
  try {
    const user = db.prepare("SELECT u.*, o.nom as organisationNom, o.type as organisationType, o.code_invitation FROM utilisateurs u JOIN organisations o ON u.organisation_id = o.id WHERE u.id=?").get(userId);
    if (!user) return res.status(500).json({ erreur: "Erreur lors de la création du compte" });
    const token = jwt.sign({ id: user.id, email: user.email, role: user.role, organisation_id: user.organisation_id, nom: user.nom, prenom: user.prenom }, JWT_SECRET, { expiresIn: "8h" });
    db.prepare("INSERT OR IGNORE INTO preferences (user_id) VALUES (?)").run(user.id);
    res.json({
      token,
      user: { id: user.id, nom: user.nom, prenom: user.prenom, email: user.email, role: user.role },
      organisation: { id: user.organisation_id, nom: user.organisationNom, type: user.organisationType },
      preferences: { monitoring_actif: 0, monitoring_equip_id: 1 },
      ...extra,
    });
  } catch (err) {
    res.status(500).json({ erreur: err.message });
  }
}

// ════════════════════════════════════════════════════════════
// AUTH — CONNEXION
// ════════════════════════════════════════════════════════════
app.post("/api/auth/login", (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ erreur: "Champs obligatoires" });
  try {
    const user = db.prepare("SELECT u.*, o.nom as organisationNom, o.type as organisationType, o.code_invitation FROM utilisateurs u JOIN organisations o ON u.organisation_id = o.id WHERE u.email=? AND u.actif=1").get(email);
    if (!user || !bcrypt.compareSync(password, user.password)) return res.status(401).json({ erreur: "Email ou mot de passe incorrect" });
    const token = jwt.sign({ id: user.id, email: user.email, role: user.role, organisation_id: user.organisation_id, nom: user.nom, prenom: user.prenom }, JWT_SECRET, { expiresIn: "8h" });
    const pref = db.prepare("SELECT * FROM preferences WHERE user_id=?").get(user.id);
    console.log(`🔑 Connexion : ${user.prenom} ${user.nom} | org_id=${user.organisation_id}`);
    res.json({
      token,
      user: { id: user.id, nom: user.nom, prenom: user.prenom, email: user.email, role: user.role },
      organisation: { id: user.organisation_id, nom: user.organisationNom, type: user.organisationType },
      preferences: pref || { monitoring_actif: 0, monitoring_equip_id: 1 },
    });
  } catch (err) {
    res.status(500).json({ erreur: err.message });
  }
});

// ════════════════════════════════════════════════════════════
// IOT — Réception ESP32 (authentifié par la clé d'appareil)
// L'ESP32 envoie sa clé dans l'en-tête "X-Device-Key".
// Le serveur retrouve lui-même l'organisation et l'équipement,
// compare chaque mesure aux seuils configurés sur la plateforme,
// et renvoie ces seuils à l'ESP32 (seuils_txt) pour qu'il les applique.
// ════════════════════════════════════════════════════════════
const chercherEquipParCle = db.prepare("SELECT id, organisation_id, statut FROM equipements WHERE cle_appareil=?");
const dernierEtatIot = db.prepare("SELECT panne, anomalie FROM iot_data WHERE equipement_id=? ORDER BY id DESC LIMIT 1");
const chercherConfigCapteurs = db.prepare("SELECT * FROM equipement_capteurs WHERE equipement_id=?");

const NOMS_PAR_DEFAUT = ['Température', 'Vibration', 'Paramètre 3', 'Paramètre 4', 'Paramètre 5', 'Paramètre 6', 'Paramètre 7', 'Paramètre 8'];

// Nombre (fini) ou null : une case vide = pas de seuil de ce côté
function nombreOuNull(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = parseFloat(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function formater(v) {
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
}

// Liste des mesures hors seuils pour les capteurs actifs
function evaluerSeuils(config, params) {
  const nb = Math.min(8, Math.max(2, (config && config.nb_capteurs_actifs) || 2));
  const depassements = [];
  for (let i = 1; i <= nb; i++) {
    const valeur = params[i - 1];
    if (valeur === null || !config) continue;
    const min = config[`param${i}_min`], max = config[`param${i}_max`];
    const nom = config[`param${i}_nom`] || NOMS_PAR_DEFAUT[i - 1];
    const unite = config[`param${i}_unite`] || "";
    if (max !== null && max !== undefined && valeur > max) depassements.push(`${nom} au-dessus du seuil : ${formater(valeur)} ${unite} (max ${formater(max)})`.replace(/\s+/g, " "));
    else if (min !== null && min !== undefined && valeur < min) depassements.push(`${nom} en dessous du seuil : ${formater(valeur)} ${unite} (min ${formater(min)})`.replace(/\s+/g, " "));
  }
  return depassements;
}

// Format compact lu par l'ESP32 : "min1,max1;min2,max2;..." (vide = pas de seuil)
function seuilsTexte(config) {
  const nb = Math.min(8, Math.max(2, (config && config.nb_capteurs_actifs) || 2));
  const morceaux = [];
  for (let i = 1; i <= nb; i++) {
    const min = config ? config[`param${i}_min`] : null;
    const max = config ? config[`param${i}_max`] : null;
    morceaux.push(`${min ?? ""},${max ?? ""}`);
  }
  return morceaux.join(";");
}

app.post("/api/capteurs", (req, res) => {
  const cle = req.headers["x-device-key"] || req.body.cle_appareil;
  if (!cle) return res.status(401).json({ erreur: "Clé d'appareil manquante" });
  const equip = chercherEquipParCle.get(String(cle));
  if (!equip) return res.status(401).json({ erreur: "Clé d'appareil invalide" });

  const { etat, panne } = req.body;
  const params = [1, 2, 3, 4, 5, 6, 7, 8].map(i => nombreOuNull(req.body[`param${i}`]));
  const enPanne = !!panne;
  const config = chercherConfigCapteurs.get(equip.id);
  const depassements = evaluerSeuils(config, params);
  const enAnomalie = depassements.length > 0;

  try {
    const enregistrer = db.transaction(() => {
      const precedent = dernierEtatIot.get(equip.id);
      const etaitEnPanne = !!(precedent && precedent.panne);
      const etaitEnAnomalie = !!(precedent && precedent.anomalie);

      db.prepare("INSERT INTO iot_data (organisation_id,equipement_id,etat,panne,anomalie,param1,param2,param3,param4,param5,param6,param7,param8,timestamp) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now','localtime'))")
        .run(equip.organisation_id, equip.id, etat ? 1 : 0, enPanne ? 1 : 0, enAnomalie ? 1 : 0, ...params);

      // Nouvelle panne : une seule alerte au moment où elle apparaît
      // (et non une alerte toutes les 5 secondes tant qu'elle dure)
      if (enPanne && !etaitEnPanne) {
        db.prepare("INSERT INTO alertes (organisation_id,equipement_id,type,severite,message,source) VALUES (?,?,'PANNE','CRITIQUE','Panne signalée par capteur','IOT')").run(equip.organisation_id, equip.id);
        db.prepare("UPDATE equipements SET statut='En panne' WHERE id=?").run(equip.id);
      }

      // Panne résolue sur l'appareil : l'équipement repasse en service
      if (!enPanne && etaitEnPanne && equip.statut === "En panne") {
        db.prepare("INSERT INTO alertes (organisation_id,equipement_id,type,severite,message,source) VALUES (?,?,'RESOLUTION','INFO','Panne résolue (signalée par capteur)','IOT')").run(equip.organisation_id, equip.id);
        db.prepare("UPDATE equipements SET statut='En service' WHERE id=?").run(equip.id);
      }

      // Nouvelle anomalie (valeur hors seuils) : une seule alerte au début
      if (enAnomalie && !etaitEnAnomalie) {
        db.prepare("INSERT INTO alertes (organisation_id,equipement_id,type,severite,message,source) VALUES (?,?,'ANOMALIE','MOYENNE',?,'IOT')").run(equip.organisation_id, equip.id, "Valeur hors seuil — " + depassements.join(" ; "));
      }

      // Toutes les valeurs sont revenues dans leurs seuils
      if (!enAnomalie && etaitEnAnomalie) {
        db.prepare("INSERT INTO alertes (organisation_id,equipement_id,type,severite,message,source) VALUES (?,?,'RETOUR_NORMAL','INFO','Toutes les mesures sont revenues dans leurs seuils','IOT')").run(equip.organisation_id, equip.id);
      }

      // Le score de risque est recalculé à partir des événements récents
      if ((enPanne !== etaitEnPanne) || (enAnomalie && !etaitEnAnomalie)) recalculerScore(equip.id);
    });
    enregistrer();
    res.json({
      message: "Données IoT reçues",
      equipement_id: equip.id,
      anomalie: enAnomalie,
      depassements,
      seuils_txt: seuilsTexte(config),
      timestamp: new Date()
    });
  } catch (err) {
    res.status(500).json({ erreur: err.message });
  }
});

// ════════════════════════════════════════════════════════════
// CONFIGURATION CAPTEURS (avant middleware global)
// Noms, unités et seuils min/max de 2 à 8 capteurs par équipement
// ════════════════════════════════════════════════════════════
app.get("/api/capteurs/config/:equipementId", authMiddleware, (req, res) => {
  try {
    const config = db.prepare("SELECT * FROM equipement_capteurs WHERE equipement_id=? AND organisation_id=?").get(req.params.equipementId, req.user.organisation_id);
    if (!config) {
      const parDefaut = { equipement_id: parseInt(req.params.equipementId), organisation_id: req.user.organisation_id, nb_capteurs_actifs: 2 };
      for (let i = 1; i <= 8; i++) {
        parDefaut[`param${i}_nom`] = NOMS_PAR_DEFAUT[i - 1];
        parDefaut[`param${i}_unite`] = i === 1 ? '°C' : i === 2 ? 'g' : '';
        parDefaut[`param${i}_min`] = null;
        parDefaut[`param${i}_max`] = null;
      }
      return res.json(parDefaut);
    }
    res.json(config);
  } catch (err) {
    res.status(500).json({ erreur: err.message });
  }
});

app.post("/api/capteurs/config", authMiddleware, requireIngenieur, (req, res) => {
  const b = req.body;
  if (!b.equipement_id) return res.status(400).json({ erreur: "equipement_id est obligatoire" });
  // Cloisonnement : l'équipement doit appartenir à l'organisation de l'utilisateur
  const equipOk = db.prepare("SELECT id FROM equipements WHERE id=? AND organisation_id=?").get(b.equipement_id, req.user.organisation_id);
  if (!equipOk) return res.status(404).json({ erreur: "Équipement introuvable dans votre organisation. Sélectionnez un équipement dans la liste." });

  const nb = Math.min(8, Math.max(2, parseInt(b.nb_capteurs_actifs) || 2));
  const colonnes = ["equipement_id", "organisation_id", "nb_capteurs_actifs"];
  const valeurs = [b.equipement_id, req.user.organisation_id, nb];
  for (let i = 1; i <= 8; i++) {
    const min = nombreOuNull(b[`param${i}_min`]);
    const max = nombreOuNull(b[`param${i}_max`]);
    const nom = b[`param${i}_nom`] || NOMS_PAR_DEFAUT[i - 1];
    if (i <= nb && min !== null && max !== null && min > max) {
      return res.status(400).json({ erreur: `Capteur ${i} (${nom}) : le seuil min (${min}) est supérieur au seuil max (${max}).` });
    }
    colonnes.push(`param${i}_nom`, `param${i}_unite`, `param${i}_min`, `param${i}_max`);
    valeurs.push(nom, b[`param${i}_unite`] ?? (i === 1 ? '°C' : i === 2 ? 'g' : ''), min, max);
  }
  const majs = colonnes.filter(c => c !== "equipement_id" && c !== "organisation_id").map(c => `${c}=excluded.${c}`).join(", ");
  try {
    const result = db.prepare(`INSERT INTO equipement_capteurs (${colonnes.join(",")}) VALUES (${colonnes.map(() => "?").join(",")}) ON CONFLICT(equipement_id) DO UPDATE SET ${majs}`).run(...valeurs);
    res.json({ message: "Configuration sauvegardée", id: result.lastInsertRowid });
  } catch (err) {
    console.error("❌ Erreur config capteurs:", err);
    res.status(500).json({ erreur: err.message });
  }
});

// ════════════════════════════════════════════════════════════
// MIDDLEWARE GLOBAL (toutes les routes ci-dessous nécessitent auth)
// ════════════════════════════════════════════════════════════
app.use("/api", authMiddleware);

app.get("/api/equipements", (req, res) => {
  try { res.json(db.prepare("SELECT * FROM equipements WHERE organisation_id=? ORDER BY id DESC").all(req.user.organisation_id).map(sansCle)); }
  catch (err) { res.status(500).json({ erreur: err.message }); }
});

app.post("/api/equipements", requireIngenieur, (req, res) => {
  const { nom, marque, numeroSerie, service, statut, dateAcquisition, prochaineMaintenance } = req.body;
  try {
    const result = db.prepare("INSERT INTO equipements (organisation_id,nom,marque,numeroSerie,service,statut,dateAcquisition,prochaineMaintenance,cle_appareil) VALUES (?,?,?,?,?,?,?,?,?)").run(req.user.organisation_id, nom, marque, numeroSerie, service, statut||"En service", dateAcquisition, prochaineMaintenance, genererCleAppareil());
    res.json({ id: result.lastInsertRowid, organisation_id: req.user.organisation_id, nom, marque, numeroSerie, service, statut, scoreRisque: 0 });
  } catch (err) { res.status(500).json({ erreur: err.message }); }
});

// Modifier un équipement (admin / ingénieur). La clé d'appareil et le score
// de risque ne sont pas modifiables ici : le score est recalculé automatiquement.
const texteNonVide = v => typeof v === "string" && v.trim() !== "";
app.put("/api/equipements/:id", requireIngenieur, (req, res) => {
  const { nom, marque, numeroSerie, service, statut, dateAcquisition, prochaineMaintenance } = req.body;
  if (!texteNonVide(nom) || !texteNonVide(numeroSerie)) return res.status(400).json({ erreur: "Le nom et le numéro de série sont obligatoires" });
  const STATUTS = ["En service", "En maintenance", "En panne"];
  if (statut && !STATUTS.includes(statut)) return res.status(400).json({ erreur: "Statut invalide" });
  const dateOk = d => !d || /^\d{4}-\d{2}-\d{2}$/.test(d);
  if (!dateOk(dateAcquisition) || !dateOk(prochaineMaintenance)) return res.status(400).json({ erreur: "Format de date invalide" });
  if (dateAcquisition && new Date(dateAcquisition) > new Date()) return res.status(400).json({ erreur: "La date d'acquisition ne peut pas être dans le futur" });
  try {
    const id = req.params.id, orgId = req.user.organisation_id;
    const modifier = db.transaction(() => {
      const ok = db.prepare("UPDATE equipements SET nom=?, marque=?, numeroSerie=?, service=?, statut=?, dateAcquisition=?, prochaineMaintenance=? WHERE id=? AND organisation_id=?")
        .run(nom.trim(), marque || "", numeroSerie.trim(), service || "", statut || "En service", dateAcquisition || null, prochaineMaintenance || null, id, orgId).changes > 0;
      // Le nom est recopié dans les maintenances : on le garde à jour
      if (ok) db.prepare("UPDATE maintenances SET equipementNom=? WHERE equipementId=? AND organisation_id=?").run(nom.trim(), id, orgId);
      return ok;
    });
    if (!modifier()) return res.status(404).json({ erreur: "Équipement introuvable dans votre organisation" });
    recalculerScore(Number(id));
    res.json(sansCle(db.prepare("SELECT * FROM equipements WHERE id=?").get(id)));
  } catch (err) { res.status(500).json({ erreur: err.message }); }
});

// Clé d'appareil : consulter (la génère si elle manque)
app.get("/api/equipements/:id/cle", requireIngenieur, (req, res) => {
  try {
    const equip = db.prepare("SELECT id, nom, cle_appareil FROM equipements WHERE id=? AND organisation_id=?").get(req.params.id, req.user.organisation_id);
    if (!equip) return res.status(404).json({ erreur: "Équipement introuvable dans votre organisation" });
    if (!equip.cle_appareil) {
      equip.cle_appareil = genererCleAppareil();
      db.prepare("UPDATE equipements SET cle_appareil=? WHERE id=?").run(equip.cle_appareil, equip.id);
    }
    res.json({ equipement_id: equip.id, nom: equip.nom, cle_appareil: equip.cle_appareil });
  } catch (err) { res.status(500).json({ erreur: err.message }); }
});

// Clé d'appareil : régénérer (l'ancienne clé ne fonctionne plus)
app.post("/api/equipements/:id/cle", requireIngenieur, (req, res) => {
  try {
    const nouvelle = genererCleAppareil();
    const ok = db.prepare("UPDATE equipements SET cle_appareil=? WHERE id=? AND organisation_id=?").run(nouvelle, req.params.id, req.user.organisation_id).changes > 0;
    if (!ok) return res.status(404).json({ erreur: "Équipement introuvable dans votre organisation" });
    res.json({ equipement_id: parseInt(req.params.id), cle_appareil: nouvelle });
  } catch (err) { res.status(500).json({ erreur: err.message }); }
});

app.delete("/api/equipements/:id", requireIngenieur, (req, res) => {
  try {
    const id = req.params.id;
    const orgId = req.user.organisation_id;
    const supprimerEnCascade = db.transaction(() => {
      // Cloisonnement : on ne touche à rien si l'équipement n'est pas à cette organisation
      if (!db.prepare("SELECT id FROM equipements WHERE id=? AND organisation_id=?").get(id, orgId)) return false;
      db.prepare("DELETE FROM maintenances WHERE equipementId=? AND organisation_id=?").run(id, orgId);
      db.prepare("DELETE FROM alertes WHERE equipement_id=? AND organisation_id=?").run(id, orgId);
      db.prepare("DELETE FROM iot_data WHERE equipement_id=?").run(id);
      db.prepare("DELETE FROM equipement_capteurs WHERE equipement_id=?").run(id);
      return db.prepare("DELETE FROM equipements WHERE id=? AND organisation_id=?").run(id, orgId).changes > 0;
    });
    res.json({ supprime: supprimerEnCascade() });
  }
  catch (err) { res.status(500).json({ erreur: err.message }); }
});

app.get("/api/maintenances", (req, res) => {
  try { res.json(db.prepare("SELECT * FROM maintenances WHERE organisation_id=? ORDER BY datePlanifiee DESC").all(req.user.organisation_id)); }
  catch (err) { res.status(500).json({ erreur: err.message }); }
});

const STATUTS_MAINTENANCE = ["Planifiée", "En cours", "Terminée"];

// Effet d'un statut de maintenance sur l'équipement concerné, puis recalcul du score
function appliquerStatutMaintenance(equipementId, statut) {
  if (statut === "En cours") {
    db.prepare("UPDATE equipements SET statut='En maintenance' WHERE id=?").run(equipementId);
  } else if (statut === "Terminée") {
    db.prepare("UPDATE equipements SET statut='En service' WHERE id=? AND statut IN ('En panne','En maintenance')").run(equipementId);
  }
  recalculerScore(equipementId);
}

app.post("/api/maintenances", (req, res) => {
  const { equipementId, equipementNom, type, statut, datePlanifiee, technicien, description } = req.body;
  const st = STATUTS_MAINTENANCE.includes(statut) ? statut : "Planifiée";
  if (st === "Terminée") return res.status(400).json({ erreur: "Une maintenance se termine avec sa fiche d'intervention : créez-la « Planifiée » ou « En cours »" });
  // Cloisonnement : l'équipement doit appartenir à l'organisation
  if (!db.prepare("SELECT id FROM equipements WHERE id=? AND organisation_id=?").get(equipementId, req.user.organisation_id))
    return res.status(404).json({ erreur: "Équipement introuvable dans votre organisation" });
  try {
    const creer = db.transaction(() => {
      const result = db.prepare("INSERT INTO maintenances (organisation_id,equipementId,equipementNom,type,statut,datePlanifiee,technicien,description,dateDebut) VALUES (?,?,?,?,?,?,?,?, CASE WHEN ?='En cours' THEN datetime('now','localtime') ELSE NULL END)")
        .run(req.user.organisation_id, equipementId, equipementNom, type||"Préventive", st, datePlanifiee, technicien, description, st);
      appliquerStatutMaintenance(equipementId, st);
      return result.lastInsertRowid;
    });
    const id = creer();
    res.json(db.prepare("SELECT * FROM maintenances WHERE id=?").get(id));
  } catch (err) { res.status(500).json({ erreur: err.message }); }
});

// Faire avancer une maintenance : Planifiée → En cours → Terminée
app.patch("/api/maintenances/:id/statut", (req, res) => {
  const { statut } = req.body;
  if (!STATUTS_MAINTENANCE.includes(statut)) return res.status(400).json({ erreur: "Statut invalide (Planifiée, En cours ou Terminée)" });
  if (statut === "Terminée") return res.status(400).json({ erreur: "Pour terminer une maintenance, remplissez la fiche d'intervention" });
  const maint = db.prepare("SELECT * FROM maintenances WHERE id=? AND organisation_id=?").get(req.params.id, req.user.organisation_id);
  if (!maint) return res.status(404).json({ erreur: "Maintenance introuvable dans votre organisation" });
  try {
    db.transaction(() => {
      db.prepare(`UPDATE maintenances SET statut=?,
          dateTerminee=CASE WHEN ?='Terminée' THEN datetime('now','localtime') ELSE NULL END,
          dateDebut=CASE WHEN ?='En cours' THEN datetime('now','localtime') ELSE dateDebut END
        WHERE id=?`).run(statut, statut, statut, maint.id);
      if (maint.equipementId) appliquerStatutMaintenance(maint.equipementId, statut);
    })();
    const equip = maint.equipementId ? db.prepare("SELECT id, statut, scoreRisque FROM equipements WHERE id=?").get(maint.equipementId) : null;
    res.json({ maintenance: db.prepare("SELECT * FROM maintenances WHERE id=?").get(maint.id), equipement: equip });
  } catch (err) { res.status(500).json({ erreur: err.message }); }
});

// ── Fiches d'intervention ───────────────────────────────────
const ETATS_FINAUX = ["Fonctionnel", "Non fonctionnel"];
const champ = (v, max = 2000) => (typeof v === "string" ? v.trim().slice(0, max) : "");

// Terminer une maintenance en remplissant sa fiche d'intervention
app.post("/api/maintenances/:id/terminer", (req, res) => {
  const b = req.body || {};
  const travaux = champ(b.travaux, 5000), technicien_nom = champ(b.technicien_nom, 120);
  const etat_final = ETATS_FINAUX.includes(b.etat_final) ? b.etat_final : null;
  if (!travaux) return res.status(400).json({ erreur: "Décrivez les travaux effectués" });
  if (!technicien_nom) return res.status(400).json({ erreur: "Le nom de l'intervenant est obligatoire" });
  if (!etat_final) return res.status(400).json({ erreur: "Indiquez l'état de l'équipement après l'intervention" });
  const date_debut = champ(b.date_debut, 30) || null, date_fin = champ(b.date_fin, 30) || null;
  if (date_debut && date_fin && date_debut > date_fin) return res.status(400).json({ erreur: "La date de fin doit être après la date de début" });

  const orgId = req.user.organisation_id;
  const maint = db.prepare("SELECT * FROM maintenances WHERE id=? AND organisation_id=?").get(req.params.id, orgId);
  if (!maint) return res.status(404).json({ erreur: "Maintenance introuvable dans votre organisation" });
  if (maint.statut === "Terminée") return res.status(409).json({ erreur: "Cette maintenance est déjà terminée" });

  try {
    const terminer = db.transaction(() => {
      const equip = maint.equipementId ? db.prepare("SELECT * FROM equipements WHERE id=? AND organisation_id=?").get(maint.equipementId, orgId) : null;
      const org = db.prepare("SELECT nom FROM organisations WHERE id=?").get(orgId);
      const auteur = db.prepare("SELECT prenom, nom FROM utilisateurs WHERE id=?").get(req.user.id) || {};
      const annee = new Date().getFullYear();
      const sequence = (db.prepare("SELECT MAX(sequence) AS m FROM fiches_intervention WHERE organisation_id=? AND annee=?").get(orgId, annee).m || 0) + 1;
      const numero = `FI-${annee}-${String(sequence).padStart(4, "0")}`;
      const ficheId = db.prepare(`INSERT INTO fiches_intervention
        (organisation_id, maintenance_id, equipement_id, numero, annee, sequence, etablissement, telephone,
         equipement_nom, marque, numero_serie, lieu, type_maintenance, date_debut, date_fin, travaux, pieces,
         etat_final, technicien_nom, technicien_date, client_nom, client_date, cree_par, cree_par_nom)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          orgId, maint.id, maint.equipementId, numero, annee, sequence, org?.nom || "", champ(b.telephone, 40),
          equip?.nom || maint.equipementNom || "", equip?.marque || "", equip?.numeroSerie || "", equip?.service || "",
          maint.type || "", date_debut || maint.dateDebut || null, date_fin, travaux, champ(b.pieces, 2000),
          etat_final, technicien_nom, champ(b.technicien_date, 10) || null, champ(b.client_nom, 120), champ(b.client_date, 10) || null,
          req.user.id, `${auteur.prenom || ""} ${auteur.nom || ""}`.trim()
        ).lastInsertRowid;

      db.prepare("UPDATE maintenances SET statut='Terminée', dateTerminee=datetime('now','localtime'), technicien=COALESCE(NULLIF(technicien,''), ?) WHERE id=?").run(technicien_nom, maint.id);
      if (equip) {
        if (etat_final === "Fonctionnel") appliquerStatutMaintenance(equip.id, "Terminée");
        else { db.prepare("UPDATE equipements SET statut='En panne' WHERE id=?").run(equip.id); recalculerScore(equip.id); }
      }
      return ficheId;
    });
    const ficheId = terminer();
    const equipement = maint.equipementId ? db.prepare("SELECT id, statut, scoreRisque FROM equipements WHERE id=?").get(maint.equipementId) : null;
    res.json({
      maintenance: db.prepare("SELECT * FROM maintenances WHERE id=?").get(maint.id),
      equipement,
      fiche: db.prepare("SELECT * FROM fiches_intervention WHERE id=?").get(ficheId),
    });
  } catch (err) { res.status(500).json({ erreur: err.message }); }
});

// Archive des fiches d'intervention de l'organisation
app.get("/api/fiches", (req, res) => {
  try { res.json(db.prepare("SELECT * FROM fiches_intervention WHERE organisation_id=? ORDER BY id DESC").all(req.user.organisation_id)); }
  catch (err) { res.status(500).json({ erreur: err.message }); }
});

app.get("/api/fiches/:id", (req, res) => {
  const f = db.prepare("SELECT * FROM fiches_intervention WHERE id=? AND organisation_id=?").get(req.params.id, req.user.organisation_id);
  if (!f) return res.status(404).json({ erreur: "Fiche introuvable dans votre organisation" });
  res.json(f);
});

// Détail du score de risque d'un équipement (d'où viennent les points)
app.get("/api/equipements/:id/score", (req, res) => {
  if (!db.prepare("SELECT id FROM equipements WHERE id=? AND organisation_id=?").get(req.params.id, req.user.organisation_id))
    return res.status(404).json({ erreur: "Équipement introuvable dans votre organisation" });
  res.json(detailScore(req.params.id));
});

app.get("/api/alertes", (req, res) => {
  try { res.json(db.prepare("SELECT * FROM alertes WHERE organisation_id=? ORDER BY createdAt DESC LIMIT 50").all(req.user.organisation_id)); }
  catch (err) { res.status(500).json({ erreur: err.message }); }
});

app.patch("/api/alertes/:id/lire", (req, res) => {
  try { res.json({ misAJour: db.prepare("UPDATE alertes SET estLue=1 WHERE id=? AND organisation_id=?").run(req.params.id, req.user.organisation_id).changes > 0 }); }
  catch (err) { res.status(500).json({ erreur: err.message }); }
});

app.get("/api/capteurs/:equipementId", (req, res) => {
  try { res.json(db.prepare("SELECT * FROM iot_data WHERE equipement_id=? AND organisation_id=? ORDER BY id DESC LIMIT 30").all(req.params.equipementId, req.user.organisation_id)); }
  catch (err) { res.status(500).json({ erreur: err.message }); }
});

app.post("/api/preferences/monitoring", (req, res) => {
  const { monitoring_actif, monitoring_equip_id } = req.body;
  try {
    db.prepare("INSERT INTO preferences (user_id,monitoring_actif,monitoring_equip_id) VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET monitoring_actif=excluded.monitoring_actif, monitoring_equip_id=excluded.monitoring_equip_id").run(req.user.id, monitoring_actif?1:0, monitoring_equip_id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erreur: err.message }); }
});

app.get("/api/utilisateurs", requireAdmin, (req, res) => {
  try {
    const proprio = proprietaireId(req.user.organisation_id);
    res.json(db.prepare("SELECT id,nom,prenom,email,role,actif,createdAt FROM utilisateurs WHERE organisation_id=? ORDER BY id").all(req.user.organisation_id)
      .map(u => ({ ...u, est_proprietaire: u.id === proprio })));
  }
  catch (err) { res.status(500).json({ erreur: err.message }); }
});

app.post("/api/utilisateurs", requireAdmin, (req, res) => {
  const { nom, prenom, email, password, role } = req.body;
  if (!nom || !email || !password) return res.status(400).json({ erreur: "Champs obligatoires manquants" });
  const roleFinal = ROLES.includes(role) ? role : "TECHNICIEN";
  if (roleFinal === "ADMIN") {
    if (!estProprietaire(req)) return res.status(403).json({ erreur: MSG_PROPRIO });
    if (nbAdminsActifs(req.user.organisation_id) >= MAX_ADMINS) return res.status(400).json({ erreur: MSG_LIMITE });
  }
  try {
    const result = db.prepare("INSERT INTO utilisateurs (organisation_id,nom,prenom,email,password,role) VALUES (?,?,?,?,?,?)").run(req.user.organisation_id, nom, prenom||" ", email, bcrypt.hashSync(password,10), roleFinal);
    res.json({ id: result.lastInsertRowid, nom, prenom, email, role: roleFinal });
  } catch (err) {
    if (err.message.includes("UNIQUE")) return res.status(409).json({ erreur: "Cet email est déjà utilisé" });
    res.status(500).json({ erreur: err.message });
  }
});

const ROLES = ["ADMIN", "INGENIEUR", "TECHNICIEN"];
const MAX_ADMINS = 3;   // le propriétaire + 2 administrateurs adjoints

function proprietaireId(orgId) {
  const o = db.prepare("SELECT proprietaire_id FROM organisations WHERE id=?").get(orgId);
  return o ? o.proprietaire_id : null;
}
function estProprietaire(req) {
  return proprietaireId(req.user.organisation_id) === req.user.id;
}
function nbAdminsActifs(orgId, saufId) {
  return db.prepare("SELECT COUNT(*) AS n FROM utilisateurs WHERE organisation_id=? AND role='ADMIN' AND actif=1 AND id<>?").get(orgId, saufId || 0).n;
}
const MSG_PROPRIO = "Seul le propriétaire de l'organisation peut nommer, retirer ou désactiver un administrateur.";
const MSG_LIMITE = `Limite atteinte : ${MAX_ADMINS} administrateurs au maximum (le propriétaire et ${MAX_ADMINS - 1} adjoints).`;

app.patch("/api/utilisateurs/:id/role", requireAdmin, (req, res) => {
  const { role } = req.body;
  if (!ROLES.includes(role)) return res.status(400).json({ erreur: "Rôle invalide (ADMIN, INGENIEUR ou TECHNICIEN)" });
  const cible = db.prepare("SELECT id, role, actif FROM utilisateurs WHERE id=? AND organisation_id=?").get(req.params.id, req.user.organisation_id);
  if (!cible) return res.status(404).json({ erreur: "Utilisateur introuvable dans votre organisation" });
  if (cible.role === role) return res.json({ id: cible.id, role });
  if (cible.id === proprietaireId(req.user.organisation_id))
    return res.status(400).json({ erreur: "Le rôle du propriétaire ne peut pas être modifié. Transférez d'abord la propriété à un autre administrateur." });
  // Nommer ou retirer un administrateur : réservé au propriétaire
  if ((role === "ADMIN" || cible.role === "ADMIN") && !estProprietaire(req)) return res.status(403).json({ erreur: MSG_PROPRIO });
  if (role === "ADMIN" && cible.actif && nbAdminsActifs(req.user.organisation_id, cible.id) >= MAX_ADMINS) return res.status(400).json({ erreur: MSG_LIMITE });
  try {
    db.prepare("UPDATE utilisateurs SET role=? WHERE id=?").run(role, cible.id);
    res.json({ id: cible.id, role });
  } catch (err) { res.status(500).json({ erreur: err.message }); }
});

app.patch("/api/utilisateurs/:id/desactiver", requireAdmin, (req, res) => {
  if (String(req.params.id) === String(req.user.id)) return res.status(400).json({ erreur: "Vous ne pouvez pas désactiver votre propre compte." });
  const cible = db.prepare("SELECT id, role FROM utilisateurs WHERE id=? AND organisation_id=?").get(req.params.id, req.user.organisation_id);
  if (!cible) return res.status(404).json({ erreur: "Utilisateur introuvable dans votre organisation" });
  if (cible.id === proprietaireId(req.user.organisation_id)) return res.status(400).json({ erreur: "Le propriétaire de l'organisation ne peut pas être désactivé." });
  if (cible.role === "ADMIN" && !estProprietaire(req)) return res.status(403).json({ erreur: MSG_PROPRIO });
  try { res.json({ misAJour: db.prepare("UPDATE utilisateurs SET actif=0 WHERE id=?").run(cible.id).changes > 0 }); }
  catch (err) { res.status(500).json({ erreur: err.message }); }
});

app.patch("/api/utilisateurs/:id/reactiver", requireAdmin, (req, res) => {
  const cible = db.prepare("SELECT id, role FROM utilisateurs WHERE id=? AND organisation_id=?").get(req.params.id, req.user.organisation_id);
  if (!cible) return res.status(404).json({ erreur: "Utilisateur introuvable dans votre organisation" });
  if (cible.role === "ADMIN") {
    if (!estProprietaire(req)) return res.status(403).json({ erreur: MSG_PROPRIO });
    if (nbAdminsActifs(req.user.organisation_id, cible.id) >= MAX_ADMINS) return res.status(400).json({ erreur: MSG_LIMITE + " Retirez d'abord un autre administrateur." });
  }
  try { res.json({ misAJour: db.prepare("UPDATE utilisateurs SET actif=1 WHERE id=?").run(cible.id).changes > 0 }); }
  catch (err) { res.status(500).json({ erreur: err.message }); }
});

// Transférer la propriété à un autre administrateur actif (ex. départ du propriétaire)
app.post("/api/organisation/proprietaire", requireAdmin, (req, res) => {
  if (!estProprietaire(req)) return res.status(403).json({ erreur: "Seul le propriétaire peut transférer la propriété." });
  const cible = db.prepare("SELECT id, role, actif FROM utilisateurs WHERE id=? AND organisation_id=?").get(req.body.utilisateur_id, req.user.organisation_id);
  if (!cible || cible.role !== "ADMIN" || !cible.actif) return res.status(400).json({ erreur: "La propriété ne peut être transférée qu'à un administrateur actif de l'organisation." });
  if (cible.id === req.user.id) return res.status(400).json({ erreur: "Vous êtes déjà le propriétaire." });
  db.prepare("UPDATE organisations SET proprietaire_id=? WHERE id=?").run(cible.id, req.user.organisation_id);
  res.json({ proprietaire_id: cible.id });
});

// Profil courant (rôle à jour, utile si un admin l'a modifié)
app.get("/api/moi", (req, res) => {
  res.json({ id: req.user.id, nom: req.user.nom, prenom: req.user.prenom, email: req.user.email, role: req.user.role, est_proprietaire: estProprietaire(req), max_admins: MAX_ADMINS });
});

app.get("/api/organisation", (req, res) => {
  try { res.json(db.prepare("SELECT id,nom,type FROM organisations WHERE id=?").get(req.user.organisation_id)); }
  catch (err) { res.status(500).json({ erreur: err.message }); }
});

// Codes d'invitation par rôle (administrateur uniquement)
app.get("/api/organisation/codes", requireAdmin, (req, res) => {
  const org = db.prepare("SELECT type, code_invitation, code_ingenieur FROM organisations WHERE id=?").get(req.user.organisation_id);
  if (!org || org.type !== "ORGANISATION") return res.status(400).json({ erreur: "Les codes d'invitation n'existent que pour les organisations" });
  res.json({ technicien: org.code_invitation, ingenieur: org.code_ingenieur });
});

app.post("/api/organisation/codes/regenerer", requireAdmin, (req, res) => {
  const { role } = req.body;
  const colonne = role === "INGENIEUR" ? "code_ingenieur" : role === "TECHNICIEN" ? "code_invitation" : null;
  if (!colonne) return res.status(400).json({ erreur: "Rôle invalide (TECHNICIEN ou INGENIEUR)" });
  const org = db.prepare("SELECT type FROM organisations WHERE id=?").get(req.user.organisation_id);
  if (!org || org.type !== "ORGANISATION") return res.status(400).json({ erreur: "Les codes d'invitation n'existent que pour les organisations" });
  try {
    const nouveau = genererCodeInvitation();
    db.prepare(`UPDATE organisations SET ${colonne}=? WHERE id=?`).run(nouveau, req.user.organisation_id);
    const maj = db.prepare("SELECT code_invitation, code_ingenieur FROM organisations WHERE id=?").get(req.user.organisation_id);
    res.json({ technicien: maj.code_invitation, ingenieur: maj.code_ingenieur });
  } catch (err) { res.status(500).json({ erreur: err.message }); }
});

// Recalcul des scores au démarrage (corrige les anciens scores additionnés)
// puis toutes les heures (les événements de plus de 30 jours cessent de compter)
completerCodesIngenieur();
{ const n = completerProprietaires(); if (n) console.log(`✅ Propriétaire défini pour ${n} organisation(s)`); }
console.log(`✅ Scores de risque recalculés pour ${recalculerTousLesScores()} équipement(s)`);
setInterval(() => { try { recalculerTousLesScores(); } catch (e) { console.error("Recalcul des scores :", e.message); } }, 60 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`🚀 Serveur backend démarré sur le port ${PORT}`);
  console.log(`📡 Mode multi-organisation activé`);
});
