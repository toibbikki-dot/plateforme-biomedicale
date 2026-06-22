const express = require("express");
const Database = require("better-sqlite3");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || "biomedical_secret_key_2026";

app.use(cors());
app.use(express.json());

// ════════════════════════════════════════════════════════════
// CONNEXION BASE DE DONNÉES (better-sqlite3)
// ════════════════════════════════════════════════════════════
const db = new Database(path.join(__dirname, "biomedical.db"));
db.pragma("journal_mode = WAL"); // Meilleures performances
console.log("✅ Base de données connectée");

// ════════════════════════════════════════════════════════════
// CRÉATION DES TABLES
// ════════════════════════════════════════════════════════════
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

  CREATE TABLE IF NOT EXISTS iot_data (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    organisation_id INTEGER NOT NULL,
    equipement_id INTEGER,
    temperature REAL,
    vibration REAL,
    actif INTEGER,
    anomalie INTEGER,
    panne INTEGER,
    timestamp TEXT DEFAULT (datetime('now','localtime'))
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
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
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
  
  if (!nom || !email || !password || !mode) {
    return res.status(400).json({ erreur: "Champs obligatoires manquants" });
  }
  if (password.length < 6) {
    return res.status(400).json({ erreur: "Le mot de passe doit contenir au moins 6 caractères" });
  }

  try {
    const existant = db.prepare("SELECT id FROM utilisateurs WHERE email=?").get(email);
    if (existant) return res.status(409).json({ erreur: "Cet email est déjà utilisé" });

    const hash = bcrypt.hashSync(password, 10);

    // ─── MODE INDIVIDUEL ───────────────────────────────
    if (mode === "INDIVIDUEL") {
      const orgResult = db.prepare("INSERT INTO organisations (nom, type) VALUES (?, 'INDIVIDUEL')")
        .run(`Espace de ${prenom || nom}`);
      const orgId = orgResult.lastInsertRowid;
      
      const userResult = db.prepare(
        "INSERT INTO utilisateurs (organisation_id, nom, prenom, email, password, role) VALUES (?,?,?,?,?,'ADMIN')"
      ).run(orgId, nom, prenom || " ", email, hash);
      
      return creerSessionEtRepondre(userResult.lastInsertRowid, res);
    }

    // ─── MODE CRÉER UNE ORGANISATION ───────────────────
    if (mode === "CREER_ORGANISATION") {
      if (!nomOrganisation) return res.status(400).json({ erreur: "Le nom de l'organisation est obligatoire" });
      const code = genererCodeInvitation();
      
      const orgResult = db.prepare(
        "INSERT INTO organisations (nom, type, code_invitation) VALUES (?, 'ORGANISATION', ?)"
      ).run(nomOrganisation, code);
      const orgId = orgResult.lastInsertRowid;
      
      const userResult = db.prepare(
        "INSERT INTO utilisateurs (organisation_id, nom, prenom, email, password, role) VALUES (?,?,?,?,?,'ADMIN')"
      ).run(orgId, nom, prenom || " ", email, hash);
      
      return creerSessionEtRepondre(userResult.lastInsertRowid, res, { codeGenere: code });
    }

    // ─── MODE REJOINDRE UNE ORGANISATION ───────────────
    if (mode === "REJOINDRE_ORGANISATION") {
      if (!codeInvitation) return res.status(400).json({ erreur: "Le code d'invitation est obligatoire" });
      
      const org = db.prepare("SELECT * FROM organisations WHERE code_invitation=?")
        .get(codeInvitation.toUpperCase().trim());
      if (!org) return res.status(404).json({ erreur: "Code d'invitation invalide" });
      
      const userResult = db.prepare(
        "INSERT INTO utilisateurs (organisation_id, nom, prenom, email, password, role) VALUES (?,?,?,?,?,'TECHNICIEN')"
      ).run(org.id, nom, prenom || " ", email, hash);
      
      return creerSessionEtRepondre(userResult.lastInsertRowid, res);
    }

    return res.status(400).json({ erreur: "Mode d'inscription invalide" });
  } catch (err) {
    console.error("❌ Erreur inscription:", err);
    return res.status(500).json({ erreur: err.message });
  }
});

function creerSessionEtRepondre(userId, res, extra = {}) {
  try {
    const user = db.prepare(`
      SELECT u.*, o.nom as organisationNom, o.type as organisationType, o.code_invitation 
      FROM utilisateurs u 
      JOIN organisations o ON u.organisation_id = o.id 
      WHERE u.id=?
    `).get(userId);

    if (!user) return res.status(500).json({ erreur: "Erreur lors de la création du compte" });

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, organisation_id: user.organisation_id, nom: user.nom, prenom: user.prenom },
      JWT_SECRET, { expiresIn: "8h" }
    );

    db.prepare("INSERT OR IGNORE INTO preferences (user_id) VALUES (?)").run(user.id);

    res.json({
      token,
      user: { id: user.id, nom: user.nom, prenom: user.prenom, email: user.email, role: user.role },
      organisation: { id: user.organisation_id, nom: user.organisationNom, type: user.organisationType, code_invitation: user.code_invitation },
      preferences: { monitoring_actif: 0, monitoring_equip_id: 1 },
      ...extra,
    });
  } catch (err) {
    console.error("❌ Erreur session:", err);
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
    const user = db.prepare(`
      SELECT u.*, o.nom as organisationNom, o.type as organisationType, o.code_invitation 
      FROM utilisateurs u 
      JOIN organisations o ON u.organisation_id = o.id 
      WHERE u.email=? AND u.actif=1
    `).get(email);

    if (!user) return res.status(401).json({ erreur: "Email ou mot de passe incorrect" });
    if (!bcrypt.compareSync(password, user.password)) {
      return res.status(401).json({ erreur: "Email ou mot de passe incorrect" });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, organisation_id: user.organisation_id, nom: user.nom, prenom: user.prenom },
      JWT_SECRET, { expiresIn: "8h" }
    );

    const pref = db.prepare("SELECT * FROM preferences WHERE user_id=?").get(user.id);

    console.log(`🔑 Connexion : ${user.prenom} ${user.nom} (${user.email}) | organisation_id = ${user.organisation_id} | organisation = "${user.organisationNom}"`);

    res.json({
      token,
      user: { id: user.id, nom: user.nom, prenom: user.prenom, email: user.email, role: user.role },
      organisation: { id: user.organisation_id, nom: user.organisationNom, type: user.organisationType, code_invitation: user.code_invitation },
      preferences: pref || { monitoring_actif: 0, monitoring_equip_id: 1 },
    });
  } catch (err) {
    console.error("❌ Erreur login:", err);
    res.status(500).json({ erreur: err.message });
  }
});

// ════════════════════════════════════════════════════════════
// IOT — Réception des données ESP32
// ════════════════════════════════════════════════════════════
app.post("/api/capteurs", (req, res) => {
  const { organisation_id, equipement_id, temperature, vibration, actif, anomalie, panne } = req.body;
  
  if (!organisation_id || !equipement_id) {
    return res.status(400).json({ erreur: "organisation_id et equipement_id sont obligatoires" });
  }

  console.log(`📡 IoT [Org #${organisation_id}] Équipement ${equipement_id} | Temp: ${temperature}°C | Vib: ${vibration}g`);

  try {
    db.prepare(`
      INSERT INTO iot_data (organisation_id,equipement_id,temperature,vibration,actif,anomalie,panne,timestamp) 
      VALUES (?,?,?,?,?,?,?,datetime('now','localtime'))
    `).run(organisation_id, equipement_id, temperature, vibration, actif ? 1 : 0, anomalie ? 1 : 0, panne ? 1 : 0);

    if (anomalie || panne) {
      const severite = panne ? "CRITIQUE" : temperature > 60 ? "HAUTE" : "MOYENNE";
      const msg = panne 
        ? `Panne signalée — Temp: ${temperature}°C, Vib: ${vibration}g` 
        : `Anomalie — Temp: ${temperature}°C, Vib: ${vibration}g`;

      db.prepare(`
        INSERT INTO alertes (organisation_id,equipement_id,type,severite,message,source) 
        VALUES (?,?,?,?,?,?)
      `).run(organisation_id, equipement_id, panne ? "PANNE" : "ANOMALIE_IOT", severite, msg, "IOT");

      db.prepare(`
        UPDATE equipements 
        SET scoreRisque=MIN(100,scoreRisque+?), statut=CASE WHEN ?=1 THEN 'En panne' ELSE statut END 
        WHERE id=? AND organisation_id=?
      `).run(panne ? 15 : 5, panne ? 1 : 0, equipement_id, organisation_id);
    }

    res.json({ message: "Données IoT reçues", timestamp: new Date() });
  } catch (err) {
    console.error("❌ Erreur IoT:", err);
    res.status(500).json({ erreur: err.message });
  }
});

// ════════════════════════════════════════════════════════════
// MIDDLEWARE GLOBAL
// ════════════════════════════════════════════════════════════
app.use("/api", authMiddleware);

// ─── ÉQUIPEMENTS ────────────────────────────────────────────
app.get("/api/equipements", (req, res) => {
  try {
    const rows = db.prepare("SELECT * FROM equipements WHERE organisation_id=? ORDER BY id DESC")
      .all(req.user.organisation_id);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ erreur: err.message });
  }
});

app.post("/api/equipements", (req, res) => {
  const { nom, marque, numeroSerie, service, statut, dateAcquisition, prochaineMaintenance } = req.body;
  
  try {
    const result = db.prepare(`
      INSERT INTO equipements (organisation_id,nom,marque,numeroSerie,service,statut,dateAcquisition,prochaineMaintenance) 
      VALUES (?,?,?,?,?,?,?,?)
    `).run(req.user.organisation_id, nom, marque, numeroSerie, service, statut || "En service", dateAcquisition, prochaineMaintenance);

    res.json({ 
      id: result.lastInsertRowid, 
      organisation_id: req.user.organisation_id, 
      nom, marque, numeroSerie, service, statut, scoreRisque: 0 
    });
  } catch (err) {
    res.status(500).json({ erreur: err.message });
  }
});

app.delete("/api/equipements/:id", (req, res) => {
  try {
    const result = db.prepare("DELETE FROM equipements WHERE id=? AND organisation_id=?")
      .run(req.params.id, req.user.organisation_id);
    res.json({ supprime: result.changes > 0 });
  } catch (err) {
    res.status(500).json({ erreur: err.message });
  }
});

// ─── MAINTENANCES ───────────────────────────────────────────
app.get("/api/maintenances", (req, res) => {
  try {
    const rows = db.prepare("SELECT * FROM maintenances WHERE organisation_id=? ORDER BY datePlanifiee DESC")
      .all(req.user.organisation_id);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ erreur: err.message });
  }
});

app.post("/api/maintenances", (req, res) => {
  const { equipementId, equipementNom, type, statut, datePlanifiee, technicien, description } = req.body;
  
  try {
    const result = db.prepare(`
      INSERT INTO maintenances (organisation_id,equipementId,equipementNom,type,statut,datePlanifiee,technicien,description) 
      VALUES (?,?,?,?,?,?,?,?)
    `).run(req.user.organisation_id, equipementId, equipementNom, type || "Préventive", statut || "Planifiée", datePlanifiee, technicien, description);

    res.json({ 
      id: result.lastInsertRowid, 
      organisation_id: req.user.organisation_id, 
      equipementId, equipementNom, type, statut, datePlanifiee, technicien, description 
    });
  } catch (err) {
    res.status(500).json({ erreur: err.message });
  }
});

// ─── ALERTES ────────────────────────────────────────────────
app.get("/api/alertes", (req, res) => {
  try {
    const rows = db.prepare("SELECT * FROM alertes WHERE organisation_id=? ORDER BY createdAt DESC LIMIT 50")
      .all(req.user.organisation_id);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ erreur: err.message });
  }
});

app.patch("/api/alertes/:id/lire", (req, res) => {
  try {
    const result = db.prepare("UPDATE alertes SET estLue=1 WHERE id=? AND organisation_id=?")
      .run(req.params.id, req.user.organisation_id);
    res.json({ misAJour: result.changes > 0 });
  } catch (err) {
    res.status(500).json({ erreur: err.message });
  }
});

// ─── CAPTEURS IOT ───────────────────────────────────────────
app.get("/api/capteurs/:equipementId", (req, res) => {
  try {
    const rows = db.prepare("SELECT * FROM iot_data WHERE equipement_id=? AND organisation_id=? ORDER BY id DESC LIMIT 30")
      .all(req.params.equipementId, req.user.organisation_id);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ erreur: err.message });
  }
});

// ─── PRÉFÉRENCES ────────────────────────────────────────────
app.post("/api/preferences/monitoring", (req, res) => {
  const { monitoring_actif, monitoring_equip_id } = req.body;
  
  try {
    db.prepare(`
      INSERT INTO preferences (user_id, monitoring_actif, monitoring_equip_id) 
      VALUES (?,?,?) 
      ON CONFLICT(user_id) DO UPDATE SET monitoring_actif=excluded.monitoring_actif, monitoring_equip_id=excluded.monitoring_equip_id
    `).run(req.user.id, monitoring_actif ? 1 : 0, monitoring_equip_id);
    
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ erreur: err.message });
  }
});

// ─── UTILISATEURS ───────────────────────────────────────────
app.get("/api/utilisateurs", requireAdmin, (req, res) => {
  try {
    const rows = db.prepare("SELECT id,nom,prenom,email,role,actif,createdAt FROM utilisateurs WHERE organisation_id=? ORDER BY id")
      .all(req.user.organisation_id);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ erreur: err.message });
  }
});

app.post("/api/utilisateurs", requireAdmin, (req, res) => {
  const { nom, prenom, email, password, role } = req.body;
  
  if (!nom || !email || !password) return res.status(400).json({ erreur: "Champs obligatoires manquants" });

  try {
    const hash = bcrypt.hashSync(password, 10);
    const result = db.prepare(
      "INSERT INTO utilisateurs (organisation_id,nom,prenom,email,password,role) VALUES (?,?,?,?,?,?)"
    ).run(req.user.organisation_id, nom, prenom || " ", email, hash, role || "TECHNICIEN");

    res.json({ id: result.lastInsertRowid, nom, prenom, email, role });
  } catch (err) {
    if (err.message.includes("UNIQUE")) return res.status(409).json({ erreur: "Cet email est déjà utilisé" });
    res.status(500).json({ erreur: err.message });
  }
});

app.patch("/api/utilisateurs/:id/desactiver", requireAdmin, (req, res) => {
  try {
    const result = db.prepare("UPDATE utilisateurs SET actif=0 WHERE id=? AND organisation_id=?")
      .run(req.params.id, req.user.organisation_id);
    res.json({ misAJour: result.changes > 0 });
  } catch (err) {
    res.status(500).json({ erreur: err.message });
  }
});

app.patch("/api/utilisateurs/:id/reactiver", requireAdmin, (req, res) => {
  try {
    const result = db.prepare("UPDATE utilisateurs SET actif=1 WHERE id=? AND organisation_id=?")
      .run(req.params.id, req.user.organisation_id);
    res.json({ misAJour: result.changes > 0 });
  } catch (err) {
    res.status(500).json({ erreur: err.message });
  }
});

// ─── INFO ORGANISATION ──────────────────────────────────────
app.get("/api/organisation", (req, res) => {
  try {
    const org = db.prepare("SELECT id,nom,type,code_invitation FROM organisations WHERE id=?")
      .get(req.user.organisation_id);
    res.json(org);
  } catch (err) {
    res.status(500).json({ erreur: err.message });
  }
});

// ════════════════════════════════════════════════════════════
// DÉMARRAGE SERVEUR
// ════════════════════════════════════════════════════════════
app.listen(PORT, () => {
  console.log(`🚀 Serveur backend démarré sur le port ${PORT}`);
  console.log(`📡 Mode multi-organisation activé`);
});