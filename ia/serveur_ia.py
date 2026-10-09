# ============================================================
# SERVEUR IA — Plateforme Biomédicale v3.0
# ------------------------------------------------------------
# Le serveur IA ne possède plus de jeton à lui (IA_TOKEN) :
# il réutilise le jeton de connexion de l'utilisateur qui l'appelle.
#   - chaque utilisateur n'analyse que les équipements de SON organisation
#     (le backend applique le cloisonnement, comme pour le tableau de bord) ;
#   - sans jeton valide, le serveur IA refuse de répondre (401) ;
#   - un modèle RandomForest est entraîné et gardé PAR ORGANISATION.
# ============================================================
from flask import Flask, request, jsonify
from flask_cors import CORS
import numpy as np
from sklearn.ensemble import RandomForestClassifier
from sklearn.preprocessing import StandardScaler
import os
import requests
from datetime import datetime
from functools import wraps
import warnings
warnings.filterwarnings('ignore')

app = Flask(__name__)
CORS(app)

# URL du backend Railway
BACKEND_URL = os.environ.get('BACKEND_URL', 'https://plateforme-biomedicale-production.up.railway.app/api')

# Modèles IA en mémoire, un par organisation : { organisation_id: {"modele": ..., "scaler": ..., "date": ..., "nb": ...} }
modeles = {}


class ErreurBackend(Exception):
    def __init__(self, statut, message):
        super().__init__(message)
        self.statut = statut
        self.message = message


# ════════════════════════════════════════════════════════════
# APPELS API BACKEND (avec le jeton de l'utilisateur)
# ════════════════════════════════════════════════════════════
def appel_backend(chemin, jeton):
    try:
        r = requests.get(f'{BACKEND_URL}{chemin}', headers={
            'Content-Type': 'application/json',
            'Authorization': f'Bearer {jeton}'
        }, timeout=15)
    except requests.RequestException:
        raise ErreurBackend(502, "Backend injoignable depuis le serveur IA")
    if r.status_code in (401, 403):
        raise ErreurBackend(401, "Session invalide ou expirée : reconnectez-vous")
    if not r.ok:
        raise ErreurBackend(502, f"Erreur du backend ({r.status_code})")
    return r.json()


def exiger_jeton(route):
    """Refuse toute requête sans jeton ; transmet le jeton à la route."""
    @wraps(route)
    def enveloppe(*args, **kwargs):
        entete = request.headers.get('Authorization', '')
        jeton = entete[7:].strip() if entete.lower().startswith('bearer ') else ''
        if not jeton:
            return jsonify({"erreur": "Connexion requise : jeton manquant"}), 401
        try:
            return route(jeton, *args, **kwargs)
        except ErreurBackend as e:
            return jsonify({"erreur": e.message}), e.statut
    return enveloppe


def charger_contexte(jeton):
    """Charge en une fois les données de l'organisation de l'utilisateur."""
    organisation = appel_backend('/organisation', jeton) or {}
    return {
        "jeton": jeton,
        "organisation_id": organisation.get('id'),
        "organisation_nom": organisation.get('nom'),
        "equipements": appel_backend('/equipements', jeton) or [],
        "maintenances": appel_backend('/maintenances', jeton) or [],
        "alertes": appel_backend('/alertes', jeton) or [],
    }


def get_iot_data(ctx, equipement_id):
    try:
        return appel_backend(f'/capteurs/{equipement_id}', ctx["jeton"]) or []
    except ErreurBackend:
        return []


# ════════════════════════════════════════════════════════════
# EXTRACTION DES FEATURES
# ════════════════════════════════════════════════════════════
def texte_anciennete(date_txt, age_jours):
    """Âge lisible (« 11 ans 2 mois »), même calcul que la page Équipements."""
    try:
        d = datetime.strptime(date_txt or '', '%Y-%m-%d')
        n = datetime.now()
        mois = (n.year - d.year) * 12 + (n.month - d.month) - (1 if n.day < d.day else 0)
    except (ValueError, TypeError):
        mois = age_jours // 30
    mois = max(0, mois)
    if mois < 1:
        return "moins d'un mois"
    ans, reste = divmod(mois, 12)
    parties = []
    if ans: parties.append(f"{ans} an{'s' if ans > 1 else ''}")
    if reste: parties.append(f"{reste} mois")
    return " ".join(parties)


def extraire_features(ctx, equip):
    equipement_id = equip['id']

    # Âge en jours
    try:
        date_acq = datetime.strptime(equip.get('dateAcquisition') or '', '%Y-%m-%d')
        age_jours = (datetime.now() - date_acq).days
    except (ValueError, TypeError):
        age_jours = 365

    # Maintenances
    maints = [m for m in ctx["maintenances"] if str(m.get('equipementId')) == str(equipement_id)]
    total_maint = len(maints)
    correctives = sum(1 for m in maints if m.get('type') == 'Corrective')
    preventives = sum(1 for m in maints if m.get('type') == 'Préventive')
    terminees = sum(1 for m in maints if m.get('statut') == 'Terminée')

    # Alertes
    nb_alertes = sum(1 for a in ctx["alertes"] if a.get('equipement_id') == equipement_id)

    # IoT
    iot_data = get_iot_data(ctx, equipement_id)
    has_iot = len(iot_data) > 0

    # Stats IoT par paramètre
    iot_stats = {}
    for i in range(1, 9):
        vals = [float(d.get(f'param{i}') or 0) for d in iot_data if d.get(f'param{i}') is not None]
        iot_stats[f'param{i}_moyenne'] = float(np.mean(vals)) if vals else 0.0
        iot_stats[f'param{i}_max'] = max(vals) if vals else 0.0

    ratio_correctif = correctives / max(1, total_maint)

    return {
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


# ════════════════════════════════════════════════════════════
# ENTRAÎNEMENT DU MODÈLE (par organisation)
# ════════════════════════════════════════════════════════════
def entrainer_modele(ctx):
    X, y = [], []
    for equip in ctx["equipements"]:
        features = extraire_features(ctx, equip)
        X.append(list(features.values()))
        y.append(1 if (equip.get('scoreRisque', 0) or 0) >= 60 else 0)

    if len(X) < 2:
        return False, f"Pas assez de données : {len(X)} équipement(s), il en faut au moins 2."
    if len(set(y)) < 2:
        return False, ("Pas assez de diversité : il faut au moins un équipement à risque élevé "
                       "(score ≥ 60 %) et un équipement à risque faible pour entraîner le modèle. "
                       "En attendant, l'analyse utilise la méthode heuristique.")

    X = np.array(X)
    y = np.array(y)
    scaler = StandardScaler()
    X_scaled = scaler.fit_transform(X)
    rf = RandomForestClassifier(n_estimators=100, max_depth=10, class_weight='balanced', random_state=42)
    rf.fit(X_scaled, y)

    modeles[ctx["organisation_id"]] = {
        "modele": rf, "scaler": scaler,
        "date": datetime.now().isoformat(), "nb": len(X)
    }
    print(f"✅ Modèle entraîné pour l'organisation {ctx['organisation_id']} sur {len(X)} équipements")
    return True, f"Modèle entraîné avec succès sur {len(X)} équipements de votre organisation !"


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
# PRÉDICTION POUR UN ÉQUIPEMENT
# ════════════════════════════════════════════════════════════
def predire(ctx, equip):
    features = extraire_features(ctx, equip)
    modele_org = modeles.get(ctx["organisation_id"])

    if modele_org:
        X = np.array([list(features.values())])
        X_scaled = modele_org["scaler"].transform(X)
        prob = float(modele_org["modele"].predict_proba(X_scaled)[0][1])
        source = "random_forest"
    else:
        prob = calcul_heuristique(features)
        source = "heuristique"

    if prob >= 0.75: niveau, delai, couleur = "CRITIQUE", 7, "#FF4D6D"
    elif prob >= 0.55: niveau, delai, couleur = "HAUTE", 14, "#F59E0B"
    elif prob >= 0.35: niveau, delai, couleur = "MOYENNE", 21, "#60A5FA"
    else: niveau, delai, couleur = "BASSE", 30, "#00D4AA"

    facteurs = []
    if features['age_jours'] > 1000: facteurs.append(f"Équipement âgé de {texte_anciennete(equip.get('dateAcquisition'), features['age_jours'])}")
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

    return {
        "equipement_id": equip['id'],
        "equipement_nom": equip.get('nom'),
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
    }


# ════════════════════════════════════════════════════════════
# ROUTES API
# ════════════════════════════════════════════════════════════
@app.route('/ia/ping', methods=['GET'])
def ping():
    # Route publique : ne renvoie aucune donnée d'organisation
    return jsonify({
        "message": "✅ Serveur IA BioMed opérationnel !",
        "version": "3.0.0",
        "modeles_entraines": len(modeles),
        "backend_url": BACKEND_URL
    })


@app.route('/ia/entrainer', methods=['POST'])
@exiger_jeton
def entrainer(jeton):
    ctx = charger_contexte(jeton)
    succes, message = entrainer_modele(ctx)
    return jsonify({
        "succes": succes,
        "message": message,
        "organisation": ctx["organisation_nom"],
        "timestamp": datetime.now().isoformat()
    })


@app.route('/ia/prediction/<int:equipement_id>', methods=['GET'])
@exiger_jeton
def prediction(jeton, equipement_id):
    ctx = charger_contexte(jeton)
    equip = next((e for e in ctx["equipements"] if e.get('id') == equipement_id), None)
    if not equip:
        return jsonify({"erreur": "Équipement introuvable dans votre organisation"}), 404
    return jsonify(predire(ctx, equip))


@app.route('/ia/predictions', methods=['GET'])
@exiger_jeton
def predictions(jeton):
    """Analyse de tous les équipements de l'organisation en une seule requête."""
    ctx = charger_contexte(jeton)
    resultats = [predire(ctx, e) for e in ctx["equipements"]]
    resultats.sort(key=lambda p: p["probabilite_panne"], reverse=True)
    return jsonify(resultats)


@app.route('/ia/stats', methods=['GET'])
@exiger_jeton
def stats_globales(jeton):
    ctx = charger_contexte(jeton)
    equipements = ctx["equipements"]
    total = len(equipements)
    critiques = sum(1 for e in equipements if (e.get('scoreRisque') or 0) >= 75)
    hauts = sum(1 for e in equipements if 55 <= (e.get('scoreRisque') or 0) < 75)
    normaux = sum(1 for e in equipements if (e.get('scoreRisque') or 0) < 55)
    score_moyen = float(np.mean([(e.get('scoreRisque') or 0) for e in equipements])) if equipements else 0.0
    modele_org = modeles.get(ctx["organisation_id"])

    return jsonify({
        "organisation": ctx["organisation_nom"],
        "total_equipements": total,
        "risque_critique": critiques,
        "risque_haute": hauts,
        "risque_normal": normaux,
        "score_moyen": round(score_moyen, 1),
        "modele_entraine": modele_org is not None,
        "modele_date": modele_org["date"] if modele_org else None,
        "modele_nb_equipements": modele_org["nb"] if modele_org else 0,
        "timestamp": datetime.now().isoformat()
    })


# ════════════════════════════════════════════════════════════
# DÉMARRAGE
# ════════════════════════════════════════════════════════════
if __name__ == '__main__':
    print("="*50)
    print("   Serveur IA BioMed v3.0 — Démarrage")
    print("="*50)
    print(f"🌐 Backend URL : {BACKEND_URL}")
    port = int(os.environ.get('PORT', 5001))
    print(f"🚀 Serveur IA démarré sur http://0.0.0.0:{port}")
    app.run(host='0.0.0.0', port=port, debug=False)
