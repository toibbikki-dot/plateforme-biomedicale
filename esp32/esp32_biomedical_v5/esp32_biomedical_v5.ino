// ============================================================
// PLATEFORME BIOMÉDICALE — Programme ESP32 v5
// ------------------------------------------------------------
// Envoie toutes les 5 secondes vers la plateforme :
//   - etat  : l'équipement est-il en marche ? (bouton broche 18)
//   - panne : une panne est-elle signalée ?    (bouton broche 19)
//   - param1 … param8 : les mesures des capteurs (2 à 8 capteurs)
//
// L'ESP32 s'identifie avec la CLÉ D'APPAREIL de l'équipement,
// affichée sur la plateforme : page IoT → « Clé de l'appareil ESP32 ».
// Le serveur en déduit lui-même l'organisation et l'équipement.
// ============================================================

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>

// ╔══════════════════════════════════════════════════════════╗
// ║ 1. À PERSONNALISER À CHAQUE INSTALLATION                 ║
// ╚══════════════════════════════════════════════════════════╝

// Wi-Fi du lieu d'installation (réseau 2,4 GHz uniquement : l'ESP32 ne capte pas le 5 GHz)
const char* WIFI_SSID     = "NOM_DU_WIFI";
const char* WIFI_PASSWORD = "MOT_DE_PASSE_WIFI";

// Clé de l'appareil : copiée depuis la plateforme (page IoT, bouton « Afficher la clé »)
const char* DEVICE_KEY = "bm_COLLER_ICI_LA_CLE_DE_L_EQUIPEMENT";

// ╔══════════════════════════════════════════════════════════╗
// ║ 2. CAPTEURS — à adapter selon l'équipement surveillé     ║
// ╚══════════════════════════════════════════════════════════╝
// Le nombre et l'ORDRE des capteurs doivent correspondre à la
// configuration faite sur la plateforme (« Configurer les capteurs ») :
// capteur 1 ici = param1 = capteur 1 sur la plateforme, etc.
//
// Pour un capteur analogique, on indique la broche et la plage :
// la valeur lue (0 à 4095) est convertie entre « min » et « max ».
// « seuil » : au-dessus, la LED clignote (anomalie locale).
//
// ⚠️ Avec le Wi-Fi actif, n'utiliser QUE les broches analogiques
//    32, 33, 34, 35, 36 (VP) et 39 (VN). Les autres (ADC2) ne
//    fonctionnent pas quand le Wi-Fi est allumé.

struct Capteur {
  const char* nom;
  const char* unite;
  int   broche;
  float min;
  float max;
  float seuil;
};

// Exemple : moniteur multiparamètre simulé avec 3 rhéostats
Capteur CAPTEURS[] = {
  // nom            unité  broche  min    max    seuil
  { "Temperature",  "C",   34,     15.0,  80.0,  50.0 },   // param1
  { "Vibration",    "g",   35,     0.0,   2.0,   0.7  },   // param2
  { "Tension",      "V",   32,     0.0,   15.0,  13.5 },   // param3
};
const int NB_CAPTEURS = sizeof(CAPTEURS) / sizeof(CAPTEURS[0]);   // calculé automatiquement (2 à 8)

// ╔══════════════════════════════════════════════════════════╗
// ║ 3. RÉGLAGES GÉNÉRAUX — ne changent normalement jamais    ║
// ╚══════════════════════════════════════════════════════════╝
const char* SERVER_URL = "https://plateforme-biomedicale-production.up.railway.app/api/capteurs";

const int BTN_DEMARRAGE = 18;    // appui = démarrer / arrêter l'équipement
const int BTN_PANNE     = 19;    // appui court = signaler une panne, appui long (3 s) = panne résolue
const int LED_ROUGE     = 2;     // LED intégrée de la carte

const unsigned long INTERVALLE_ENVOI  = 5000;   // ms entre deux envois
const unsigned long DUREE_APPUI_LONG  = 3000;   // ms pour « panne résolue »
const unsigned long ANTI_REBOND       = 50;     // ms
const unsigned long DELAI_RECO_WIFI   = 10000;  // ms entre deux tentatives de reconnexion

// ============================================================
// ÉTAT INTERNE
// ============================================================
bool equipementActif = false;
bool panneSignalee   = false;
bool cleRefusee      = false;   // le serveur a refusé la clé (401)

unsigned long dernierEnvoi      = 0;
unsigned long derniereRecoWifi  = 0;

// Gestion des boutons sans bloquer le programme
struct Bouton {
  int broche;
  bool etatStable;            // HIGH = relâché (INPUT_PULLUP)
  bool derniereLecture;
  unsigned long dernierChangement;
  unsigned long debutAppui;
  bool appuiLongTraite;
};
Bouton btnDemarrage = { BTN_DEMARRAGE, HIGH, HIGH, 0, 0, false };
Bouton btnPanne     = { BTN_PANNE,     HIGH, HIGH, 0, 0, false };

// ============================================================
// OUTILS
// ============================================================
float convertir(int brut, float minimum, float maximum) {
  return minimum + (maximum - minimum) * (brut / 4095.0f);
}

// Lecture du capteur n° i (0 = param1).
// Pour un vrai capteur (ex. DS18B20, MPU6050, capteur de courant),
// remplacer le contenu de cette fonction par la lecture adaptée.
float lireCapteur(int i) {
  int brut = analogRead(CAPTEURS[i].broche);
  return convertir(brut, CAPTEURS[i].min, CAPTEURS[i].max);
}

void clignoter(int fois, int dureeMs) {
  for (int i = 0; i < fois; i++) {
    digitalWrite(LED_ROUGE, HIGH); delay(dureeMs);
    digitalWrite(LED_ROUGE, LOW);  delay(dureeMs);
  }
}

void connecterWifi() {
  Serial.print("Connexion Wi-Fi a « "); Serial.print(WIFI_SSID); Serial.println(" »");
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  int tentatives = 0;
  while (WiFi.status() != WL_CONNECTED && tentatives < 40) {   // 20 s maximum
    delay(500);
    Serial.print(".");
    tentatives++;
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("\nWi-Fi connecte ! IP : "); Serial.println(WiFi.localIP());
    clignoter(3, 150);
  } else {
    Serial.println("\nEchec Wi-Fi (nouvel essai automatique plus tard)");
  }
}

// ============================================================
// BOUTONS
// ============================================================
// Renvoie true au moment où le bouton est RELÂCHÉ après un appui court,
// et appelle surAppuiLong() une seule fois quand l'appui dépasse 3 s.
bool lireBouton(Bouton &b, void (*surAppuiLong)()) {
  bool lecture = digitalRead(b.broche);
  unsigned long maintenant = millis();
  bool appuiCourt = false;

  if (lecture != b.derniereLecture) {
    b.dernierChangement = maintenant;
    b.derniereLecture = lecture;
  }

  if (maintenant - b.dernierChangement > ANTI_REBOND && lecture != b.etatStable) {
    b.etatStable = lecture;
    if (b.etatStable == LOW) {            // vient d'être enfoncé
      b.debutAppui = maintenant;
      b.appuiLongTraite = false;
    } else if (!b.appuiLongTraite) {      // vient d'être relâché, sans appui long
      appuiCourt = true;
    }
  }

  if (b.etatStable == LOW && !b.appuiLongTraite && surAppuiLong != nullptr &&
      maintenant - b.debutAppui >= DUREE_APPUI_LONG) {
    b.appuiLongTraite = true;
    surAppuiLong();
  }
  return appuiCourt;
}

void panneResolue() {
  panneSignalee   = false;
  equipementActif = false;
  digitalWrite(LED_ROUGE, LOW);
  Serial.println(">>> PANNE RESOLUE - equipement remis a zero <<<");
  dernierEnvoi = 0;   // envoi immédiat
}

void gererBoutons() {
  if (lireBouton(btnDemarrage, nullptr)) {
    if (panneSignalee) {
      Serial.println("!!! Impossible de demarrer : equipement en panne !!!");
    } else {
      equipementActif = !equipementActif;
      Serial.println(equipementActif ? ">>> EQUIPEMENT DEMARRE <<<" : ">>> EQUIPEMENT ARRETE <<<");
      dernierEnvoi = 0;   // envoi immédiat
    }
  }

  if (lireBouton(btnPanne, panneResolue)) {
    if (!panneSignalee) {
      panneSignalee   = true;
      equipementActif = false;
      digitalWrite(LED_ROUGE, HIGH);
      Serial.println("!!! PANNE SIGNALEE !!!");
      dernierEnvoi = 0;   // envoi immédiat
    } else {
      Serial.println("Panne deja signalee - appui long (3 s) pour la resoudre");
    }
  }
}

// ============================================================
// ENVOI DES MESURES
// ============================================================
void envoyerMesures() {
  float valeurs[8];
  bool anomalie = false;

  Serial.println("---------------------------------");
  for (int i = 0; i < NB_CAPTEURS; i++) {
    valeurs[i] = lireCapteur(i);
    if (valeurs[i] > CAPTEURS[i].seuil) anomalie = true;
    Serial.printf("param%d %-12s : %8.2f %s%s\n", i + 1, CAPTEURS[i].nom, valeurs[i],
                  CAPTEURS[i].unite, valeurs[i] > CAPTEURS[i].seuil ? "  <-- SEUIL DEPASSE" : "");
  }
  Serial.print("Statut : ");
  Serial.println(panneSignalee ? "EN PANNE" : (equipementActif ? "EN SERVICE" : "A L'ARRET"));

  // LED : allumée fixe si panne, clignotement bref si anomalie
  if (panneSignalee)  digitalWrite(LED_ROUGE, HIGH);
  else if (anomalie)  clignoter(1, 80);

  // Construction du JSON : {"etat":true,"panne":false,"param1":36.50,...}
  String json = "{";
  json += "\"etat\":";  json += (equipementActif ? "true" : "false");
  json += ",\"panne\":"; json += (panneSignalee ? "true" : "false");
  for (int i = 0; i < NB_CAPTEURS; i++) {
    json += ",\"param" + String(i + 1) + "\":" + String(valeurs[i], 2);
  }
  json += "}";
  Serial.print("JSON : "); Serial.println(json);

  if (WiFi.status() != WL_CONNECTED) {
    Serial.println(">>> Wi-Fi deconnecte : donnees non envoyees");
    return;
  }

  WiFiClientSecure client;
  client.setInsecure();   // HTTPS chiffré, sans vérification du certificat (suffisant pour le prototype)

  HTTPClient http;
  http.setTimeout(8000);
  if (!http.begin(client, SERVER_URL)) {
    Serial.println(">>> Erreur : adresse du serveur invalide");
    return;
  }
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Device-Key", DEVICE_KEY);

  int code = http.POST(json);
  if (code == 200 || code == 201) {
    Serial.println(">>> Donnees envoyees OK");
    cleRefusee = false;
  } else if (code == 401) {
    cleRefusee = true;
    Serial.println(">>> REFUSE (401) : cle d'appareil invalide.");
    Serial.println("    Verifiez DEVICE_KEY (elle a peut-etre ete regeneree sur la plateforme).");
  } else if (code < 0) {
    Serial.print(">>> Serveur injoignable : "); Serial.println(http.errorToString(code));
  } else {
    Serial.print(">>> Erreur HTTP "); Serial.print(code); Serial.print(" : "); Serial.println(http.getString());
  }
  http.end();
}

// ============================================================
// SETUP / LOOP
// ============================================================
void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("=================================");
  Serial.println("  BioMed Plateforme - ESP32 v5   ");
  Serial.println("=================================");

  pinMode(BTN_DEMARRAGE, INPUT_PULLUP);
  pinMode(BTN_PANNE,     INPUT_PULLUP);
  pinMode(LED_ROUGE,     OUTPUT);
  digitalWrite(LED_ROUGE, LOW);
  analogReadResolution(12);   // valeurs de 0 à 4095

  if (NB_CAPTEURS < 2 || NB_CAPTEURS > 8) {
    Serial.println("!!! ERREUR : il faut entre 2 et 8 capteurs dans CAPTEURS[] !!!");
    while (true) clignoter(1, 100);
  }

  Serial.printf("%d capteur(s) declares :\n", NB_CAPTEURS);
  for (int i = 0; i < NB_CAPTEURS; i++) {
    Serial.printf("  param%d = %s (%s) sur broche %d\n", i + 1, CAPTEURS[i].nom, CAPTEURS[i].unite, CAPTEURS[i].broche);
  }
  Serial.println("Bouton 18 : demarrer / arreter");
  Serial.println("Bouton 19 : appui court = panne, appui long 3 s = panne resolue");

  connecterWifi();
  derniereRecoWifi = millis();
}

void loop() {
  gererBoutons();

  // Reconnexion Wi-Fi automatique, sans bloquer les boutons
  if (WiFi.status() != WL_CONNECTED && millis() - derniereRecoWifi > DELAI_RECO_WIFI) {
    derniereRecoWifi = millis();
    Serial.println(">>> Wi-Fi perdu, tentative de reconnexion...");
    WiFi.disconnect();
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  }

  if (dernierEnvoi == 0 || millis() - dernierEnvoi >= INTERVALLE_ENVOI) {
    dernierEnvoi = millis();
    envoyerMesures();
  }

  // Clé refusée : double clignotement rapide pour le signaler sur place
  if (cleRefusee && !panneSignalee) {
    static unsigned long dernierSignal = 0;
    if (millis() - dernierSignal > 2000) { dernierSignal = millis(); clignoter(2, 60); }
  }

  delay(5);
}
