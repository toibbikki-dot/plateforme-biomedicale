const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const cors = require("cors");
const path = require("path");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const app = express();
const PORT = 3001; 
const JWT_SECRET = "biomedical_secret_2024";

app.use(cors());
app.use(express.json());

const db = new sqlite3.Database(
  path.join(__dirname, "biomedical.db"),
  (err) => {
    if (err) console.error("Erreur DB:", err.message);
    else console.log("✅ Base de données connectée !");
  }
);

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS utilisateurs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nom TEXT NOT NULL,
    prenom TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role TEXT DEFAULT 'TECHNICIEN',
    actif INTEGER DEFAULT 1,
    createdAt TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS equipements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nom TEXT NOT NULL,
    marque TEXT,
    numeroSerie TEXT UNIQUE NOT NULL,
    service TEXT,
    statut TEXT DEFAULT 'En service',
    dateAcquisition TEXT,
    prochaineMaintenance TEXT,
    scoreRisque INTEGER DEFAULT 20,
    createdAt TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS maintenances (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    equipementId INTEGER,
    equipementNom TEXT,
    type TEXT DEFAULT 'Préventive',
    statut TEXT DEFAULT 'Planifiée',
    datePlanifiee TEXT,
    technicien TEXT,
    description TEXT,
    createdAt TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (equipementId) REFERENCES equipements(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS iot_data (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    equipement_id INTEGER,
    temperature REAL,
    vibration REAL,
    actif INTEGER DEFAULT 1,
    anomalie INTEGER DEFAULT 0,
    panne INTEGER DEFAULT 0,
    statut TEXT,
    timestamp TEXT DEFAULT (datetime('now','localtime'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS alertes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    equipement_id INTEGER,
    type TEXT,
    severite TEXT,
    message TEXT,
    source TEXT,
    estLue INTEGER DEFAULT 0,
    createdAt TEXT DEFAULT (datetime('now','localtime'))
  )`);

  // Préférences utilisateur (monitoring ON/OFF)
  db.run(`CREATE TABLE IF NOT EXISTS preferences (
    user_id INTEGER PRIMARY KEY,
    monitoring_actif INTEGER DEFAULT 0,
    monitoring_equip_id INTEGER DEFAULT 1,
    updatedAt TEXT DEFAULT (datetime('now'))
  )`);

  db.get("SELECT COUNT(*) as count FROM utilisateurs", (err, row) => {
    if (row && row.count === 0) {
      const users = [
        ["Administrateur","Système","admin@biomedical.dz",bcrypt.hashSync("admin123",10),"ADMIN"],
        ["Benali","Karim","ingenieur@biomedical.dz",bcrypt.hashSync("ingenieur123",10),"INGENIEUR"],
        ["Djouder","Amina","technicien@biomedical.dz",bcrypt.hashSync("technicien123",10),"TECHNICIEN"],
      ];
      users.forEach(u => db.run(`INSERT INTO utilisateurs (nom,prenom,email,password,role) VALUES (?,?,?,?,?)`, u));
      console.log("✅ Utilisateurs par défaut créés !");
    }
  });

  db.get("SELECT COUNT(*) as count FROM equipements", (err, row) => {
    if (row && row.count === 0) {
      const equips = [
        ["Électrocardiographe 12 pistes","GE Healthcare","ECG-2023-042","Cardiologie","En service","2023-03-15","2024-09-15",72],
        ["Moniteur de signes vitaux","Philips","MSV-2022-018","Réanimation","En maintenance","2022-07-10","2024-07-10",45],
        ["Défibrillateur automatique","Zoll","DEF-2021-007","Urgences","En panne","2021-11-20","2024-05-20",91],
        ["Pompe à perfusion","B.Braun","PAP-2023-055","Chirurgie","En service","2023-01-08","2024-12-08",28],
        ["Échographe portable","Mindray","ECH-2022-031","Radiologie","En service","2022-05-22","2024-11-22",55],
      ];
      equips.forEach(e => db.run(`INSERT INTO equipements (nom,marque,numeroSerie,service,statut,dateAcquisition,prochaineMaintenance,scoreRisque) VALUES (?,?,?,?,?,?,?,?)`, e));
      const maints = [
        [1,"Électrocardiographe 12 pistes","Préventive","Planifiée","2024-09-15","Karim Benali","Vérification générale"],
        [3,"Défibrillateur automatique","Corrective","En cours","2024-07-01","Amina Djouder","Remplacement batterie"],
        [2,"Moniteur de signes vitaux","Préventive","Terminée","2024-06-10","Karim Benali","Nettoyage firmware"],
      ];
      maints.forEach(m => db.run(`INSERT INTO maintenances (equipementId,equipementNom,type,statut,datePlanifiee,technicien,description) VALUES (?,?,?,?,?,?,?)`, m));
      console.log("✅ Données de démonstration insérées !");
    }
  });
});

// ── Middleware Auth ──────────────────────────────────────────
function verifierToken(req, res, next) {
  const token = req.headers["authorization"]?.split(" ")[1];
  if (!token) return res.status(401).json({ erreur: "Token manquant" });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ erreur: "Token invalide" }); }
}

function verifierRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) return res.status(403).json({ erreur: "Accès refusé" });
    next();
  };
}

// ── Auth ─────────────────────────────────────────────────────
app.post("/api/auth/login", (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ erreur: "Champs obligatoires" });
  db.get("SELECT * FROM utilisateurs WHERE email=? AND actif=1", [email], (err, user) => {
    if (err) return res.status(500).json({ erreur: err.message });
    if (!user) return res.status(401).json({ erreur: "Email ou mot de passe incorrect" });
    if (!bcrypt.compareSync(password, user.password)) return res.status(401).json({ erreur: "Email ou mot de passe incorrect" });
    const token = jwt.sign({ id:user.id, email:user.email, role:user.role, nom:user.nom, prenom:user.prenom }, JWT_SECRET, { expiresIn:"8h" });
    // Charger préférences monitoring
    db.get("SELECT * FROM preferences WHERE user_id=?", [user.id], (err2, pref) => {
      res.json({
        token,
        user: { id:user.id, nom:user.nom, prenom:user.prenom, email:user.email, role:user.role },
        preferences: pref || { monitoring_actif: 0, monitoring_equip_id: 1 }
      });
    });
  });
});

app.get("/api/auth/me", verifierToken, (req, res) => {
  db.get("SELECT id,nom,prenom,email,role FROM utilisateurs WHERE id=?", [req.user.id], (err, row) => {
    if (err) return res.status(500).json({ erreur: err.message });
    res.json(row);
  });
});

// ── Préférences monitoring ────────────────────────────────────
app.post("/api/preferences/monitoring", verifierToken, (req, res) => {
  const { monitoring_actif, monitoring_equip_id } = req.body;
  db.run(`INSERT INTO preferences (user_id, monitoring_actif, monitoring_equip_id, updatedAt)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      monitoring_actif=excluded.monitoring_actif,
      monitoring_equip_id=excluded.monitoring_equip_id,
      updatedAt=excluded.updatedAt`,
    [req.user.id, monitoring_actif ? 1 : 0, monitoring_equip_id || 1],
    function(err) {
      if (err) return res.status(500).json({ erreur: err.message });
      res.json({ message: "Préférences sauvegardées" });
    }
  );
});

app.get("/api/preferences/monitoring", verifierToken, (req, res) => {
  db.get("SELECT * FROM preferences WHERE user_id=?", [req.user.id], (err, row) => {
    if (err) return res.status(500).json({ erreur: err.message });
    res.json(row || { monitoring_actif: 0, monitoring_equip_id: 1 });
  });
});

// ── Utilisateurs ─────────────────────────────────────────────
app.get("/api/utilisateurs", verifierToken, verifierRole("ADMIN"), (req, res) => {
  db.all("SELECT id,nom,prenom,email,role,actif,createdAt FROM utilisateurs ORDER BY createdAt DESC", (err, rows) => {
    if (err) return res.status(500).json({ erreur: err.message });
    res.json(rows);
  });
});

app.post("/api/utilisateurs", verifierToken, verifierRole("ADMIN"), (req, res) => {
  const { nom, prenom, email, password, role } = req.body;
  if (!nom || !email || !password) return res.status(400).json({ erreur: "Champs obligatoires manquants" });
  const hash = bcrypt.hashSync(password, 10);
  db.run(`INSERT INTO utilisateurs (nom,prenom,email,password,role) VALUES (?,?,?,?,?)`,
    [nom, prenom, email, hash, role||"TECHNICIEN"],
    function(err) {
      if (err) return res.status(500).json({ erreur: err.message });
      res.status(201).json({ message: "Utilisateur créé", id: this.lastID });
    }
  );
});

// Désactiver utilisateur
app.patch("/api/utilisateurs/:id/desactiver", verifierToken, verifierRole("ADMIN"), (req, res) => {
  if (parseInt(req.params.id) === req.user.id) return res.status(400).json({ erreur: "Impossible de se désactiver soi-même" });
  db.run("UPDATE utilisateurs SET actif=0 WHERE id=?", [req.params.id], function(err) {
    if (err) return res.status(500).json({ erreur: err.message });
    res.json({ message: "Utilisateur désactivé" });
  });
});

// Réactiver utilisateur
app.patch("/api/utilisateurs/:id/reactiver", verifierToken, verifierRole("ADMIN"), (req, res) => {
  db.run("UPDATE utilisateurs SET actif=1 WHERE id=?", [req.params.id], function(err) {
    if (err) return res.status(500).json({ erreur: err.message });
    res.json({ message: "Utilisateur réactivé" });
  });
});

// ── Équipements ──────────────────────────────────────────────
app.get("/api/equipements", verifierToken, (req, res) => {
  db.all("SELECT * FROM equipements ORDER BY createdAt DESC", (err, rows) => {
    if (err) return res.status(500).json({ erreur: err.message });
    res.json(rows);
  });
});

app.post("/api/equipements", verifierToken, verifierRole("ADMIN","INGENIEUR"), (req, res) => {
  const { nom, marque, numeroSerie, service, statut, dateAcquisition, prochaineMaintenance } = req.body;
  if (!nom || !numeroSerie) return res.status(400).json({ erreur: "Nom et numéro de série obligatoires" });
  db.run(`INSERT INTO equipements (nom,marque,numeroSerie,service,statut,dateAcquisition,prochaineMaintenance) VALUES (?,?,?,?,?,?,?)`,
    [nom, marque, numeroSerie, service, statut||"En service", dateAcquisition, prochaineMaintenance],
    function(err) {
      if (err) return res.status(500).json({ erreur: err.message });
      db.get("SELECT * FROM equipements WHERE id=?", [this.lastID], (err, row) => res.status(201).json(row));
    }
  );
});

app.put("/api/equipements/:id", verifierToken, verifierRole("ADMIN","INGENIEUR"), (req, res) => {
  const { nom, marque, numeroSerie, service, statut, dateAcquisition, prochaineMaintenance } = req.body;
  db.run(`UPDATE equipements SET nom=?,marque=?,numeroSerie=?,service=?,statut=?,dateAcquisition=?,prochaineMaintenance=? WHERE id=?`,
    [nom, marque, numeroSerie, service, statut, dateAcquisition, prochaineMaintenance, req.params.id],
    function(err) {
      if (err) return res.status(500).json({ erreur: err.message });
      res.json({ message: "Équipement mis à jour" });
    }
  );
});

app.delete("/api/equipements/:id", verifierToken, verifierRole("ADMIN","INGENIEUR"), (req, res) => {
  db.run("DELETE FROM equipements WHERE id=?", [req.params.id], function(err) {
    if (err) return res.status(500).json({ erreur: err.message });
    res.json({ message: "Équipement supprimé" });
  });
});

// ── Maintenances ─────────────────────────────────────────────
app.get("/api/maintenances", verifierToken, (req, res) => {
  db.all("SELECT * FROM maintenances ORDER BY datePlanifiee DESC", (err, rows) => {
    if (err) return res.status(500).json({ erreur: err.message });
    res.json(rows);
  });
});

app.post("/api/maintenances", verifierToken, (req, res) => {
  const { equipementId, equipementNom, type, statut, datePlanifiee, technicien, description } = req.body;
  if (!equipementId || !datePlanifiee) return res.status(400).json({ erreur: "Équipement et date obligatoires" });
  db.run(`INSERT INTO maintenances (equipementId,equipementNom,type,statut,datePlanifiee,technicien,description) VALUES (?,?,?,?,?,?,?)`,
    [equipementId, equipementNom, type, statut||"Planifiée", datePlanifiee, technicien, description],
    function(err) {
      if (err) return res.status(500).json({ erreur: err.message });
      db.get("SELECT * FROM maintenances WHERE id=?", [this.lastID], (err, row) => res.status(201).json(row));
    }
  );
});

app.put("/api/maintenances/:id", verifierToken, (req, res) => {
  const { statut, technicien, description } = req.body;
  db.run(`UPDATE maintenances SET statut=?,technicien=?,description=? WHERE id=?`,
    [statut, technicien, description, req.params.id],
    function(err) {
      if (err) return res.status(500).json({ erreur: err.message });
      res.json({ message: "Maintenance mise à jour" });
    }
  );
});

app.delete("/api/maintenances/:id", verifierToken, (req, res) => {
  db.run("DELETE FROM maintenances WHERE id=?", [req.params.id], function(err) {
    if (err) return res.status(500).json({ erreur: err.message });
    res.json({ message: "Maintenance supprimée" });
  });
});

// ── IoT ──────────────────────────────────────────────────────
app.post("/api/capteurs", (req, res) => {
  const { equipement_id, temperature, vibration, actif, anomalie, panne } = req.body;
  console.log(`📡 IoT — Équipement ${equipement_id} | Temp: ${temperature}°C | Vib: ${vibration}g`);
  db.run(`INSERT INTO iot_data (equipement_id,temperature,vibration,actif,anomalie,panne,timestamp) VALUES (?,?,?,?,?,?,datetime('now','localtime'))`,
    [equipement_id, temperature, vibration, actif?1:0, anomalie?1:0, panne?1:0]
  );
  if (anomalie || panne) {
    const severite = panne ? "CRITIQUE" : temperature > 60 ? "HAUTE" : "MOYENNE";
    const msg = panne ? `Panne signalée — Temp: ${temperature}°C, Vib: ${vibration}g` : `Anomalie — Temp: ${temperature}°C, Vib: ${vibration}g`;
    db.run(`INSERT INTO alertes (equipement_id,type,severite,message,source) VALUES (?,?,?,?,?)`,
      [equipement_id, panne?"PANNE":"ANOMALIE_IOT", severite, msg, "IOT"]);
    db.run(`UPDATE equipements SET scoreRisque=MIN(100,scoreRisque+?), statut=CASE WHEN ?=1 THEN 'En panne' ELSE statut END WHERE id=?`,
      [panne?15:5, panne?1:0, equipement_id]);
  }
  res.json({ message: "Données IoT reçues", timestamp: new Date() });
});

app.get("/api/capteurs/:equipementId", verifierToken, (req, res) => {
  db.all(`SELECT * FROM iot_data WHERE equipement_id=? ORDER BY id DESC LIMIT 30`,
    [req.params.equipementId],
    (err, rows) => {
      if (err) return res.status(500).json({ erreur: err.message });
      res.json(rows);
    }
  );
}); 

app.get("/api/alertes", verifierToken, (req, res) => {
  db.all("SELECT * FROM alertes ORDER BY createdAt DESC LIMIT 50", (err, rows) => {
    if (err) return res.status(500).json({ erreur: err.message });
    res.json(rows);
  });
});

app.patch("/api/alertes/:id/lire", verifierToken, (req, res) => {
  db.run("UPDATE alertes SET estLue=1 WHERE id=?", [req.params.id], function(err) {
    if (err) return res.status(500).json({ erreur: err.message });
    res.json({ message: "Alerte marquée comme lue" });
  });
});

app.get("/api/ping", (req, res) => res.json({ message: "✅ Serveur BioMed v6.0 opérationnel !" }));

app.listen(PORT, () => {
  console.log(`\n🚀 Serveur BioMed v6.0 — http://localhost:${PORT}`);
  console.log(`\n📋 Comptes :`);
  console.log(`   admin@biomedical.dz / admin123`);
  console.log(`   ingenieur@biomedical.dz / ingenieur123`);
  console.log(`   technicien@biomedical.dz / technicien123`);
});
