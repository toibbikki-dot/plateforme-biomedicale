from flask import Flask, request, jsonify
from flask_cors import CORS
import sqlite3
import numpy as np
from sklearn.ensemble import RandomForestClassifier
from sklearn.preprocessing import StandardScaler
import os
from datetime import datetime
import warnings
warnings.filterwarnings('ignore')

app = Flask(__name__)
CORS(app)

DB_PATH = os.environ.get('DATABASE_URL',
    os.path.join(os.path.dirname(__file__), '..', 'backend', 'biomedical.db'))

modeles = {}
scalers = {}

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def extraire_features(equipement_id):
    conn = get_db()
    try:
        equip = conn.execute("SELECT * FROM equipements WHERE id = ?", (equipement_id,)).fetchone()
        if not equip:
            return None
        
        try:
            date_acq = datetime.strptime(equip['dateAcquisition'], '%Y-%m-%d')
            age_jours = (datetime.now() - date_acq).days
        except:
            age_jours = 365
        
        maint_stats = conn.execute("""
            SELECT 
                COUNT(*) as total_maint,
                SUM(CASE WHEN type = 'Corrective' THEN 1 ELSE 0 END) as correctives,
                SUM(CASE WHEN type = 'Préventive' THEN 1 ELSE 0 END) as preventives
            FROM maintenances 
            WHERE equipementId = ?
        """, (equipement_id,)).fetchone()
        
        nb_alertes = conn.execute("SELECT COUNT(*) as n FROM alertes WHERE equipement_id = ?", (equipement_id,)).fetchone()['n']
        
        iot_stats = conn.execute("""
            SELECT 
                COUNT(*) as nb_mesures,
                AVG(param1) as param1_moyenne, MAX(param1) as param1_max,
                AVG(param2) as param2_moyenne, MAX(param2) as param2_max,
                AVG(param3) as param3_moyenne, MAX(param3) as param3_max,
                AVG(param4) as param4_moyenne, MAX(param4) as param4_max,
                AVG(param5) as param5_moyenne, MAX(param5) as param5_max,
                AVG(param6) as param6_moyenne, MAX(param6) as param6_max,
                AVG(param7) as param7_moyenne, MAX(param7) as param7_max,
                AVG(param8) as param8_moyenne, MAX(param8) as param8_max
            FROM iot_data 
            WHERE equipement_id = ?
        """, (equipement_id,)).fetchone()
        
        has_iot = iot_stats['nb_mesures'] > 0 if iot_stats else False
        
        features = {
            'age_jours': age_jours,
            'score_risque_base': equip['scoreRisque'] or 0,
            'statut_panne': 1 if equip['statut'] == 'En panne' else 0,
            'statut_maintenance': 1 if equip['statut'] == 'En maintenance' else 0,
            'total_maintenances': maint_stats['total_maint'] or 0,
            'nb_correctives': maint_stats['correctives'] or 0,
            'nb_preventives': maint_stats['preventives'] or 0,
            'nb_alertes': nb_alertes,
            'ratio_correctif': (maint_stats['correctives'] or 0) / max(1, maint_stats['total_maint'] or 1),
            'has_iot': 1 if has_iot else 0,
            'param1_moyenne': iot_stats['param1_moyenne'] or 0,
            'param1_max': iot_stats['param1_max'] or 0,
            'param2_moyenne': iot_stats['param2_moyenne'] or 0,
            'param2_max': iot_stats['param2_max'] or 0,
            'param3_moyenne': iot_stats['param3_moyenne'] or 0,
            'param3_max': iot_stats['param3_max'] or 0,
            'param4_moyenne': iot_stats['param4_moyenne'] or 0,
            'param4_max': iot_stats['param4_max'] or 0,
            'param5_moyenne': iot_stats['param5_moyenne'] or 0,
            'param5_max': iot_stats['param5_max'] or 0,
            'param6_moyenne': iot_stats['param6_moyenne'] or 0,
            'param6_max': iot_stats['param6_max'] or 0,
            'param7_moyenne': iot_stats['param7_moyenne'] or 0,
            'param7_max': iot_stats['param7_max'] or 0,
            'param8_moyenne': iot_stats['param8_moyenne'] or 0,
            'param8_max': iot_stats['param8_max'] or 0,
        }
        
        return features
    finally:
        conn.close()

def entrainer_modele():
    conn = get_db()
    try:
        equipements = conn.execute("SELECT * FROM equipements").fetchall()
        X, y = [], []
        
        for equip in equipements:
            features = extraire_features(equip['id'])
            if features:
                X.append(list(features.values()))
                y.append(1 if equip['scoreRisque'] >= 60 else 0)
        
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
    finally:
        conn.close()

def calcul_heuristique(features):
    score = features['score_risque_base'] / 100.0
    
    if features['age_jours'] > 1500:
        score += 0.15
    elif features['age_jours'] > 1000:
        score += 0.10
    elif features['age_jours'] > 500:
        score += 0.05
    
    if features['ratio_correctif'] > 0.7:
        score += 0.15
    elif features['ratio_correctif'] > 0.5:
        score += 0.10
    
    if features['nb_correctives'] > 5:
        score += 0.15
    elif features['nb_correctives'] > 3:
        score += 0.10
    elif features['nb_correctives'] > 1:
        score += 0.05
    
    if features['nb_alertes'] > 10:
        score += 0.15
    elif features['nb_alertes'] > 5:
        score += 0.10
    elif features['nb_alertes'] > 2:
        score += 0.05
    
    if features['statut_panne']:
        score += 0.20
    elif features['statut_maintenance']:
        score += 0.10
    
    if features['has_iot']:
        for i in range(1, 9):
            param_max = features[f'param{i}_max']
            param_moy = features[f'param{i}_moyenne']
            if param_moy > 0 and param_max > param_moy * 2:
                score += 0.05
    
    return min(0.99, score)

@app.route('/ia/ping', methods=['GET'])
def ping():
    return jsonify({
        "message": "✅ Serveur IA BioMed opérationnel !",
        "version": "2.0.0",
        "modele_entraine": 'random_forest' in modeles
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
    conn = get_db()
    try:
        equip = conn.execute("SELECT * FROM equipements WHERE id = ?", (equipement_id,)).fetchone()
        if not equip:
            return jsonify({"erreur": "Équipement non trouvé"}), 404
        
        features = extraire_features(equipement_id)
        if features is None:
            return jsonify({"erreur": "Impossible d'extraire les features"}), 500
        
        if 'random_forest' in modeles:
            X = np.array([list(features.values())])
            X_scaled = scalers['standard'].transform(X)
            prob = float(modeles['random_forest'].predict_proba(X_scaled)[0][1])
            source = "random_forest"
        else:
            prob = calcul_heuristique(features)
            source = "heuristique"
        
        if prob >= 0.75:
            niveau, delai, couleur = "CRITIQUE", 7, "#FF4D6D"
        elif prob >= 0.55:
            niveau, delai, couleur = "HAUTE", 14, "#F59E0B"
        elif prob >= 0.35:
            niveau, delai, couleur = "MOYENNE", 21, "#60A5FA"
        else:
            niveau, delai, couleur = "BASSE", 30, "#00D4AA"
        
        facteurs = []
        if features['age_jours'] > 1000:
            facteurs.append(f"Équipement âgé de {features['age_jours']} jours")
        if features['ratio_correctif'] > 0.5:
            facteurs.append(f"Ratio de maintenance corrective élevé ({features['ratio_correctif']*100:.0f}%)")
        if features['nb_correctives'] > 2:
            facteurs.append(f"{features['nb_correctives']} maintenances correctives passées")
        if features['nb_alertes'] > 3:
            facteurs.append(f"{features['nb_alertes']} alertes enregistrées")
        if features['statut_panne']:
            facteurs.append("Actuellement en panne")
        elif features['statut_maintenance']:
            facteurs.append("Actuellement en maintenance")
        
        if not facteurs:
            facteurs.append("Aucun facteur de risque majeur détecté")
        
        if niveau == "CRITIQUE":
            recommandation = "⚠️ Intervention immédiate recommandée !"
        elif niveau == "HAUTE":
            recommandation = "🔶 Planifiez une maintenance préventive dans les 2 prochaines semaines."
        elif niveau == "MOYENNE":
            recommandation = "🔵 Surveillance renforcée recommandée."
        else:
            recommandation = "✅ Équipement en bon état."
        
        nouveau_score = min(100, int(prob * 100))
        conn.execute("UPDATE equipements SET scoreRisque = ? WHERE id = ?", (nouveau_score, equipement_id))
        conn.commit()
        
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
    finally:
        conn.close()

@app.route('/ia/predictions/tous', methods=['GET'])
def predictions_tous():
    conn = get_db()
    try:
        equipements = conn.execute("SELECT id FROM equipements").fetchall()
        resultats = []
        for equip in equipements:
            try:
                features = extraire_features(equip['id'])
                if features:
                    if 'random_forest' in modeles:
                        X = np.array([list(features.values())])
                        X_scaled = scalers['standard'].transform(X)
                        prob = float(modeles['random_forest'].predict_proba(X_scaled)[0][1])
                    else:
                        prob = calcul_heuristique(features)
                    
                    if prob >= 0.75:
                        niveau, couleur = "CRITIQUE", "#FF4D6D"
                    elif prob >= 0.55:
                        niveau, couleur = "HAUTE", "#F59E0B"
                    elif prob >= 0.35:
                        niveau, couleur = "MOYENNE", "#60A5FA"
                    else:
                        niveau, couleur = "BASSE", "#00D4AA"
                    
                    resultats.append({
                        "equipement_id": equip['id'],
                        "probabilite_panne": round(prob, 3),
                        "pourcentage": round(prob * 100, 1),
                        "niveau_risque": niveau,
                        "couleur": couleur,
                        "has_iot": bool(features['has_iot'])
                    })
            except Exception as e:
                print(f"Erreur pour équipement {equip['id']}: {e}")
        
        resultats.sort(key=lambda x: x.get('probabilite_panne', 0), reverse=True)
        return jsonify(resultats)
    finally:
        conn.close()

@app.route('/ia/stats', methods=['GET'])
def stats_globales():
    conn = get_db()
    try:
        equips = conn.execute("SELECT * FROM equipements").fetchall()
        total = len(equips)
        critiques = sum(1 for e in equips if e['scoreRisque'] >= 75)
        hauts = sum(1 for e in equips if 55 <= e['scoreRisque'] < 75)
        normaux = sum(1 for e in equips if e['scoreRisque'] < 55)
        score_moyen = np.mean([e['scoreRisque'] for e in equips]) if equips else 0
        
        avec_iot = conn.execute("SELECT COUNT(DISTINCT equipement_id) as n FROM iot_data").fetchone()['n']
        plus_risque = max(equips, key=lambda e: e['scoreRisque']) if equips else None
        
        return jsonify({
            "total_equipements": total,
            "risque_critique": critiques,
            "risque_haute": hauts,
            "risque_normal": normaux,
            "score_moyen": round(float(score_moyen), 1),
            "equipements_avec_iot": avec_iot,
            "equipement_plus_risque": {
                "id": plus_risque['id'],
                "nom": plus_risque['nom'],
                "score": plus_risque['scoreRisque']
            } if plus_risque else None,
            "timestamp": datetime.now().isoformat()
        })
    finally:
        conn.close()

if __name__ == '__main__':
    print("\n" + "="*50)
    print("   Serveur IA BioMed v2.0 — Démarrage")
    print("="*50)
    print(f"📂 Base de données : {DB_PATH}")
    print("\n🔄 Entraînement du modèle IA...")
    entrainer_modele()
    
    port = int(os.environ.get('PORT', 5001))
    print(f"\n🚀 Serveur IA démarré sur http://0.0.0.0:{port}")
    print("="*50 + "\n")
    
    app.run(host='0.0.0.0', port=port, debug=False)