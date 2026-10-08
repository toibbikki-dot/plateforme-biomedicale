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
  let code = "";
  for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ erreur: "Token manquant" });
  const token = auth.split(" ")[1];
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ erreur: "Token invalide ou expiré" });
  }
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
      return creerSessionEtRepondre(userId, res);
    }

    if (mode === "CREER_ORGANISATION") {
      if (!nomOrganisation) return res.status(400).json({ erreur: "Le nom de l'organisation est obligatoire" });
      const code = genererCodeInvitation();
      const orgId = db.prepare("INSERT INTO organisations (nom, type, code_invitation) VALUES (?, 'ORGANISATION', ?)").run(nomOrganisation, code).lastInsertRowid;
      const userId = db.prepare("INSERT INTO utilisateurs (organisation_id, nom, prenom, email, password, role) VALUES (?,?,?,?,?,'ADMIN')").run(orgId, nom, prenom || " ", email, hash).lastInsertRowid;
      return creerSessionEtRepondre(userId, res, { codeGenere: code });
    }

    if (mode === "REJOINDRE_ORGANISATION") {
      if (!codeInvitation) return res.status(400).json({ erreur: "Le code d'invitation est obligatoire" });
      const org = db.prepare("SELECT * FROM organisations WHERE code_invitation=?").get(codeInvitation.toUpperCase().trim());
      if (!org) return res.status(404).json({ erreur: "Code d'invitation invalide" });
      const userId = db.prepare("INSERT INTO utilisateurs (organisation_id, nom, prenom, email, password, role) VALUES (?,?,?,?,?,'TECHNICIEN')").run(org.id, nom, prenom || " ", email, hash).lastInsertRowid;
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
      organisation: { id: user.organisation_id, nom: user.organisationNom, type: user.organisationType, code_invitation: user.code_invitation },
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
      organisation: { id: user.organisation_id, nom: user.organisationNom, type: user.organisationType, code_invitation: user.code_invitation },
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
        db.prepare("UPDATE equipements SET scoreRisque=MIN(100,scoreRisque+15), statut='En panne' WHERE id=?").run(equip.id);
      }

      // Panne résolue sur l'appareil : l'équipement repasse en service
      if (!enPanne && etaitEnPanne && equip.statut === "En panne") {
        db.prepare("INSERT INTO alertes (organisation_id,equipement_id,type,severite,message,source) VALUES (?,?,'RESOLUTION','INFO','Panne résolue (signalée par capteur)','IOT')").run(equip.organisation_id, equip.id);
        db.prepare("UPDATE equipements SET statut='En service' WHERE id=?").run(equip.id);
      }

      // Nouvelle anomalie (valeur hors seuils) : une seule alerte au début
      if (enAnomalie && !etaitEnAnomalie) {
        db.prepare("INSERT INTO alertes (organisation_id,equipement_id,type,severite,message,source) VALUES (?,?,'ANOMALIE','MOYENNE',?,'IOT')").run(equip.organisation_id, equip.id, "Valeur hors seuil — " + depassements.join(" ; "));
        db.prepare("UPDATE equipements SET scoreRisque=MIN(100,scoreRisque+5) WHERE id=?").run(equip.id);
      }

      // Toutes les valeurs sont revenues dans leurs seuils
      if (!enAnomalie && etaitEnAnomalie) {
        db.prepare("INSERT INTO alertes (organisation_id,equipement_id,type,severite,message,source) VALUES (?,?,'RETOUR_NORMAL','INFO','Toutes les mesures sont revenues dans leurs seuils','IOT')").run(equip.organisation_id, equip.id);
      }
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

app.post("/api/capteurs/config", authMiddleware, (req, res) => {
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

app.post("/api/equipements", (req, res) => {
  const { nom, marque, numeroSerie, service, statut, dateAcquisition, prochaineMaintenance } = req.body;
  try {
    const result = db.prepare("INSERT INTO equipements (organisation_id,nom,marque,numeroSerie,service,statut,dateAcquisition,prochaineMaintenance,cle_appareil) VALUES (?,?,?,?,?,?,?,?,?)").run(req.user.organisation_id, nom, marque, numeroSerie, service, statut||"En service", dateAcquisition, prochaineMaintenance, genererCleAppareil());
    res.json({ id: result.lastInsertRowid, organisation_id: req.user.organisation_id, nom, marque, numeroSerie, service, statut, scoreRisque: 0 });
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

app.delete("/api/equipements/:id", (req, res) => {
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

app.post("/api/maintenances", (req, res) => {
  const { equipementId, equipementNom, type, statut, datePlanifiee, technicien, description } = req.body;
  try {
    const result = db.prepare("INSERT INTO maintenances (organisation_id,equipementId,equipementNom,type,statut,datePlanifiee,technicien,description) VALUES (?,?,?,?,?,?,?,?)").run(req.user.organisation_id, equipementId, equipementNom, type||"Préventive", statut||"Planifiée", datePlanifiee, technicien, description);
    res.json({ id: result.lastInsertRowid, organisation_id: req.user.organisation_id, equipementId, equipementNom, type, statut, datePlanifiee, technicien, description });
  } catch (err) { res.status(500).json({ erreur: err.message }); }
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
  try { res.json(db.prepare("SELECT id,nom,prenom,email,role,actif,createdAt FROM utilisateurs WHERE organisation_id=? ORDER BY id").all(req.user.organisation_id)); }
  catch (err) { res.status(500).json({ erreur: err.message }); }
});

app.post("/api/utilisateurs", requireAdmin, (req, res) => {
  const { nom, prenom, email, password, role } = req.body;
  if (!nom || !email || !password) return res.status(400).json({ erreur: "Champs obligatoires manquants" });
  try {
    const result = db.prepare("INSERT INTO utilisateurs (organisation_id,nom,prenom,email,password,role) VALUES (?,?,?,?,?,?)").run(req.user.organisation_id, nom, prenom||" ", email, bcrypt.hashSync(password,10), role||"TECHNICIEN");
    res.json({ id: result.lastInsertRowid, nom, prenom, email, role });
  } catch (err) {
    if (err.message.includes("UNIQUE")) return res.status(409).json({ erreur: "Cet email est déjà utilisé" });
    res.status(500).json({ erreur: err.message });
  }
});

app.patch("/api/utilisateurs/:id/desactiver", requireAdmin, (req, res) => {
  try { res.json({ misAJour: db.prepare("UPDATE utilisateurs SET actif=0 WHERE id=? AND organisation_id=?").run(req.params.id, req.user.organisation_id).changes > 0 }); }
  catch (err) { res.status(500).json({ erreur: err.message }); }
});

app.patch("/api/utilisateurs/:id/reactiver", requireAdmin, (req, res) => {
  try { res.json({ misAJour: db.prepare("UPDATE utilisateurs SET actif=1 WHERE id=? AND organisation_id=?").run(req.params.id, req.user.organisation_id).changes > 0 }); }
  catch (err) { res.status(500).json({ erreur: err.message }); }
});

app.get("/api/organisation", (req, res) => {
  try { res.json(db.prepare("SELECT id,nom,type,code_invitation FROM organisations WHERE id=?").get(req.user.organisation_id)); }
  catch (err) { res.status(500).json({ erreur: err.message }); }
});

app.listen(PORT, () => {
  console.log(`🚀 Serveur backend démarré sur le port ${PORT}`);
  console.log(`📡 Mode multi-organisation activé`);
});
