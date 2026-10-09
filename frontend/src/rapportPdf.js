// ════════════════════════════════════════════════════════════
// RAPPORT D'ACTIVITÉ DU PARC BIOMÉDICAL — export PDF
// Page de garde, indicateurs, équipements à surveiller, parc complet,
// planning, interventions, alertes, graphiques, visa du responsable.
// ════════════════════════════════════════════════════════════
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { formaterDateHeure, nomFichier, dessinerLogo } from "./fichePdf";

export const SECTIONS_RAPPORT = [
  { id: "indicateurs", label: "Indicateurs clés" },
  { id: "graphiques", label: "Graphiques" },
  { id: "risques", label: "Équipements à surveiller (risque ≥ 50 %)" },
  { id: "equipements", label: "Liste complète des équipements" },
  { id: "planning", label: "Planning : en retard, en cours, à venir (30 jours)" },
  { id: "interventions", label: "Interventions réalisées (fiches)" },
  { id: "alertes", label: "Alertes de la période" },
  { id: "visa", label: "Visa du responsable" },
];
export const PERIODES_RAPPORT = [
  { id: "30", label: "30 derniers jours", jours: 30 },
  { id: "90", label: "3 derniers mois", jours: 90 },
  { id: "365", label: "12 derniers mois", jours: 365 },
  { id: "tout", label: "Depuis le début", jours: null },
];

const VERT = [0, 110, 90], SOMBRE = [2, 11, 24], GRIS = [110, 118, 130];
const z = n => String(n).padStart(2, "0");
const jourISO = d => `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
const dateFr = d => `${z(d.getDate())}/${z(d.getMonth() + 1)}/${d.getFullYear()}`;
function anciennete(date) {
  if (!date) return "-";
  const d = new Date(date); if (isNaN(d)) return "-";
  const n = new Date();
  let m = (n.getFullYear() - d.getFullYear()) * 12 + (n.getMonth() - d.getMonth()) - (n.getDate() < d.getDate() ? 1 : 0);
  m = Math.max(0, m); if (m < 1) return "< 1 mois";
  const a = Math.floor(m / 12), r = m % 12;
  return [a ? `${a} an${a > 1 ? "s" : ""}` : "", r ? `${r} mois` : ""].filter(Boolean).join(" ");
}
const propre = t => String(t ?? "").replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/…/g, "...").replace(/≥/g, ">=").replace(/œ/g, "oe");

// Calcule toutes les données du rapport (séparé du dessin pour pouvoir le tester)
export function donneesRapport({ equipements = [], maintenances = [], fiches = [], alertes = [], periodeId = "30" }) {
  const per = PERIODES_RAPPORT.find(p => p.id === periodeId) || PERIODES_RAPPORT[0];
  const now = new Date(), auj = jourISO(now);
  const debut = per.jours ? new Date(now.getTime() - per.jours * 86400000) : null;
  const debutISO = debut ? jourISO(debut) : null;
  const dansPeriode = v => !debutISO || (v && String(v).slice(0, 10) >= debutISO);
  const dans30 = jourISO(new Date(now.getTime() + 30 * 86400000));

  const total = equipements.length;
  const nb = st => equipements.filter(e => e.statut === st).length;
  const serv = nb("En service"), enMaint = nb("En maintenance"), panne = nb("En panne");
  const scoreMoyen = total ? Math.round(equipements.reduce((s, e) => s + (e.scoreRisque || 0), 0) / total) : 0;
  const retard = maintenances.filter(m => m.statut === "Planifiée" && m.datePlanifiee && m.datePlanifiee < auj).sort((a, b) => a.datePlanifiee.localeCompare(b.datePlanifiee));
  const enCours = maintenances.filter(m => m.statut === "En cours");
  const aVenir = maintenances.filter(m => m.statut === "Planifiée" && m.datePlanifiee >= auj && m.datePlanifiee <= dans30).sort((a, b) => a.datePlanifiee.localeCompare(b.datePlanifiee));
  const maintPeriode = maintenances.filter(m => dansPeriode(m.datePlanifiee));
  const parType = ["Préventive", "Corrective", "Calibration"].map(t => ({ label: t, v: maintPeriode.filter(m => m.type === t).length }));
  const fichesPer = fiches.filter(f => dansPeriode(f.date_fin || f.createdAt)).sort((a, b) => String(b.date_fin || b.createdAt).localeCompare(String(a.date_fin || a.createdAt)));
  const alertesPer = alertes.filter(a => dansPeriode(a.createdAt));
  const nomEq = id => equipements.find(e => e.id === id)?.nom || `Équipement #${id}`;
  const parService = {};
  for (const e of equipements) parService[e.service || "Non renseigné"] = (parService[e.service || "Non renseigné"] || 0) + 1;

  return {
    periode: per, debut, now, total, serv, enMaint, panne,
    dispo: total ? Math.round(serv / total * 100) : 0, scoreMoyen,
    critiques: equipements.filter(e => (e.scoreRisque || 0) >= 75).length,
    eleves: equipements.filter(e => (e.scoreRisque || 0) >= 50 && (e.scoreRisque || 0) < 75).length,
    risques: equipements.filter(e => (e.scoreRisque || 0) >= 50).sort((a, b) => b.scoreRisque - a.scoreRisque),
    equipements: [...equipements].sort((a, b) => String(a.nom).localeCompare(String(b.nom), "fr", { sensitivity: "base" })),
    retard, enCours, aVenir, maintPeriode, parType,
    fiches: fichesPer, nonFonctionnel: fichesPer.filter(f => f.etat_final === "Non fonctionnel").length,
    alertes: alertesPer.map(a => ({ ...a, equipement: nomEq(a.equipement_id) })),
    parService: Object.entries(parService).sort((a, b) => b[1] - a[1]).map(([label, v]) => ({ label, v })),
  };
}

export function creerRapport({ organisation, user, equipements, maintenances, fiches, alertes, periodeId, sections }) {
  const D = donneesRapport({ equipements, maintenances, fiches, alertes, periodeId });
  const inclus = new Set(sections && sections.length ? sections : SECTIONS_RAPPORT.map(s => s.id));
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const auteur = `${user?.prenom || ""} ${user?.nom || ""}`.trim() || "Utilisateur";
  const etab = organisation?.nom || "Établissement";
  const libPeriode = D.debut ? `du ${dateFr(D.debut)} au ${dateFr(D.now)}` : `jusqu'au ${dateFr(D.now)} (tout l'historique)`;
  const heure = `${z(D.now.getHours())}:${z(D.now.getMinutes())}`;
  const T = (t, x, y, o) => doc.text(propre(t), x, y, o);
  const police = (taille, gras = false) => { doc.setFont("helvetica", gras ? "bold" : "normal"); doc.setFontSize(taille); };
  const tableau = (opts) => autoTable(doc, {
    theme: "striped", styles: { fontSize: 8.5, cellPadding: 1.8, overflow: "linebreak" },
    headStyles: { fillColor: VERT, textColor: 255, fontStyle: "bold" },
    margin: { left: 14, right: 14, bottom: 18 }, ...opts,
    body: opts.body.map(l => l.map(c => propre(c))),
  });
  let y = 0, numSection = 0;
  const titre = (t) => {
    numSection++;
    if (y > 245) { doc.addPage(); y = 20; }
    police(13, true); doc.setTextColor(...SOMBRE); T(`${numSection}. ${t}`, 14, y);
    doc.setDrawColor(...VERT); doc.setLineWidth(0.6); doc.line(14, y + 1.8, 60, y + 1.8);
    doc.setTextColor(0); y += 7;
  };
  const sousTitre = (t) => { if (y > 260) { doc.addPage(); y = 20; } police(10, true); doc.setTextColor(...GRIS); T(t, 14, y); doc.setTextColor(0); y += 2; };
  const vide = (t) => { police(9); doc.setTextColor(...GRIS); T(t, 16, y + 4); doc.setTextColor(0); y += 10; };
  const apres = () => { y = doc.lastAutoTable.finalY + 10; };

  // ── Page de garde ──
  // En-tête clair (économe en encre à l'impression) avec un liseré vert
  doc.setFillColor(236, 249, 245); doc.rect(0, 0, 210, 80, "F");
  doc.setFillColor(...VERT); doc.rect(0, 0, 4, 80, "F"); doc.rect(0, 80, 210, 1.2, "F");
  // Logo à droite ; si l'image n'est pas disponible, le nom est écrit à la place
  if (!dessinerLogo(doc, 152, 10, 46)) { doc.setTextColor(...VERT); police(10, true); T("BIKIBioMed", 14, 20); }
  doc.setTextColor(...SOMBRE); police(24, true); T("Rapport d'activité", 14, 40); T("du parc biomédical", 14, 51);
  police(12); doc.setTextColor(60, 70, 80); T(etab, 14, 66);
  doc.setTextColor(0);
  y = 98;
  const infos = [["Période", libPeriode], ["Établi par", `${auteur} (${user?.role || ""})`], ["Date d'export", `${dateFr(D.now)} à ${heure}`], ["Équipements suivis", String(D.total)]];
  for (const [l, v] of infos) { police(10, true); T(`${l} :`, 14, y); police(10); T(v, 55, y); y += 7; }
  // Chiffres clés en tuiles
  y += 6;
  const tuiles = [["Disponibilité", `${D.dispo} %`], ["En panne", String(D.panne)], ["À risque (≥ 50 %)", String(D.risques.length)], ["Interventions", String(D.fiches.length)]];
  tuiles.forEach(([l, v], i) => {
    const x = 14 + i * 46;
    doc.setDrawColor(210); doc.setFillColor(245, 248, 250); doc.roundedRect(x, y, 42, 26, 2, 2, "FD");
    police(16, true); doc.setTextColor(...VERT); T(v, x + 21, y + 12, { align: "center" });
    police(8); doc.setTextColor(...GRIS); T(l, x + 21, y + 20, { align: "center" }); doc.setTextColor(0);
  });
  y += 38;
  police(11, true); T("Sommaire", 14, y); y += 7;
  let n = 0;
  for (const s of SECTIONS_RAPPORT) if (inclus.has(s.id)) { n++; police(10); T(`${n}. ${s.label}`, 18, y); y += 6; }

  // ── Sections ──
  doc.addPage(); y = 20;

  if (inclus.has("indicateurs")) {
    titre("Indicateurs clés");
    const total = D.maintPeriode.length || 1;
    const pct = v => `${Math.round(v / total * 100)} %`;
    tableau({
      startY: y, theme: "grid", head: [["Indicateur", "Valeur", "Indicateur", "Valeur"]],
      columnStyles: { 1: { halign: "center", fontStyle: "bold" }, 3: { halign: "center", fontStyle: "bold" } },
      body: [
        ["Équipements suivis", D.total, "Maintenances (période)", D.maintPeriode.length],
        ["En service", D.serv, "  dont préventives", `${D.parType[0].v} (${pct(D.parType[0].v)})`],
        ["En maintenance", D.enMaint, "  dont correctives", `${D.parType[1].v} (${pct(D.parType[1].v)})`],
        ["En panne", D.panne, "Maintenances en cours", D.enCours.length],
        ["Taux de disponibilité", `${D.dispo} %`, "Maintenances en retard", D.retard.length],
        ["Score de risque moyen", `${D.scoreMoyen} %`, "Interventions réalisées", D.fiches.length],
        ["Risque critique (≥ 75 %)", D.critiques, "  dont non fonctionnel après", D.nonFonctionnel],
        ["Risque élevé (50-74 %)", D.eleves, "Alertes (période)", D.alertes.length],
      ],
    }); apres();
  }

  if (inclus.has("graphiques")) {
    titre("Graphiques");
    const barres = (titreG, items, x0, larg, couleurs) => {
      police(9.5, true); T(titreG, x0, y);
      const max = Math.max(1, ...items.map(i => i.v));
      items.forEach((it, i) => {
        const yy = y + 5 + i * 9, w = (larg - 40) * it.v / max;
        police(8); T(it.label.length > 18 ? it.label.slice(0, 17) + "." : it.label, x0, yy + 4);
        doc.setFillColor(...(couleurs[i] || VERT)); if (w > 0) doc.rect(x0 + 32, yy, w, 5.5, "F");
        police(8, true); T(String(it.v), x0 + 33 + w + 1, yy + 4.3);
      });
      return 5 + items.length * 9;
    };
    if (y > 225) { doc.addPage(); y = 20; }
    const h1 = barres("Équipements par statut", [{ label: "En service", v: D.serv }, { label: "En maintenance", v: D.enMaint }, { label: "En panne", v: D.panne }], 14, 90, [[0, 170, 130], [230, 150, 20], [220, 60, 80]]);
    const h2 = barres("Maintenances par type (période)", D.parType, 110, 90, [[60, 130, 240], [220, 60, 80], [150, 110, 230]]);
    y += Math.max(h1, h2) + 8;
    const services = D.parService.slice(0, 8);
    if (services.length) {
      if (y + 5 + services.length * 9 > 275) { doc.addPage(); y = 20; }
      y += 5 + barres("Équipements par service", services, 14, 180, []) + 4;
    }
  }

  if (inclus.has("risques")) {
    titre("Équipements à surveiller");
    if (!D.risques.length) vide("Aucun équipement n'a un score de risque supérieur ou égal à 50 %.");
    else {
      tableau({
        startY: y, head: [["Équipement", "Service", "Statut", "Score", "Ancienneté", "Proch. maintenance"]],
        body: D.risques.map(e => [e.nom, e.service || "-", e.statut, `${e.scoreRisque} %`, anciennete(e.dateAcquisition), e.prochaineMaintenance ? formaterDateHeure(e.prochaineMaintenance) : "-"]),
        didParseCell: d => { if (d.section === "body" && d.column.index === 3) { d.cell.styles.fontStyle = "bold"; d.cell.styles.textColor = parseInt(d.cell.raw) >= 75 ? [200, 30, 60] : [200, 120, 0]; } },
      }); apres();
    }
  }

  if (inclus.has("equipements")) {
    titre("Liste complète des équipements");
    tableau({
      startY: y, head: [["Équipement", "Marque", "N° série", "Service", "Statut", "Ancienneté", "Proch. maint.", "Risque"]],
      styles: { fontSize: 7.8, cellPadding: 1.5 },
      body: D.equipements.map(e => [e.nom, e.marque || "-", e.numeroSerie || "-", e.service || "-", e.statut, anciennete(e.dateAcquisition), e.prochaineMaintenance ? formaterDateHeure(e.prochaineMaintenance) : "-", `${e.scoreRisque || 0} %`]),
    }); apres();
  }

  if (inclus.has("planning")) {
    titre("Planning des maintenances");
    const ligneM = m => [formaterDateHeure(m.datePlanifiee), m.equipementNom || "-", m.type || "-", m.technicien || "-", m.description || "-"];
    const tete = [["Date prévue", "Équipement", "Type", "Technicien", "Description"]];
    for (const [st, liste, coul] of [["En retard", D.retard, [200, 40, 60]], ["En cours", D.enCours, [220, 140, 0]], ["À venir (30 prochains jours)", D.aVenir, VERT]]) {
      sousTitre(`${st} (${liste.length})`);
      if (!liste.length) vide("Aucune.");
      else { tableau({ startY: y + 1, head: tete, headStyles: { fillColor: coul, textColor: 255 }, body: liste.map(ligneM), columnStyles: { 4: { cellWidth: 60 } } }); apres(); }
    }
  }

  if (inclus.has("interventions")) {
    titre("Interventions réalisées");
    if (!D.fiches.length) vide("Aucune fiche d'intervention sur la période.");
    else {
      tableau({
        startY: y, head: [["N° fiche", "Fin", "Équipement", "Type", "Intervenant", "Pièces", "État final"]],
        body: D.fiches.map(f => [f.numero, formaterDateHeure(f.date_fin || f.createdAt), f.equipement_nom, f.type_maintenance || "-", f.technicien_nom, f.pieces || "-", f.etat_final]),
        didParseCell: d => { if (d.section === "body" && d.column.index === 6) { d.cell.styles.fontStyle = "bold"; d.cell.styles.textColor = d.cell.raw === "Fonctionnel" ? [0, 130, 80] : [200, 30, 60]; } },
      }); apres();
    }
  }

  if (inclus.has("alertes")) {
    titre("Alertes de la période");
    if (!D.alertes.length) vide("Aucune alerte sur la période.");
    else {
      tableau({
        startY: y, head: [["Date", "Équipement", "Type", "Sévérité", "Message"]],
        body: D.alertes.map(a => [formaterDateHeure(a.createdAt), a.equipement, String(a.type || "").replace(/_/g, " "), a.severite || "-", a.message || "-"]),
        columnStyles: { 4: { cellWidth: 70 } },
      }); apres();
      police(7.5); doc.setTextColor(...GRIS); T("Les 50 alertes les plus récentes sont prises en compte.", 14, y - 6); doc.setTextColor(0);
    }
  }

  if (inclus.has("visa")) {
    if (y > 225) { doc.addPage(); y = 20; }
    y += 4;
    doc.setDrawColor(80); doc.setLineWidth(0.3); doc.rect(110, y, 86, 42);
    police(10, true); T("Visa du responsable", 153, y + 7, { align: "center" });
    police(9); T("Nom :", 114, y + 16); T("Date :", 114, y + 24); T("Signature :", 114, y + 32);
  }

  // ── Pied de page sur toutes les pages (sauf la garde) ──
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    police(7.5); doc.setTextColor(...GRIS);
    T(`${etab} — Rapport exporté par ${auteur} le ${dateFr(D.now)} à ${heure}`, 14, 289);
    T(`Page ${i}/${pages}`, 196, 289, { align: "right" });
  }
  doc.setTextColor(0);
  return { doc, nomFichier: `rapport_biomedical_${dateFr(D.now).replace(/\//g, "-")}_${nomFichier(auteur) || "utilisateur"}.pdf` };
}
