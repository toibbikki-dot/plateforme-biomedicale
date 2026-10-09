// ════════════════════════════════════════════════════════════
// FICHE D'INTERVENTION — génération du PDF
// Mise en page inspirée de la fiche papier « Maintenance matériel médical » :
// en-tête, cadre Matériel, cadre Intervention, cadre Visa (technicien / client).
// ════════════════════════════════════════════════════════════
import jsPDF from "jspdf";

// ── Logo inséré dans les PDF (chargé une fois au démarrage) ──
let LOGO = null; // { data, ratio } : ratio = hauteur / largeur
export function chargerLogoPdf(url) {
  try {
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement("canvas");
        c.width = img.naturalWidth; c.height = img.naturalHeight;
        c.getContext("2d").drawImage(img, 0, 0);
        LOGO = { data: c.toDataURL("image/png"), ratio: img.naturalHeight / img.naturalWidth };
      } catch { LOGO = null; }
    };
    img.src = url;
  } catch { LOGO = null; }
}
export function logoPdf() { return LOGO; }
// Dessine le logo dans une largeur donnée ; renvoie la hauteur utilisée (0 si pas de logo)
export function dessinerLogo(doc, x, y, largeur) {
  if (!LOGO) return 0;
  try { const h = largeur * LOGO.ratio; doc.addImage(LOGO.data, "PNG", x, y, largeur, h); return h; } catch { return 0; }
}

// "2026-10-09 14:30:00" ou "2026-10-09T14:30" → "09/10/2026 à 14:30"
export function formaterDateHeure(v) {
  if (!v) return "";
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
  if (!m) return String(v);
  return `${m[3]}/${m[2]}/${m[1]}${m[4] ? ` à ${m[4]}:${m[5]}` : ""}`;
}
// Nom de fichier sans accents ni caractères spéciaux
export function nomFichier(t) {
  return String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9-]+/g, "_").replace(/^_+|_+$/g, "");
}
// jsPDF (polices standard) ne connaît pas certains caractères typographiques
function propre(t) {
  return String(t ?? "").replace(/[’‘]/g, "'").replace(/[“”«»]/g, '"').replace(/…/g, "...").replace(/[–—]/g, "-").replace(/œ/g, "oe").replace(/Œ/g, "OE").replace(/\t/g, " ");
}

export function creerPdfFiche(f) {
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const X = 15, L = 180, D = X + L;          // marges gauche/droite
  const BAS = 275;                           // limite basse avant saut de page
  let y = 18;

  const texte = (t, x, yy, opt) => doc.text(propre(t), x, yy, opt);
  const police = (taille, gras = false, fam = "helvetica") => { doc.setFont(fam, gras ? "bold" : "normal"); doc.setFontSize(taille); };
  const bandeau = (titre) => {           // barre de titre grisée d'un cadre
    doc.setFillColor(235, 238, 242); doc.rect(X, y, L, 7, "FD");
    police(10, true); texte(titre, X + L / 2, y + 5, { align: "center" });
    y += 7;
  };
  // Ligne "Libellé : valeur" avec la valeur sur plusieurs lignes si besoin
  const ligne = (lib, val, largeurLib = 42) => {
    police(9.5, true); texte(lib, X + 3, y + 5);
    police(9.5); const lignes = doc.splitTextToSize(propre(val || "-"), L - largeurLib - 6);
    lignes.forEach((l, i) => doc.text(l, X + 3 + largeurLib, y + 5 + i * 4.6));
    y += 3 + lignes.length * 4.6 + 1.5;
  };
  const sautSiBesoin = (hauteur, debutCadre) => {
    if (y + hauteur <= BAS) return debutCadre;
    doc.rect(X, debutCadre, L, y - debutCadre);  // ferme le cadre en cours
    doc.addPage(); y = 18; return y;
  };

  doc.setDrawColor(60, 60, 60); doc.setLineWidth(0.3);

  // ── Titre (logo en haut à gauche) ──
  dessinerLogo(doc, X, 6, 22);
  police(13, true, "times"); texte("MAINTENANCE MATÉRIEL MÉDICAL", 105, y, { align: "center" });
  police(9); doc.setTextColor(90); texte(f.etablissement || "", 105, y + 5.5, { align: "center" }); doc.setTextColor(0);
  y += 12;

  // ── En-tête de la fiche ──
  let cadre = y;
  police(11, true); texte(`FICHE D'INTERVENTION ET D'ENGAGEMENT N° ${f.numero}`, X + L / 2, y + 6.5, { align: "center" });
  y += 10; doc.line(X, y, D, y);
  ligne("Établissement :", f.etablissement);
  ligne("Lieu d'affectation :", f.lieu);
  doc.rect(X, cadre, L, y - cadre);

  // ── Matériel ──
  cadre = y; bandeau("MATÉRIEL");
  ligne("Type :", f.equipement_nom);
  ligne("Marque :", f.marque);
  ligne("N° série :", f.numero_serie);
  doc.rect(X, cadre, L, y - cadre);

  // ── Intervention ──
  cadre = y; bandeau("INTERVENTION");
  ligne("Type de maintenance :", f.type_maintenance);
  ligne("Début :", formaterDateHeure(f.date_debut) || "-");
  ligne("Fin :", formaterDateHeure(f.date_fin) || "-");
  y += 1;
  police(9.5, true); texte("Travaux effectués :", X + 3, y + 5); y += 7;
  police(9.5);
  for (const l of doc.splitTextToSize(propre(f.travaux), L - 8)) {
    cadre = sautSiBesoin(5, cadre);
    doc.text(l, X + 5, y + 3); y += 4.6;
  }
  y += 2;
  cadre = sautSiBesoin(12, cadre);
  ligne("Pièces remplacées :", f.pieces || "Aucune");
  const ok = f.etat_final === "Fonctionnel";
  police(9.5, true); texte("État après intervention :", X + 3, y + 5);
  doc.setTextColor(ok ? 0 : 200, ok ? 130 : 30, ok ? 70 : 50); texte(f.etat_final || "-", X + 45, y + 5); doc.setTextColor(0);
  y += 9;
  doc.rect(X, cadre, L, y - cadre);

  // ── Visa ──
  if (y + 52 > BAS) { doc.addPage(); y = 18; }
  cadre = y; bandeau("VISA");
  const M = X + L / 2;
  police(10, true); texte("TECHNICIEN", X + L / 4, y + 5, { align: "center" }); texte("CLIENT", M + L / 4, y + 5, { align: "center" });
  y += 7; doc.line(X, y, D, y);
  const debutVisa = y;
  const visa = (x, nom, date) => {
    police(9.5, true); texte("Nom :", x + 3, debutVisa + 6); texte("Date :", x + 3, debutVisa + 12); texte("Signature :", x + 3, debutVisa + 18);
    police(9.5);
    doc.text(doc.splitTextToSize(propre(nom || ""), L / 2 - 20)[0] || "", x + 16, debutVisa + 6);
    texte(formaterDateHeure(date) || "", x + 16, debutVisa + 12);
  };
  visa(X, f.technicien_nom, f.technicien_date);
  visa(M, f.client_nom, f.client_date);
  y = debutVisa + 40;
  doc.line(M, cadre + 7, M, y);
  doc.rect(X, cadre, L, y - cadre);

  // ── Pied de page ──
  y += 8;
  police(9.5); texte(`Tél : ${f.telephone || ""}`, X, y);
  doc.setDrawColor(40, 60, 140); doc.line(X, y + 1.5, D, y + 1.5);
  police(7.5); doc.setTextColor(120);
  texte(`Fiche ${f.numero} enregistrée sur BIKIBioMed le ${formaterDateHeure(f.createdAt)}${f.cree_par_nom ? ` par ${f.cree_par_nom}` : ""}.`, X, y + 6);
  doc.setTextColor(0);
  return doc;
}

export function telechargerPdfFiche(f) {
  const doc = creerPdfFiche(f);
  // Ex. : fiche_FI-2026-0001_Radiologie_mobile_09-10-2026_Sidi_Moctar_ZONGO.pdf
  const date = formaterDateHeure(f.date_fin || f.createdAt).slice(0, 10).replace(/\//g, "-");
  const morceaux = ["fiche", nomFichier(f.numero), nomFichier(f.equipement_nom), date, nomFichier(f.technicien_nom)].filter(Boolean);
  doc.save(`${morceaux.join("_")}.pdf`);
}
