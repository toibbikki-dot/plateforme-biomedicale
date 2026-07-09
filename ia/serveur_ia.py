# ============================================================
# SERVEUR IA — Plateforme Biomédicale v2.1
# Utilise l'API REST du backend Railway (pas SQLite direct)
# ============================================================
from flask import Flask, request, jsonify
from flask_cors import CORS
import numpy as np
from sklearn.ensemble import RandomForestClassifier
from sklearn.preprocessing import StandardScaler
import os
import requests
from datetime import datetime
import warnings
warnings.filterwarnings('ignore')

app = Flask(__name__)
CORS(app)

# URL du backend Railway
BACKEND_URL = os.environ.get('BACKEND_URL', 'https://plateforme-biomedicale-production.up.railway.app/api')
IA_TOKEN = os.environ.get('IA_TOKEN', '')  # Token JWT admin pour accéder aux routes protégées

# Modèles IA en mémoire
modeles = {}
scalers = {}

# ════════════════════════════════════════════════════════════
# APPELS API BACKEND
# ════════════════════════════════════════════════════════════
def get_headers():
    return {
        'Content-Type': 'application/json',
        'Authorization': f'Bearer {IA_TOKEN}'
    }

def get_equipements():
    try:
        r = requests.get(f'{BACKEND_URL}/equipements', headers=get_headers(), timeout=10)
        if r.ok:
            return r.json()
        return []
    except:
        return []

def get_equipement(equipement_id):
    try:
        equips = get_equipements()
        for e in equips:
            if e['id'] == equipement_id:
                return e
        return None
    except:
        return None

def get_maintenances(equipement_id):
    try:
        r = requests.get(f'{BACKEND_URL}/maintenances', headers=get_headers(), timeout=10)
        if r.ok:
            all_maints = r.json()
            return [m for m in all_maints if m.get('equipementId') == equipement_id or str(m.get('equipementId')) == str(equipement_id)]
        return []
    except:
        return []

def get_alertes(equipement_id):
    try:
        r = requests.get(f'{BACKEND_URL}/alertes', headers=get_headers(), timeout=10)
        if r.ok:
            all_alertes = r.json()
            return [a for a in all_alertes if a.get('equipement_id') == equipement_id]
        return []
    except:
        return []

def get_iot_data(equipement_id):
    try:
        r = requests.get(f'{BACKEND_URL}/capteurs/{equipement_id}', headers=get_headers(), timeout=10)
        if r.ok:
            return r.json()
        return []
    except:
        return []

# ════════════════════════════════════════════════════════════
# EXTRACTION DES FEATURES
# ════════════════════════════════════════════════════════════
def extraire_features(equipement_id):
    equip = get_equipement(equipement_id)
    if not equip:
        return None

    # Âge en jours
    try:
        date_acq = datetime.strptime(equip.get('dateAcquisition', ''), '%Y-%m-%d')
        age_jours = (datetime.now() - date_acq).days
    except:
        age_jours = 365

    # Maintenances
    maints = get_maintenances(equipement_id)
    total_maint = len(maints)
    correctives = sum(1 for m in maints if m.get('type') == 'Corrective')
    preventives = sum(1 for m in maints if m.get('type') == 'Préventive')
    terminees = sum(1 for m in maints if m.get('statut') == 'Terminée')

    # Alertes
    alertes = get_alertes(equipement_id)
    nb_alertes = len(alertes)

    # IoT
    iot_data = get_iot_data(equipement_id)
    has_iot = len(iot_data) > 0

    # Stats IoT par paramètre
    iot_stats = {}
    for i in range(1, 9):
        vals = [float(d.get(f'param{i}', 0) or 0) for d in iot_data if d.get(f'param{i}') is not None]
        iot_stats[f'param{i}_moyenne'] = np.mean(vals) if vals else 0
        iot_stats[f'param{i}_max'] = max(vals) if vals else 0

    ratio_correctif = correctives / max(1, total_maint)

    features = {
        'age_jours': age_jours,
        'score_risque_base': equip.get('scoreRisque', 0) or 0,
        'statut_panne': 1 if equip.get('statut') == 'En panne' else 0,
        'statut_maintenance': 1 if equip.get('statut') == 'En maintenance' else 0,
        'total_maintenances': total_maint,
        'nb_correctives': correctives,
        'nb_preventives': preventives,
        'nb_maint_terminees': terminees,
        'nb_alertes': nb_alertes,
        'ratio_correctif': ratio_correctif,
        'has_iot': 1 if has_iot else 0,
        **{f'param{i}_moyenne': iot_stats[f'param{i}_moyenne'] for i in range(1, 9)},
        **{f'param{i}_max': iot_stats[f'param{i}_max'] for i in range(1, 9)},
    }

    return features

# ════════════════════════════════════════════════════════════
# ENTRAÎNEMENT DU MODÈLE
# ════════════════════════════════════════════════════════════
def entrainer_modele():
    equipements = get_equipements()
    X, y = [], []

    for equip in equipements:
        features = extraire_features(equip['id'])
        if features:
            X.append(list(features.values()))
            y.append(1 if (equip.get('scoreRisque', 0) or 0) >= 60 else 0)

    if len(X) < 2:
        print("⚠️ Pas assez de données pour entraîner.")
        return False

    X = np.array(X)
    y = np.array(y)

    rf = RandomForestClassifier(n_estimators=100, max_depth=10, class_weight='balanced', random_state=42)
    scaler = StandardScaler()
    X_scaled = scaler.fit_transform(X)
    rf.fit(X_scaled, y)

    modeles['random_forest'] = rf
    scalers['standard'] = scaler
    print(f"✅ Modèle entraîné sur {len(X)} équipements !")
    return True

# ════════════════════════════════════════════════════════════
# CALCUL HEURISTIQUE
# ════════════════════════════════════════════════════════════
def calcul_heuristique(features):
    score = features['score_risque_base'] / 100.0
    if features['age_jours'] > 1500: score += 0.15
    elif features['age_jours'] > 1000: score += 0.10
    elif features['age_jours'] > 500: score += 0.05
    if features['ratio_correctif'] > 0.7: score += 0.15
    elif features['ratio_correctif'] > 0.5: score += 0.10
    if features['nb_correctives'] > 5: score += 0.15
    elif features['nb_correctives'] > 3: score += 0.10
    elif features['nb_correctives'] > 1: score += 0.05
    if features['nb_alertes'] > 10: score += 0.15
    elif features['nb_alertes'] > 5: score += 0.10
    elif features['nb_alertes'] > 2: score += 0.05
    if features['statut_panne']: score += 0.20
    elif features['statut_maintenance']: score += 0.10
    if features['has_iot']:
        for i in range(1, 9):
            if features[f'param{i}_moyenne'] > 0 and features[f'param{i}_max'] > features[f'param{i}_moyenne'] * 2:
                score += 0.05
    return min(0.99, score)

# ════════════════════════════════════════════════════════════
# ROUTES API
# ════════════════════════════════════════════════════════════
@app.route('/ia/ping', methods=['GET'])
def ping():
    return jsonify({
        "message": "✅ Serveur IA BioMed opérationnel !",
        "version": "2.1.0",
        "modele_entraine": 'random_forest' in modeles,
        "backend_url": BACKEND_URL
    })

@app.route('/ia/entrainer', methods=['POST'])
def entrainer():
    succes = entrainer_modele()
    return jsonify({
        "succes": succes,
        "message": "Modèle entraîné avec succès !" if succes else "Pas assez de données.",
        "timestamp": datetime.now().isoformat()
    })

@app.route('/ia/prediction/<int:equipement_id>', methods=['GET'])
def prediction(equipement_id):
    equip = get_equipement(equipement_id)
    if not equip:
        return jsonify({"erreur": "Équipement non trouvé"}), 404

    features = extraire_features(equipement_id)
    if not features:
        return jsonify({"erreur": "Impossible d'extraire les features"}), 500

    if 'random_forest' in modeles:
        X = np.array([list(features.values())])
        X_scaled = scalers['standard'].transform(X)
        prob = float(modeles['random_forest'].predict_proba(X_scaled)[0][1])
        source = "random_forest"
    else:
        prob = calcul_heuristique(features)
        source = "heuristique"

    if prob >= 0.75: niveau, delai, couleur = "CRITIQUE", 7, "#FF4D6D"
    elif prob >= 0.55: niveau, delai, couleur = "HAUTE", 14, "#F59E0B"
    elif prob >= 0.35: niveau, delai, couleur = "MOYENNE", 21, "#60A5FA"
    else: niveau, delai, couleur = "BASSE", 30, "#00D4AA"

    facteurs = []
    if features['age_jours'] > 1000: facteurs.append(f"Équipement âgé de {features['age_jours']} jours")
    if features['ratio_correctif'] > 0.5: facteurs.append(f"Ratio correctif élevé ({features['ratio_correctif']*100:.0f}%)")
    if features['nb_correctives'] > 2: facteurs.append(f"{features['nb_correctives']} maintenances correctives")
    if features['nb_alertes'] > 3: facteurs.append(f"{features['nb_alertes']} alertes enregistrées")
    if features['statut_panne']: facteurs.append("Actuellement en panne")
    elif features['statut_maintenance']: facteurs.append("Actuellement en maintenance")
    if not facteurs: facteurs.append("Aucun facteur de risque majeur détecté")

    if niveau == "CRITIQUE": recommandation = "⚠️ Intervention immédiate recommandée !"
    elif niveau == "HAUTE": recommandation = "🔶 Planifiez une maintenance dans les 2 prochaines semaines."
    elif niveau == "MOYENNE": recommandation = "🔵 Surveillance renforcée recommandée."
    else: recommandation = "✅ Équipement en bon état. Continuer le suivi régulier."

    return jsonify({
        "equipement_id": equipement_id,
        "equipement_nom": equip['nom'],
        "probabilite_panne": round(prob, 3),
        "pourcentage": round(prob * 100, 1),
        "niveau_risque": niveau,
        "couleur": couleur,
        "delai_estime_jours": delai,
        "facteurs_cles": facteurs,
        "recommandation": recommandation,
        "source_modele": source,
        "has_iot": bool(features['has_iot']),
        "timestamp": datetime.now().isoformat()
    })

@app.route('/ia/stats', methods=['GET'])
def stats_globales():
    equipements = get_equipements()
    total = len(equipements)
    critiques = sum(1 for e in equipements if (e.get('scoreRisque') or 0) >= 75)
    hauts = sum(1 for e in equipements if 55 <= (e.get('scoreRisque') or 0) < 75)
    normaux = sum(1 for e in equipements if (e.get('scoreRisque') or 0) < 55)
    score_moyen = np.mean([(e.get('scoreRisque') or 0) for e in equipements]) if equipements else 0

    return jsonify({
        "total_equipements": total,
        "risque_critique": critiques,
        "risque_haute": hauts,
        "risque_normal": normaux,
        "score_moyen": round(float(score_moyen), 1),
        "timestamp": datetime.now().isoformat()
    })

# ════════════════════════════════════════════════════════════
# DÉMARRAGE
# ════════════════════════════════════════════════════════════
if __name__ == '__main__':
    print("="*50)
    print("   Serveur IA BioMed v2.1 — Démarrage")
    print("="*50)
    print(f"🌐 Backend URL : {BACKEND_URL}")
    port = int(os.environ.get('PORT', 5001))
    print(f"🚀 Serveur IA démarré sur http://0.0.0.0:{port}")
    app.run(host='0.0.0.0', port=port, debug=False)
