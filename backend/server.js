const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || "biomedical_secret_key_2026";

app.use(cors());
app.use(express.json());

const db = new sqlite3.Database(path.join(__dirname, "biomedical.db"), (err) => {
  if (err) console.error("❌ Erreur DB:", err.message);
  else console.log("✅ Base de données connectée");
});

// ════════════════════════════════════════════════════════════
// CRÉATION DES TABLES
// ════════════════════════════════════════════════════════════
db.serialize(() => {
  // Table des organisations (= "espaces de travail")
  // Un espace "individuel" est aussi une organisation, mais avec type='INDIVIDUEL' et un seul membre
  db.run(`CREATE TABLE IF NOT EXISTS organisations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nom TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'ORGANISATION',
    code_invitation TEXT UNIQUE,
    createdAt TEXT DEFAULT (datetime('now','localtime'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS utilisateurs (
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
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS equipements (
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
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS maintenances (
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
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS alertes (
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
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS iot_data (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    organisation_id INTEGER NOT NULL,
    equipement_id INTEGER,
    temperature REAL,
    vibration REAL,
    actif INTEGER,
    anomalie INTEGER,
    panne INTEGER,
    timestamp TEXT DEFAULT (datetime('now','localtime'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS preferences (
    user_id INTEGER PRIMARY KEY,
    monitoring_actif INTEGER DEFAULT 0,
    monitoring_equip_id INTEGER DEFAULT 1
  )`);

  console.log("✅ Tables vérifiées/créées (mode multi-organisation)");
});

// ════════════════════════════════════════════════════════════
// UTILITAIRES
// ════════════════════════════════════════════════════════════
function genererCodeInvitation() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // sans 0/O/1/I pour éviter confusion
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
    req.user = decoded; // { id, email, role, organisation_id, nom, prenom }
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
// AUTH — INSCRIPTION (3 scénarios : individuel / créer organisation / rejoindre)
// ════════════════════════════════════════════════════════════
app.post("/api/auth/inscription", (req, res) => {
  const { nom, prenom, email, password, mode, nomOrganisation, codeInvitation } = req.body;

  if (!nom || !email || !password || !mode) {
    return res.status(400).json({ erreur: "Champs obligatoires manquants" });
  }
  if (password.length < 6) {
    return res.status(400).json({ erreur: "Le mot de passe doit contenir au moins 6 caractères" });
  }

  db.get("SELECT id FROM utilisateurs WHERE email=?", [email], (err, existant) => {
    if (err) return res.status(500).json({ erreur: err.message });
    if (existant) return res.status(409).json({ erreur: "Cet email est déjà utilisé" });

    const hash = bcrypt.hashSync(password, 10);

    // ─── MODE INDIVIDUEL ───────────────────────────────
    if (mode === "INDIVIDUEL") {
      db.run(`INSERT INTO organisations (nom, type) VALUES (?, 'INDIVIDUEL')`,
        [`Espace de ${prenom || nom}`],
        function (errOrg) {
          if (errOrg) return res.status(500).json({ erreur: errOrg.message });
          const orgId = this.lastID;
          db.run(`INSERT INTO utilisateurs (organisation_id, nom, prenom, email, password, role) VALUES (?,?,?,?,?,'ADMIN')`,
            [orgId, nom, prenom || "", email, hash],
            function (errUser) {
              if (errUser) return res.status(500).json({ erreur: errUser.message });
              return creerSessionEtRepondre(this.lastID, res);
            });
        });
      return;
    }

    // ─── MODE CRÉER UNE ORGANISATION ───────────────────
    if (mode === "CREER_ORGANISATION") {
      if (!nomOrganisation) return res.status(400).json({ erreur: "Le nom de l'organisation est obligatoire" });
      const code = genererCodeInvitation();
      db.run(`INSERT INTO organisations (nom, type, code_invitation) VALUES (?, 'ORGANISATION', ?)`,
        [nomOrganisation, code],
        function (errOrg) {
          if (errOrg) return res.status(500).json({ erreur: errOrg.message });
          const orgId = this.lastID;
          db.run(`INSERT INTO utilisateurs (organisation_id, nom, prenom, email, password, role) VALUES (?,?,?,?,?,'ADMIN')`,
            [orgId, nom, prenom || "", email, hash],
            function (errUser) {
              if (errUser) return res.status(500).json({ erreur: errUser.message });
              return creerSessionEtRepondre(this.lastID, res, { codeGenere: code });
            });
        });
      return;
    }

    // ─── MODE REJOINDRE UNE ORGANISATION ───────────────
    if (mode === "REJOINDRE_ORGANISATION") {
      if (!codeInvitation) return res.status(400).json({ erreur: "Le code d'invitation est obligatoire" });
      db.get("SELECT * FROM organisations WHERE code_invitation=?", [codeInvitation.toUpperCase().trim()], (errOrg, org) => {
        if (errOrg) return res.status(500).json({ erreur: errOrg.message });
        if (!org) return res.status(404).json({ erreur: "Code d'invitation invalide" });
        db.run(`INSERT INTO utilisateurs (organisation_id, nom, prenom, email, password, role) VALUES (?,?,?,?,?,'TECHNICIEN')`,
          [org.id, nom, prenom || "", email, hash],
          function (errUser) {
            if (errUser) return res.status(500).json({ erreur: errUser.message });
            return creerSessionEtRepondre(this.lastID, res);
          });
      });
      return;
    }

    return res.status(400).json({ erreur: "Mode d'inscription invalide" });
  });
});

function creerSessionEtRepondre(userId, res, extra = {}) {
  db.get(`SELECT u.*, o.nom as organisationNom, o.type as organisationType, o.code_invitation
          FROM utilisateurs u JOIN organisations o ON u.organisation_id = o.id
          WHERE u.id=?`, [userId], (err, user) => {
    if (err || !user) return res.status(500).json({ erreur: "Erreur lors de la création du compte" });
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, organisation_id: user.organisation_id, nom: user.nom, prenom: user.prenom },
      JWT_SECRET, { expiresIn: "8h" }
    );
    db.run(`INSERT OR IGNORE INTO preferences (user_id) VALUES (?)`, [user.id]);
    res.json({
      token,
      user: { id: user.id, nom: user.nom, prenom: user.prenom, email: user.email, role: user.role },
      organisation: { id: user.organisation_id, nom: user.organisationNom, type: user.organisationType, code_invitation: user.code_invitation },
      preferences: { monitoring_actif: 0, monitoring_equip_id: 1 },
      ...extra,
    });
  });
}

// ════════════════════════════════════════════════════════════
// AUTH — CONNEXION
// ════════════════════════════════════════════════════════════
app.post("/api/auth/login", (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ erreur: "Champs obligatoires" });

  db.get(`SELECT u.*, o.nom as organisationNom, o.type as organisationType, o.code_invitation
          FROM utilisateurs u JOIN organisations o ON u.organisation_id = o.id
          WHERE u.email=? AND u.actif=1`, [email], (err, user) => {
    if (err) return res.status(500).json({ erreur: err.message });
    if (!user) return res.status(401).json({ erreur: "Email ou mot de passe incorrect" });
    if (!bcrypt.compareSync(password, user.password)) {
      return res.status(401).json({ erreur: "Email ou mot de passe incorrect" });
    }
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, organisation_id: user.organisation_id, nom: user.nom, prenom: user.prenom },
      JWT_SECRET, { expiresIn: "8h" }
    );
    db.get("SELECT * FROM preferences WHERE user_id=?", [user.id], (err2, pref) => {
      console.log(`🔑 Connexion : ${user.prenom} ${user.nom} (${user.email}) | organisation_id = ${user.organisation_id} | organisation = "${user.organisationNom}"`);
      res.json({
        token,
        user: { id: user.id, nom: user.nom, prenom: user.prenom, email: user.email, role: user.role },
        organisation: { id: user.organisation_id, nom: user.organisationNom, type: user.organisationType, code_invitation: user.code_invitation },
        preferences: pref || { monitoring_actif: 0, monitoring_equip_id: 1 },
      });
    });
  });
});

// ════════════════════════════════════════════════════════════
// IOT — Réception des données ESP32 (PAS de token JWT ici : un microcontrôleur
// ne peut pas se connecter comme un utilisateur. Il s'identifie via son
// organisation_id, fixé une fois pour toutes dans le code Arduino).
// ════════════════════════════════════════════════════════════
app.post("/api/capteurs", (req, res) => {
  const { organisation_id, equipement_id, temperature, vibration, actif, anomalie, panne } = req.body;

  if (!organisation_id || !equipement_id) {
    return res.status(400).json({ erreur: "organisation_id et equipement_id sont obligatoires" });
  }

  console.log(`📡 IoT [Org #${organisation_id}] Équipement ${equipement_id} | Temp: ${temperature}°C | Vib: ${vibration}g`);

  db.run(`INSERT INTO iot_data (organisation_id,equipement_id,temperature,vibration,actif,anomalie,panne,timestamp) VALUES (?,?,?,?,?,?,?,datetime('now','localtime'))`,
    [organisation_id, equipement_id, temperature, vibration, actif ? 1 : 0, anomalie ? 1 : 0, panne ? 1 : 0]
  );

  if (anomalie || panne) {
    const severite = panne ? "CRITIQUE" : temperature > 60 ? "HAUTE" : "MOYENNE";
    const msg = panne
      ? `Panne signalée — Temp: ${temperature}°C, Vib: ${vibration}g`
      : `Anomalie — Temp: ${temperature}°C, Vib: ${vibration}g`;
    db.run(`INSERT INTO alertes (organisation_id,equipement_id,type,severite,message,source) VALUES (?,?,?,?,?,?)`,
      [organisation_id, equipement_id, panne ? "PANNE" : "ANOMALIE_IOT", severite, msg, "IOT"]);
    db.run(`UPDATE equipements SET scoreRisque=MIN(100,scoreRisque+?), statut=CASE WHEN ?=1 THEN 'En panne' ELSE statut END WHERE id=? AND organisation_id=?`,
      [panne ? 15 : 5, panne ? 1 : 0, equipement_id, organisation_id]);
  }

  res.json({ message: "Données IoT reçues", timestamp: new Date() });
});

// ════════════════════════════════════════════════════════════
// MIDDLEWARE GLOBAL — toutes les routes ci-dessous nécessitent un token
// ════════════════════════════════════════════════════════════
app.use("/api", authMiddleware);

// ─── ÉQUIPEMENTS (filtrés par organisation) ─────────────────
app.get("/api/equipements", (req, res) => {
  db.all("SELECT * FROM equipements WHERE organisation_id=? ORDER BY id DESC", [req.user.organisation_id], (err, rows) => {
    if (err) return res.status(500).json({ erreur: err.message });
    res.json(rows);
  });
});

app.post("/api/equipements", (req, res) => {
  const { nom, marque, numeroSerie, service, statut, dateAcquisition, prochaineMaintenance } = req.body;
  db.run(`INSERT INTO equipements (organisation_id,nom,marque,numeroSerie,service,statut,dateAcquisition,prochaineMaintenance) VALUES (?,?,?,?,?,?,?,?)`,
    [req.user.organisation_id, nom, marque, numeroSerie, service, statut || "En service", dateAcquisition, prochaineMaintenance],
    function (err) {
      if (err) return res.status(500).json({ erreur: err.message });
      res.json({ id: this.lastID, organisation_id: req.user.organisation_id, nom, marque, numeroSerie, service, statut, scoreRisque: 0 });
    });
});

app.delete("/api/equipements/:id", (req, res) => {
  db.run("DELETE FROM equipements WHERE id=? AND organisation_id=?", [req.params.id, req.user.organisation_id], function (err) {
    if (err) return res.status(500).json({ erreur: err.message });
    res.json({ supprime: this.changes > 0 });
  });
});

// ─── MAINTENANCES (filtrées par organisation) ───────────────
app.get("/api/maintenances", (req, res) => {
  db.all("SELECT * FROM maintenances WHERE organisation_id=? ORDER BY datePlanifiee DESC", [req.user.organisation_id], (err, rows) => {
    if (err) return res.status(500).json({ erreur: err.message });
    res.json(rows);
  });
});

app.post("/api/maintenances", (req, res) => {
  const { equipementId, equipementNom, type, statut, datePlanifiee, technicien, description } = req.body;
  db.run(`INSERT INTO maintenances (organisation_id,equipementId,equipementNom,type,statut,datePlanifiee,technicien,description) VALUES (?,?,?,?,?,?,?,?)`,
    [req.user.organisation_id, equipementId, equipementNom, type || "Préventive", statut || "Planifiée", datePlanifiee, technicien, description],
    function (err) {
      if (err) return res.status(500).json({ erreur: err.message });
      res.json({ id: this.lastID, organisation_id: req.user.organisation_id, equipementId, equipementNom, type, statut, datePlanifiee, technicien, description });
    });
});

// ─── ALERTES (filtrées par organisation) ────────────────────
app.get("/api/alertes", (req, res) => {
  db.all("SELECT * FROM alertes WHERE organisation_id=? ORDER BY createdAt DESC LIMIT 50", [req.user.organisation_id], (err, rows) => {
    if (err) return res.status(500).json({ erreur: err.message });
    res.json(rows);
  });
});

app.patch("/api/alertes/:id/lire", (req, res) => {
  db.run("UPDATE alertes SET estLue=1 WHERE id=? AND organisation_id=?", [req.params.id, req.user.organisation_id], function (err) {
    if (err) return res.status(500).json({ erreur: err.message });
    res.json({ misAJour: this.changes > 0 });
  });
});

// ─── CAPTEURS IOT (filtrés par organisation) ────────────────
app.get("/api/capteurs/:equipementId", (req, res) => {
  db.all("SELECT * FROM iot_data WHERE equipement_id=? AND organisation_id=? ORDER BY id DESC LIMIT 30",
    [req.params.equipementId, req.user.organisation_id], (err, rows) => {
      if (err) return res.status(500).json({ erreur: err.message });
      res.json(rows);
    });
});

// ─── PRÉFÉRENCES ─────────────────────────────────────────────
app.post("/api/preferences/monitoring", (req, res) => {
  const { monitoring_actif, monitoring_equip_id } = req.body;
  db.run(`INSERT INTO preferences (user_id, monitoring_actif, monitoring_equip_id) VALUES (?,?,?)
          ON CONFLICT(user_id) DO UPDATE SET monitoring_actif=excluded.monitoring_actif, monitoring_equip_id=excluded.monitoring_equip_id`,
    [req.user.id, monitoring_actif ? 1 : 0, monitoring_equip_id],
    (err) => {
      if (err) return res.status(500).json({ erreur: err.message });
      res.json({ ok: true });
    });
});

// ─── UTILISATEURS (uniquement visibles si organisation, pas en mode individuel) ─
app.get("/api/utilisateurs", requireAdmin, (req, res) => {
  db.all("SELECT id,nom,prenom,email,role,actif,createdAt FROM utilisateurs WHERE organisation_id=? ORDER BY id",
    [req.user.organisation_id], (err, rows) => {
      if (err) return res.status(500).json({ erreur: err.message });
      res.json(rows);
    });
});

app.post("/api/utilisateurs", requireAdmin, (req, res) => {
  const { nom, prenom, email, password, role } = req.body;
  if (!nom || !email || !password) return res.status(400).json({ erreur: "Champs obligatoires manquants" });
  const hash = bcrypt.hashSync(password, 10);
  db.run(`INSERT INTO utilisateurs (organisation_id,nom,prenom,email,password,role) VALUES (?,?,?,?,?,?)`,
    [req.user.organisation_id, nom, prenom || "", email, hash, role || "TECHNICIEN"],
    function (err) {
      if (err) {
        if (err.message.includes("UNIQUE")) return res.status(409).json({ erreur: "Cet email est déjà utilisé" });
        return res.status(500).json({ erreur: err.message });
      }
      res.json({ id: this.lastID, nom, prenom, email, role });
    });
});

app.patch("/api/utilisateurs/:id/desactiver", requireAdmin, (req, res) => {
  db.run("UPDATE utilisateurs SET actif=0 WHERE id=? AND organisation_id=?", [req.params.id, req.user.organisation_id], function (err) {
    if (err) return res.status(500).json({ erreur: err.message });
    res.json({ misAJour: this.changes > 0 });
  });
});

app.patch("/api/utilisateurs/:id/reactiver", requireAdmin, (req, res) => {
  db.run("UPDATE utilisateurs SET actif=1 WHERE id=? AND organisation_id=?", [req.params.id, req.user.organisation_id], function (err) {
    if (err) return res.status(500).json({ erreur: err.message });
    res.json({ misAJour: this.changes > 0 });
  });
});

// ─── INFO ORGANISATION (pour afficher le code d'invitation à l'admin) ──
app.get("/api/organisation", (req, res) => {
  db.get("SELECT id,nom,type,code_invitation FROM organisations WHERE id=?", [req.user.organisation_id], (err, org) => {
    if (err) return res.status(500).json({ erreur: err.message });
    res.json(org);
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Serveur backend démarré sur le port ${PORT}`);
  console.log(`📡 Mode multi-organisation activé`);
});
