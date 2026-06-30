# ============================================================
# SERVEUR IA — Plateforme Biomédicale (Version dynamique)
# Analyse multi-facteurs avec paramètres IoT configurables
# ============================================================
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

# Chemin vers la base de données (compatible Railway)
DB_PATH = os.environ.get('DATABASE_URL', 
    os.path.join(os.path.dirname(__file__), '..', 'backend', 'biomedical.db'))

# Modèles IA en mémoire
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
# EXTRACTION DES FEATURES (multi-facteurs, IoT dynamique)
# ════════════════════════════════════════════════════════════
def extraire_features(equipement_id):
    """
    Extrait les features pour l'IA.
    Utilise les données IoT dynamiques (param1 à param8).
    """
    conn = get_db()
    try:
        # 1. Infos équipement
        equip = conn.execute(
            "SELECT * FROM equipements WHERE id = ?", (equipement_id,)
        ).fetchone()
        
        if not equip:
            return None
        
        # 2. Calcul de l'âge en jours
        try:
            date_acq = datetime.strptime(equip['dateAcquisition'], '%Y-%m-%d')
            age_jours = (datetime.now() - date_acq).days
        except:
            age_jours = 365
        
        # 3. Historique de maintenance
        maint_stats = conn.execute("""
            SELECT 
                COUNT(*) as total_maint,
                SUM(CASE WHEN type = 'Corrective' THEN 1 ELSE 0 END) as correctives,
                SUM(CASE WHEN type = 'Préventive' THEN 1 ELSE 0 END) as preventives,
                SUM(CASE WHEN statut = 'Terminée' THEN 1 ELSE 0 END) as terminees
            FROM maintenances 
            WHERE equipementId = ?
        """, (equipement_id,)).fetchone()
        
        # 4. Nombre d'alertes
        nb_alertes = conn.execute("""
            SELECT COUNT(*) as n FROM alertes 
            WHERE equipement_id = ?
        """, (equipement_id,)).fetchone()['n']
        
        # 5. Données IoT dynamiques (param1 à param8)
        iot_stats = conn.execute("""
            SELECT 
                COUNT(*) as nb_mesures,
                AVG(param1) as param1_moyenne,
                MAX(param1) as param1_max,
                AVG(param2) as param2_moyenne,
                MAX(param2) as param2_max,
                AVG(param3) as param3_moyenne,
                MAX(param3) as param3_max,
                AVG(param4) as param4_moyenne,
                MAX(param4) as param4_max,
                AVG(param5) as param5_moyenne,
                MAX(param5) as param5_max,
                AVG(param6) as param6_moyenne,
                MAX(param6) as param6_max,
                AVG(param7) as param7_moyenne,
                MAX(param7) as param7_max,
                AVG(param8) as param8_moyenne,
                MAX(param8) as param8_max
            FROM iot_data 
            WHERE equipement_id = ?
        """, (equipement_id,)).fetchone()
        
        has_iot = iot_stats['nb_mesures'] > 0 if iot_stats else False
        
        # 6. Features
        features = {
            # Facteurs statiques (toujours dispo)
            'age_jours': age_jours,
            'score_risque_base': equip['scoreRisque'] or 0,
            'statut_panne': 1 if equip['statut'] == 'En panne' else 0,
            'statut_maintenance': 1 if equip['statut'] == 'En maintenance' else 0,
            'total_maintenances': maint_stats['total_maint'] or 0,
            'nb_correctives': maint_stats['correctives'] or 0,
            'nb_preventives': maint_stats['preventives'] or 0,
            'nb_maint_terminees': maint_stats['terminees'] or 0,
            'nb_alertes': nb_alertes,
            'ratio_correctif': (maint_stats['correctives'] or 0) / max(1, maint_stats['total_maint'] or 1),
            
            # Facteurs IoT dynamiques (optionnels)
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

# ════════════════════════════════════════════════════════════
# ENTRAÎNEMENT DU MODÈLE
# ═══════════════════════════════════════════════════════════
def entrainer_modele():
    """Entraîne le modèle sur TOUS les équipements"""
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

# ════════════════════════════════════════════════════════════
# CALCUL HEURISTIQUE (sans modèle entraîné)
# ═══════════════════════════════════════════════════════════
def calcul_heuristique(features):
    """Calcule le risque sans modèle entraîné"""
    score = features['score_risque_base'] / 100.0
    
    # Âge de l'équipement
    if features['age_jours'] > 1500:
        score += 0.15
    elif features['age_jours'] > 1000:
        score += 0.10
    elif features['age_jours'] > 500:
        score += 0.05
    
    # Ratio de maintenance corrective
    if features['ratio_correctif'] > 0.7:
        score += 0.15
    elif features['ratio_correctif'] > 0.5:
        score += 0.10
    
    # Nombre de maintenances correctives
    if features['nb_correctives'] > 5:
        score += 0.15
    elif features['nb_correctives'] > 3:
        score += 0.10
    elif features['nb_correctives'] > 1:
        score += 0.05
    
    # Nombre d'alertes
    if features['nb_alertes'] > 10:
        score += 0.15
    elif features['nb_alertes'] > 5:
        score += 0.10
    elif features['nb_alertes'] > 2:
        score += 0.05
    
    # Statut actuel
    if features['statut_panne']:
        score += 0.20
    elif features['statut_maintenance']:
        score += 0.10
    
    # Facteurs IoT (si disponibles)
    if features['has_iot']:
        # Analyser chaque paramètre pour détecter des valeurs élevées
        for i in range(1, 9):
            param_max = features[f'param{i}_max']
            param_moy = features[f'param{i}_moyenne']
            
            # Si la valeur max est très supérieure à la moyenne, c'est suspect
            if param_moy > 0 and param_max > param_moy * 2:
                score += 0.05
    
    return min(0.99, score)

# ════════════════════════════════════════════════════════════
# ROUTES API
# ════════════════════════════════════════════════════════════
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
    """Prédit le risque de panne pour un équipement"""
    conn = get_db()
    try:
        equip = conn.execute(
            "SELECT * FROM equipements WHERE id = ?", (equipement_id,)
        ).fetchone()
        
        if not equip:
            return jsonify({"erreur": "Équipement non trouvé"}), 404
        
        features = extraire_features(equipement_id)
        
        if features is None:
            return jsonify({"erreur": "Impossible d'extraire les features"}), 500
        
        # Calcul de la probabilité
        if 'random_forest' in modeles:
            X = np.array([list(features.values())])
            X_scaled = scalers['standard'].transform(X)
            prob = float(modeles['random_forest'].predict_proba(X_scaled)[0][1])
            source = "random_forest"
        else:
            prob = calcul_heuristique(features)
            source = "heuristique"
        
        # Niveau de risque
        if prob >= 0.75:
            niveau = "CRITIQUE"
            delai = 7
            couleur = "#FF4D6D"
        elif prob >= 0.55:
            niveau = "HAUTE"
            delai = 14
            couleur = "#F59E0B"
        elif prob >= 0.35:
            niveau = "MOYENNE"
            delai = 21
            couleur = "#60A5FA"
        else:
            niveau = "BASSE"
            delai = 30
            couleur = "#00D4AA"
        
        # Facteurs clés
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
        
        # Facteurs IoT (si disponibles)
        if features['has_iot']:
            for i in range(1, 9):
                param_max = features[f'param{i}_max']
                param_moy = features[f'param{i}_moyenne']
                
                if param_moy > 0 and param_max > param_moy * 2:
                    facteurs.append(f"Paramètre {i} : variations anormales détectées")
        
        if not facteurs:
            facteurs.append("Aucun facteur de risque majeur détecté")
        
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
        nouveau_score = min(100, int(prob * 100))
        conn.execute(
            "UPDATE equipements SET scoreRisque = ? WHERE id = ?",
            (nouveau_score, equipement_id)
        )
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
    """Prédit le risque pour TOUS les équipements"""
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
                        niveau = "CRITIQUE"
                        couleur = "#FF4D6D"
                    elif prob >= 0.55:
                        niveau = "HAUTE"
                        couleur = "#F59E0B"
                    elif prob >= 0.35:
                        niveau = "MOYENNE"
                        couleur = "#60A5FA"
                    else:
                        niveau = "BASSE"
                        couleur = "#00D4AA"
                    
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
    """Statistiques globales du parc"""
    conn = get_db()
    try:
        equips = conn.execute("SELECT * FROM equipements").fetchall()
        total = len(equips)
        critiques = sum(1 for e in equips if e['scoreRisque'] >= 75)
        hauts = sum(1 for e in equips if 55 <= e['scoreRisque'] < 75)
        normaux = sum(1 for e in equips if e['scoreRisque'] < 55)
        
        score_moyen = np.mean([e['scoreRisque'] for e in equips]) if equips else 0
        
        # Équipements avec IoT
        avec_iot = conn.execute("""
            SELECT COUNT(DISTINCT equipement_id) as n 
            FROM iot_data
        """).fetchone()['n']
        
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

# ════════════════════════════════════════════════════════════
# DÉMARRAGE
# ════════════════════════════════════════════════════════════
if __name__ == '__main__':
    print("\n" + "="*50)
    print("   Serveur IA BioMed v2.0 — Démarrage")
    print("="*50)
    print(f"📂 Base de données : {DB_PATH}")
    print(" Analyse multi-facteurs (IoT dynamique)")
    
    print("\n🔄 Entraînement du modèle IA...")
    entrainer_modele()
    
    port = int(os.environ.get('PORT', 5001))
    print(f"\n🚀 Serveur IA démarré sur http://0.0.0.0:{port}")
    print(" Routes disponibles :")
    print("   GET  /ia/ping")
    print("   POST /ia/entrainer")
    print("   GET  /ia/prediction/<id>")
    print("   GET  /ia/predictions/tous")
    print("   GET  /ia/stats")
    print("="*50 + "\n")
    
    app.run(host='0.0.0.0', port=port, debug=False)