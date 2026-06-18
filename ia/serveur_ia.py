# ============================================================
# SERVEUR IA — Plateforme Biomédicale
# Prédiction de pannes + Détection d'anomalies
# ============================================================

from flask import Flask, request, jsonify
from flask_cors import CORS
import sqlite3
import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier, IsolationForest
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import Pipeline
import os
import json
from datetime import datetime, timedelta
import warnings
warnings.filterwarnings('ignore')

app = Flask(__name__)
CORS(app)

# ── Chemin vers la base de données ──────────────────────────
DB_PATH = os.path.join(os.path.dirname(__file__), '..', 'backend', 'biomedical.db')

# ── Modèles IA en mémoire ────────────────────────────────────
modeles = {}
scalers = {}

# ════════════════════════════════════════════════════════════
# CONNEXION BASE DE DONNÉES
# ════════════════════════════════════════════════════════════
def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

# ════════════════════════════════════════════════════════════
# EXTRACTION DES FEATURES IoT
# ════════════════════════════════════════════════════════════
def extraire_features(equipement_id):
    """Extrait les statistiques des capteurs pour un équipement"""
    conn = get_db()
    try:
        # Récupérer les 50 dernières mesures
        rows = conn.execute("""
            SELECT temperature, vibration, anomalie, panne, actif, timestamp
            FROM iot_data
            WHERE equipement_id = ?
            ORDER BY id DESC LIMIT 50
        """, (equipement_id,)).fetchall()

        if len(rows) < 3:
            return None

        temps = [r['temperature'] for r in rows if r['temperature']]
        vibs  = [r['vibration'] for r in rows if r['vibration']]
        anomalies = sum(1 for r in rows if r['anomalie'])
        pannes    = sum(1 for r in rows if r['panne'])

        if not temps or not vibs:
            return None

        # Récupérer info équipement
        equip = conn.execute(
            "SELECT * FROM equipements WHERE id = ?", (equipement_id,)
        ).fetchone()

        if not equip:
            return None

        # Calculer âge en jours
        try:
            date_acq = datetime.strptime(equip['dateAcquisition'], '%Y-%m-%d')
            age_jours = (datetime.now() - date_acq).days
        except:
            age_jours = 365

        # Nombre de maintenances correctives
        nb_correctives = conn.execute("""
            SELECT COUNT(*) as n FROM maintenances
            WHERE equipementId = ? AND type = 'Corrective'
        """, (equipement_id,)).fetchone()['n']

        features = {
            'temp_moyenne':     np.mean(temps),
            'temp_max':         np.max(temps),
            'temp_std':         np.std(temps),
            'temp_tendance':    float(np.polyfit(range(len(temps)), temps, 1)[0]),
            'vib_moyenne':      np.mean(vibs),
            'vib_max':          np.max(vibs),
            'vib_std':          np.std(vibs),
            'nb_anomalies':     anomalies,
            'nb_pannes':        pannes,
            'age_jours':        age_jours,
            'score_risque':     equip['scoreRisque'] or 0,
            'nb_correctives':   nb_correctives,
            'taux_anomalie':    anomalies / len(rows) if rows else 0,
        }
        return features

    finally:
        conn.close()

# ════════════════════════════════════════════════════════════
# ENTRAÎNEMENT DU MODÈLE
# ════════════════════════════════════════════════════════════
def entrainer_modele():
    """Entraîne le modèle Random Forest sur les données disponibles"""
    conn = get_db()
    try:
        equipements = conn.execute("SELECT * FROM equipements").fetchall()

        X, y = [], []
        for equip in equipements:
            features = extraire_features(equip['id'])
            if features:
                X.append(list(features.values()))
                # Label : 1 = risque élevé (score >= 60), 0 = normal
                y.append(1 if equip['scoreRisque'] >= 60 else 0)

        if len(X) < 2:
            print("⚠️ Pas assez de données pour entraîner. Utilisation du modèle par défaut.")
            return False

        X = np.array(X)
        y = np.array(y)

        # Modèle Random Forest
        rf = RandomForestClassifier(
            n_estimators=100,
            max_depth=10,
            class_weight='balanced',
            random_state=42
        )
        scaler = StandardScaler()
        X_scaled = scaler.fit_transform(X)
        rf.fit(X_scaled, y)

        modeles['random_forest'] = rf
        scalers['standard'] = scaler
        print(f"✅ Modèle entraîné sur {len(X)} équipements !")
        return True

    finally:
        conn.close()

def detecteur_anomalies(equipement_id):
    """Détection d'anomalies avec Isolation Forest"""
    conn = get_db()
    try:
        rows = conn.execute("""
            SELECT temperature, vibration FROM iot_data
            WHERE equipement_id = ?
            ORDER BY id DESC LIMIT 100
        """, (equipement_id,)).fetchall()

        if len(rows) < 10:
            return 0.0

        X = np.array([[r['temperature'], r['vibration']] for r in rows
                      if r['temperature'] and r['vibration']])

        if len(X) < 5:
            return 0.0

        iso = IsolationForest(contamination=0.1, random_state=42)
        iso.fit(X)
        scores = iso.score_samples(X)
        score_anomalie = float(np.mean(scores < -0.5))
        return round(score_anomalie, 3)

    finally:
        conn.close()

# ════════════════════════════════════════════════════════════
# ROUTES API
# ════════════════════════════════════════════════════════════

@app.route('/ia/ping', methods=['GET'])
def ping():
    return jsonify({
        "message": "✅ Serveur IA BioMed opérationnel !",
        "version": "1.0.0",
        "modele_entraine": 'random_forest' in modeles
    })

@app.route('/ia/entrainer', methods=['POST'])
def entrainer():
    """Entraîne le modèle IA"""
    succes = entrainer_modele()
    return jsonify({
        "succes": succes,
        "message": "Modèle entraîné avec succès !" if succes else "Pas assez de données — ajoutez plus de mesures IoT.",
        "timestamp": datetime.now().isoformat()
    })

@app.route('/ia/prediction/<int:equipement_id>', methods=['GET'])
def prediction(equipement_id):
    """Prédit le risque de panne pour un équipement"""
    conn = get_db()
    try:
        equip = conn.execute(
            "SELECT * FROM equipements WHERE id = ?", (equipement_id,)
        ).fetchone()

        if not equip:
            return jsonify({"erreur": "Équipement non trouvé"}), 404

        features = extraire_features(equipement_id)

        # Score de base depuis la BD
        score_base = equip['scoreRisque'] or 20

        if features is None:
            # Pas assez de données IoT — utiliser score_risque existant
            prob = score_base / 100.0
            source = "score_base"
        elif 'random_forest' in modeles:
            # Utiliser le modèle entraîné
            X = np.array([list(features.values())])
            X_scaled = scalers['standard'].transform(X)
            prob = float(modeles['random_forest'].predict_proba(X_scaled)[0][1])
            source = "random_forest"
        else:
            # Calcul heuristique si modèle pas encore entraîné
            prob = calcul_heuristique(features, score_base)
            source = "heuristique"

        # Score anomalie IoT
        score_anomalie = detecteur_anomalies(equipement_id)

        # Fusion : 60% modèle + 40% anomalie IoT
        prob_finale = min(0.99, 0.6 * prob + 0.4 * score_anomalie + 0.1 * (score_base / 100))

        # Niveau de risque
        if prob_finale >= 0.75:
            niveau = "CRITIQUE"
            delai = 7
            couleur = "#FF4D6D"
        elif prob_finale >= 0.55:
            niveau = "HAUTE"
            delai = 14
            couleur = "#F59E0B"
        elif prob_finale >= 0.35:
            niveau = "MOYENNE"
            delai = 21
            couleur = "#60A5FA"
        else:
            niveau = "BASSE"
            delai = 30
            couleur = "#00D4AA"

        # Facteurs clés
        facteurs = []
        if features:
            if features['temp_moyenne'] > 45:
                facteurs.append(f"Température élevée ({features['temp_moyenne']:.1f}°C)")
            if features['vib_max'] > 0.7:
                facteurs.append(f"Vibrations anormales ({features['vib_max']:.2f}g)")
            if features['nb_anomalies'] > 3:
                facteurs.append(f"{features['nb_anomalies']} anomalies récentes détectées")
            if features['age_jours'] > 1000:
                facteurs.append(f"Équipement âgé ({features['age_jours']} jours)")
            if features['nb_correctives'] > 2:
                facteurs.append(f"{features['nb_correctives']} maintenances correctives")
        if not facteurs:
            facteurs.append("Surveillance normale — aucun facteur critique")

        # Recommandation
        if niveau == "CRITIQUE":
            recommandation = "⚠️ Intervention immédiate recommandée ! Planifiez une maintenance corrective urgente."
        elif niveau == "HAUTE":
            recommandation = "🔶 Planifiez une maintenance préventive dans les 2 prochaines semaines."
        elif niveau == "MOYENNE":
            recommandation = "🔵 Surveillance renforcée recommandée. Maintenance dans le mois."
        else:
            recommandation = "✅ Équipement en bon état. Continuer le suivi régulier."

        # Mettre à jour le score dans la BD
        nouveau_score = min(100, int(prob_finale * 100))
        conn.execute(
            "UPDATE equipements SET scoreRisque = ? WHERE id = ?",
            (nouveau_score, equipement_id)
        )
        conn.commit()

        return jsonify({
            "equipement_id": equipement_id,
            "equipement_nom": equip['nom'],
            "probabilite_panne": round(prob_finale, 3),
            "pourcentage": round(prob_finale * 100, 1),
            "niveau_risque": niveau,
            "couleur": couleur,
            "delai_estime_jours": delai,
            "facteurs_cles": facteurs,
            "recommandation": recommandation,
            "source_modele": source,
            "score_anomalie_iot": score_anomalie,
            "timestamp": datetime.now().isoformat()
        })

    finally:
        conn.close()

@app.route('/ia/predictions/tous', methods=['GET'])
def predictions_tous():
    """Prédit le risque pour tous les équipements"""
    conn = get_db()
    try:
        equipements = conn.execute(
            "SELECT id FROM equipements"
        ).fetchall()

        resultats = []
        for equip in equipements:
            try:
                import urllib.request
                url = f"http://localhost:5001/ia/prediction/{equip['id']}"
                with urllib.request.urlopen(url, timeout=3) as r:
                    data = json.loads(r.read())
                    resultats.append(data)
            except:
                pass

        resultats.sort(key=lambda x: x.get('probabilite_panne', 0), reverse=True)
        return jsonify(resultats)

    finally:
        conn.close()

@app.route('/ia/analyse/<int:equipement_id>', methods=['GET'])
def analyse_complete(equipement_id):
    """Analyse complète d'un équipement"""
    conn = get_db()
    try:
        # Données IoT récentes
        rows = conn.execute("""
            SELECT temperature, vibration, anomalie, timestamp
            FROM iot_data WHERE equipement_id = ?
            ORDER BY id DESC LIMIT 20
        """, (equipement_id,)).fetchall()

        historique = []
        for r in rows:
            historique.append({
                "timestamp": r['timestamp'],
                "temperature": r['temperature'],
                "vibration": r['vibration'],
                "anomalie": bool(r['anomalie'])
            })

        # Tendances
        if len(rows) >= 5:
            temps = [r['temperature'] for r in rows if r['temperature']]
            vibs  = [r['vibration'] for r in rows if r['vibration']]
            tendance_temp = "hausse" if temps[0] > np.mean(temps) else "stable"
            tendance_vib  = "hausse" if vibs[0] > np.mean(vibs) else "stable"
        else:
            tendance_temp = "insuffisant"
            tendance_vib  = "insuffisant"

        return jsonify({
            "equipement_id": equipement_id,
            "nb_mesures": len(rows),
            "historique_recent": historique[:10],
            "tendances": {
                "temperature": tendance_temp,
                "vibration": tendance_vib
            },
            "timestamp": datetime.now().isoformat()
        })

    finally:
        conn.close()

@app.route('/ia/stats', methods=['GET'])
def stats_globales():
    """Statistiques globales du parc"""
    conn = get_db()
    try:
        equips = conn.execute("SELECT * FROM equipements").fetchall()

        total = len(equips)
        critiques = sum(1 for e in equips if e['scoreRisque'] >= 75)
        hauts     = sum(1 for e in equips if 55 <= e['scoreRisque'] < 75)
        normaux   = sum(1 for e in equips if e['scoreRisque'] < 55)

        score_moyen = np.mean([e['scoreRisque'] for e in equips]) if equips else 0

        # Équipement le plus à risque
        plus_risque = max(equips, key=lambda e: e['scoreRisque']) if equips else None

        return jsonify({
            "total_equipements": total,
            "risque_critique": critiques,
            "risque_haute": hauts,
            "risque_normal": normaux,
            "score_moyen": round(float(score_moyen), 1),
            "equipement_plus_risque": {
                "id": plus_risque['id'],
                "nom": plus_risque['nom'],
                "score": plus_risque['scoreRisque']
            } if plus_risque else None,
            "timestamp": datetime.now().isoformat()
        })

    finally:
        conn.close()

def calcul_heuristique(features, score_base):
    """Calcul de risque sans modèle entraîné"""
    score = score_base / 100.0

    if features['temp_moyenne'] > 50: score += 0.15
    elif features['temp_moyenne'] > 40: score += 0.07

    if features['vib_max'] > 1.0: score += 0.20
    elif features['vib_max'] > 0.7: score += 0.10

    if features['nb_anomalies'] > 5: score += 0.15
    elif features['nb_anomalies'] > 2: score += 0.07

    if features['age_jours'] > 1500: score += 0.10
    elif features['age_jours'] > 1000: score += 0.05

    if features['nb_correctives'] > 3: score += 0.10
    elif features['nb_correctives'] > 1: score += 0.05

    return min(0.99, score)

# ════════════════════════════════════════════════════════════
# DÉMARRAGE
# ════════════════════════════════════════════════════════════
if __name__ == '__main__':
    print("\n" + "="*50)
    print("  🤖 Serveur IA BioMed — Démarrage")
    print("="*50)
    print(f"📂 Base de données : {DB_PATH}")

    # Entraîner le modèle au démarrage
    print("\n🔄 Entraînement du modèle IA...")
    entrainer_modele()

    print("\n🚀 Serveur IA démarré sur http://localhost:5001")
    print("📡 Routes disponibles :")
    print("   GET  /ia/ping")
    print("   POST /ia/entrainer")
    print("   GET  /ia/prediction/<id>")
    print("   GET  /ia/predictions/tous")
    print("   GET  /ia/analyse/<id>")
    print("   GET  /ia/stats")
    print("="*50 + "\n")

    app.run(host='0.0.0.0', port=5001, debug=False)
