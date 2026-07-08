const express = require("express");
const Database = require("better-sqlite3");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const path = require("path");

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

const db = new Database(path.join(__dirname, "biomedical.db"));
db.pragma("journal_mode = WAL");
console.log("✅ Base de données connectée");

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
// UTILITAIRES
// ════════════════════════════════════════════════════════════
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
// IOT — Réception ESP32 (sans auth, s'identifie via organisation_id)
// ════════════════════════════════════════════════════════════
app.post("/api/capteurs", (req, res) => {
  const { organisation_id, equipement_id, etat, panne, param1, param2, param3, param4, param5, param6, param7, param8 } = req.body;
  if (!organisation_id || !equipement_id) return res.status(400).json({ erreur: "organisation_id et equipement_id sont obligatoires" });
  try {
    db.prepare("INSERT INTO iot_data (organisation_id,equipement_id,etat,panne,param1,param2,param3,param4,param5,param6,param7,param8,timestamp) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,datetime('now','localtime'))").run(organisation_id, equipement_id, etat?1:0, panne?1:0, param1, param2, param3, param4, param5, param6, param7, param8);
    if (panne) {
      db.prepare("INSERT INTO alertes (organisation_id,equipement_id,type,severite,message,source) VALUES (?,?,'PANNE','CRITIQUE','Panne signalée par capteur','IOT')").run(organisation_id, equipement_id);
      db.prepare("UPDATE equipements SET scoreRisque=MIN(100,scoreRisque+15), statut='En panne' WHERE id=? AND organisation_id=?").run(equipement_id, organisation_id);
    }
    res.json({ message: "Données IoT reçues", timestamp: new Date() });
  } catch (err) {
    res.status(500).json({ erreur: err.message });
  }
});

// ════════════════════════════════════════════════════════════
// CONFIGURATION CAPTEURS (avant middleware global)
// ════════════════════════════════════════════════════════════
app.get("/api/capteurs/config/:equipementId", authMiddleware, (req, res) => {
  try {
    const config = db.prepare("SELECT * FROM equipement_capteurs WHERE equipement_id=? AND organisation_id=?").get(req.params.equipementId, req.user.organisation_id);
    if (!config) {
      return res.json({
        equipement_id: parseInt(req.params.equipementId),
        organisation_id: req.user.organisation_id,
        nb_capteurs_actifs: 2,
        param1_nom:'Température', param1_unite:'°C',
        param2_nom:'Vibration',   param2_unite:'g',
        param3_nom:'Paramètre 3', param3_unite:'',
        param4_nom:'Paramètre 4', param4_unite:'',
        param5_nom:'Paramètre 5', param5_unite:'',
        param6_nom:'Paramètre 6', param6_unite:'',
        param7_nom:'Paramètre 7', param7_unite:'',
        param8_nom:'Paramètre 8', param8_unite:'',
      });
    }
    res.json(config);
  } catch (err) {
    res.status(500).json({ erreur: err.message });
  }
});

// ✅ CORRECTION : 19 colonnes = 19 valeurs dans le .run()
app.post("/api/capteurs/config", authMiddleware, (req, res) => {
  const { equipement_id, nb_capteurs_actifs, param1_nom, param1_unite, param2_nom, param2_unite, param3_nom, param3_unite, param4_nom, param4_unite, param5_nom, param5_unite, param6_nom, param6_unite, param7_nom, param7_unite, param8_nom, param8_unite } = req.body;
  if (!equipement_id) return res.status(400).json({ erreur: "equipement_id est obligatoire" });
  try {
    const result = db.prepare(`
      INSERT INTO equipement_capteurs (
        equipement_id, organisation_id, nb_capteurs_actifs,
        param1_nom, param1_unite, param2_nom, param2_unite,
        param3_nom, param3_unite, param4_nom, param4_unite,
        param5_nom, param5_unite, param6_nom, param6_unite,
        param7_nom, param7_unite, param8_nom, param8_unite
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(equipement_id) DO UPDATE SET
        nb_capteurs_actifs=excluded.nb_capteurs_actifs,
        param1_nom=excluded.param1_nom, param1_unite=excluded.param1_unite,
        param2_nom=excluded.param2_nom, param2_unite=excluded.param2_unite,
        param3_nom=excluded.param3_nom, param3_unite=excluded.param3_unite,
        param4_nom=excluded.param4_nom, param4_unite=excluded.param4_unite,
        param5_nom=excluded.param5_nom, param5_unite=excluded.param5_unite,
        param6_nom=excluded.param6_nom, param6_unite=excluded.param6_unite,
        param7_nom=excluded.param7_nom, param7_unite=excluded.param7_unite,
        param8_nom=excluded.param8_nom, param8_unite=excluded.param8_unite
    `).run(
      equipement_id, req.user.organisation_id, nb_capteurs_actifs||2,
      param1_nom||'Température', param1_unite||'°C',
      param2_nom||'Vibration',   param2_unite||'g',
      param3_nom||'Paramètre 3', param3_unite||'',
      param4_nom||'Paramètre 4', param4_unite||'',
      param5_nom||'Paramètre 5', param5_unite||'',
      param6_nom||'Paramètre 6', param6_unite||'',
      param7_nom||'Paramètre 7', param7_unite||'',
      param8_nom||'Paramètre 8', param8_unite||''
    );
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
  try { res.json(db.prepare("SELECT * FROM equipements WHERE organisation_id=? ORDER BY id DESC").all(req.user.organisation_id)); }
  catch (err) { res.status(500).json({ erreur: err.message }); }
});

app.post("/api/equipements", (req, res) => {
  const { nom, marque, numeroSerie, service, statut, dateAcquisition, prochaineMaintenance } = req.body;
  try {
    const result = db.prepare("INSERT INTO equipements (organisation_id,nom,marque,numeroSerie,service,statut,dateAcquisition,prochaineMaintenance) VALUES (?,?,?,?,?,?,?,?)").run(req.user.organisation_id, nom, marque, numeroSerie, service, statut||"En service", dateAcquisition, prochaineMaintenance);
    res.json({ id: result.lastInsertRowid, organisation_id: req.user.organisation_id, nom, marque, numeroSerie, service, statut, scoreRisque: 0 });
  } catch (err) { res.status(500).json({ erreur: err.message }); }
});

app.delete("/api/equipements/:id", (req, res) => {
  try { res.json({ supprime: db.prepare("DELETE FROM equipements WHERE id=? AND organisation_id=?").run(req.params.id, req.user.organisation_id).changes > 0 }); }
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
