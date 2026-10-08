import { useState, useEffect, useRef, useCallback, memo } from "react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, Legend, LineChart, Line, RadialBarChart, RadialBar } from "recharts";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

const API    = "https://plateforme-biomedicale-production.up.railway.app/api";
const API_IA = "https://plateforme-biomedicale-production-e0bf.up.railway.app/ia";
const COULEURS = ["#00D4AA","#F59E0B","#FF4D6D","#7C3AED","#3B82F6","#EC4899"];

function badge(statut) {
  const s = {
    "En service":{background:"rgba(0,212,170,0.15)",color:"#00D4AA",border:"1px solid rgba(0,212,170,0.3)"},
    "En maintenance":{background:"rgba(245,158,11,0.15)",color:"#F59E0B",border:"1px solid rgba(245,158,11,0.3)"},
    "En panne":{background:"rgba(255,77,109,0.15)",color:"#FF4D6D",border:"1px solid rgba(255,77,109,0.3)"},
    "Planifiée":{background:"rgba(59,130,246,0.15)",color:"#60A5FA",border:"1px solid rgba(59,130,246,0.3)"},
    "En cours":{background:"rgba(245,158,11,0.15)",color:"#F59E0B",border:"1px solid rgba(245,158,11,0.3)"},
    "Terminée":{background:"rgba(0,212,170,0.15)",color:"#00D4AA",border:"1px solid rgba(0,212,170,0.3)"},
    "CRITIQUE":{background:"rgba(255,77,109,0.15)",color:"#FF4D6D",border:"1px solid rgba(255,77,109,0.3)"},
    "HAUTE":{background:"rgba(255,77,109,0.12)",color:"#FF4D6D",border:"1px solid rgba(255,77,109,0.25)"},
    "MOYENNE":{background:"rgba(245,158,11,0.15)",color:"#F59E0B",border:"1px solid rgba(245,158,11,0.3)"},
    "BASSE":{background:"rgba(0,212,170,0.15)",color:"#00D4AA",border:"1px solid rgba(0,212,170,0.3)"},
    "INFO":{background:"rgba(0,212,170,0.15)",color:"#00D4AA",border:"1px solid rgba(0,212,170,0.3)"},
    "ADMIN":{background:"rgba(124,58,237,0.15)",color:"#A78BFA",border:"1px solid rgba(124,58,237,0.3)"},
    "INGENIEUR":{background:"rgba(59,130,246,0.15)",color:"#60A5FA",border:"1px solid rgba(59,130,246,0.3)"},
    "TECHNICIEN":{background:"rgba(0,212,170,0.15)",color:"#00D4AA",border:"1px solid rgba(0,212,170,0.3)"},
  }[statut]||{background:"var(--w08)",color:"var(--text-3)",border:"1px solid var(--w1)"};
  return {...s,padding:"3px 12px",borderRadius:"999px",fontSize:"11px",fontWeight:600,display:"inline-block"};
}

function riskColor(v){return v>=75?"#FF4D6D":v>=50?"#F59E0B":"#00D4AA";}

function formaterDate(ts) {
  if (!ts) return "—";
  try {
    const d = new Date(ts.includes("T") ? ts : ts.replace(" ","T"));
    if (isNaN(d)) return ts;
    return d.toLocaleDateString("fr-FR") + " " + d.toLocaleTimeString("fr-FR",{hour:"2-digit",minute:"2-digit",second:"2-digit"});
  } catch { return ts; }
}

// ── Tri des listes (IA, Équipements, Maintenances) ───────────
// Ancienneté d'un équipement = aujourd'hui − date d'acquisition.
function moisDepuis(date){
  if(!date) return null;
  const d=new Date(date);if(isNaN(d)) return null;
  const now=new Date();
  let m=(now.getFullYear()-d.getFullYear())*12+(now.getMonth()-d.getMonth());
  if(now.getDate()<d.getDate()) m--;
  return Math.max(0,m);
}
function texteAnciennete(date){
  const m=moisDepuis(date);
  if(m===null) return "—";
  if(m<1) return "< 1 mois";
  const a=Math.floor(m/12),r=m%12;
  const ta=a>0?`${a} an${a>1?"s":""}`:"",tm=r>0?`${r} mois`:"";
  return [ta,tm].filter(Boolean).join(" ");
}
const ORDRE_STATUT_EQUIP={"En panne":0,"En maintenance":1,"En service":2};
const ORDRE_STATUT_MAINT={"En cours":0,"Planifiée":1,"Terminée":2};
const texte=v=>(v||"").toString().trim();
const cmpTexte=(a,b)=>texte(a).localeCompare(texte(b),"fr",{sensitivity:"base",numeric:true});
// Compare deux valeurs ; les valeurs vides vont toujours à la fin.
function cmpVide(a,b,cmp){
  const va=a===null||a===undefined||a==="",vb=b===null||b===undefined||b==="";
  if(va&&vb) return 0;if(va) return 1;if(vb) return -1;
  return cmp(a,b);
}
const asc=(a,b)=>a<b?-1:a>b?1:0;
const TRIS_EQUIPEMENT={
  risque_desc:{label:"Risque : le plus élevé d'abord",cmp:(a,b)=>(b.scoreRisque||0)-(a.scoreRisque||0)},
  risque_asc:{label:"Risque : le plus faible d'abord",cmp:(a,b)=>(a.scoreRisque||0)-(b.scoreRisque||0)},
  nom_az:{label:"Nom : A → Z",cmp:(a,b)=>cmpTexte(a.nom,b.nom)},
  nom_za:{label:"Nom : Z → A",cmp:(a,b)=>cmpTexte(b.nom,a.nom)},
  age_desc:{label:"Ancienneté : le plus ancien d'abord",cmp:(a,b)=>cmpVide(a.dateAcquisition,b.dateAcquisition,asc)},
  age_asc:{label:"Ancienneté : le plus récent d'abord",cmp:(a,b)=>cmpVide(a.dateAcquisition,b.dateAcquisition,(x,y)=>asc(y,x))},
  ajout_recent:{label:"Ajouté récemment d'abord",cmp:(a,b)=>b.id-a.id},
  ajout_ancien:{label:"Ajouté en premier d'abord",cmp:(a,b)=>a.id-b.id},
  maint_proche:{label:"Prochaine maintenance : la plus proche",cmp:(a,b)=>cmpVide(a.prochaineMaintenance,b.prochaineMaintenance,asc)},
  service_az:{label:"Service : A → Z",cmp:(a,b)=>cmpTexte(a.service,b.service)||cmpTexte(a.nom,b.nom)},
  statut:{label:"Statut : en panne d'abord",cmp:(a,b)=>(ORDRE_STATUT_EQUIP[a.statut]??9)-(ORDRE_STATUT_EQUIP[b.statut]??9)||(b.scoreRisque||0)-(a.scoreRisque||0)},
};
const TRIS_MAINTENANCE={
  date_desc:{label:"Date : la plus récente d'abord",cmp:(a,b)=>cmpVide(a.datePlanifiee,b.datePlanifiee,(x,y)=>asc(y,x))},
  date_asc:{label:"Date : la plus ancienne d'abord",cmp:(a,b)=>cmpVide(a.datePlanifiee,b.datePlanifiee,asc)},
  equip_az:{label:"Équipement : A → Z",cmp:(a,b)=>cmpTexte(a.equipementNom,b.equipementNom)},
  equip_za:{label:"Équipement : Z → A",cmp:(a,b)=>cmpTexte(b.equipementNom,a.equipementNom)},
  statut:{label:"Statut : en cours → planifiée → terminée",cmp:(a,b)=>(ORDRE_STATUT_MAINT[a.statut]??9)-(ORDRE_STATUT_MAINT[b.statut]??9)},
  type:{label:"Type : A → Z",cmp:(a,b)=>cmpTexte(a.type,b.type)},
  technicien_az:{label:"Technicien : A → Z",cmp:(a,b)=>cmpVide(texte(a.technicien),texte(b.technicien),cmpTexte)},
  ajout_recent:{label:"Ajoutée récemment d'abord",cmp:(a,b)=>b.id-a.id},
};
// Trie une copie de la liste (la liste d'origine n'est pas modifiée).
// En cas d'égalité, l'ordre d'ajout le plus récent départage.
function trierListe(liste,tris,cle){
  const t=tris[cle];if(!t) return liste;
  return [...liste].sort((a,b)=>t.cmp(a,b)||(b.id-a.id));
}
// Mémorise le tri choisi pour chaque page (dans ce navigateur).
function useTri(nomPage,defaut,tris){
  const [cle,setCle]=useState(()=>{try{const v=localStorage.getItem("tri_"+nomPage);return v&&tris[v]?v:defaut;}catch{return defaut;}});
  function choisir(v){setCle(v);try{localStorage.setItem("tri_"+nomPage,v);}catch{}}
  return [cle,choisir];
}
function SelecteurTri({tris,valeur,onChange,style}){
  return(
    <select style={{...S.sel,maxWidth:300,...style}} value={valeur} onChange={e=>onChange(e.target.value)} title="Ordre de tri">
      {Object.entries(tris).map(([k,t])=><option key={k} value={k}>↕ {t.label}</option>)}
    </select>
  );
}

// ── Choix du thème de couleur ────────────────────────────────
const THEMES=[
  {id:"sombre",label:"Sombre",fond:"#041225",bord:"#00D4AA"},
  {id:"blanc",label:"Blanc",fond:"#FFFFFF",bord:"#94A3B8"},
  {id:"bleu",label:"Bleu ciel",fond:"#BAE6FD",bord:"#0EA5E9"},
  {id:"rose",label:"Rose clair",fond:"#FBCFE8",bord:"#EC4899"},
];
function SelecteurTheme(){
  const [theme,setTheme]=useState(()=>{try{return localStorage.getItem("theme")||"sombre";}catch{return "sombre";}});
  function choisir(id){
    setTheme(id);
    document.documentElement.dataset.theme=id;
    try{localStorage.setItem("theme",id);}catch{}
  }
  return(
    <div style={{marginBottom:10}}>
      <div style={{fontSize:10,color:"var(--muted)",textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:6,textAlign:"center"}}>Thème</div>
      <div style={{display:"flex",justifyContent:"center",gap:10}}>
        {THEMES.map(t=>(
          <button key={t.id} title={t.label} aria-label={`Thème ${t.label}`} onClick={()=>choisir(t.id)}
            style={{width:22,height:22,borderRadius:"50%",background:t.fond,cursor:"pointer",padding:0,
              border:theme===t.id?`2px solid ${t.bord}`:"1px solid var(--w1)",
              boxShadow:theme===t.id?`0 0 0 2px ${t.bord}40`:"none"}}/>
        ))}
      </div>
    </div>
  );
}

// ── Fond animé ───────────────────────────────────────────────
const AnimatedBackground = memo(() => {
  const icons = ["⚡","🔬","💉","🩺","🧬","⚕️","🏥","💊","🩻","🔭","⚙️","📡"];
  const particles = Array.from({length:20},(_,i)=>({
    id:i, icon:icons[i%icons.length],
    x:Math.random()*100, y:Math.random()*100,
    size:Math.random()*16+10,
    duration:Math.random()*20+15,
    delay:Math.random()*10,
    opacity:Math.random()*0.08+0.03,
  }));
  return (
    <div style={{position:"fixed",inset:0,overflow:"hidden",zIndex:0,pointerEvents:"none"}}>
      <div style={{position:"absolute",inset:0,background:"var(--bg-grad)"}}/>
      <div style={{position:"absolute",inset:0,backgroundImage:`linear-gradient(rgba(0,212,170,0.03) 1px,transparent 1px),linear-gradient(90deg,rgba(0,212,170,0.03) 1px,transparent 1px)`,backgroundSize:"60px 60px"}}/>
      <div style={{position:"absolute",top:"-10%",left:"-5%",width:"50vw",height:"50vw",borderRadius:"50%",background:"radial-gradient(circle,rgba(0,212,170,0.06) 0%,transparent 70%)"}}/>
      <div style={{position:"absolute",bottom:"-10%",right:"-5%",width:"60vw",height:"60vw",borderRadius:"50%",background:"radial-gradient(circle,rgba(59,130,246,0.05) 0%,transparent 70%)"}}/>
      <style>{`
        @keyframes float{0%,100%{transform:translateY(0px) rotate(0deg);}33%{transform:translateY(-20px) rotate(5deg);}66%{transform:translateY(10px) rotate(-3deg);}}
        @keyframes scan-line{0%{transform:translateY(-100%);}100%{transform:translateY(100vh);}}
      `}</style>
      {particles.map(p=>(
        <div key={p.id} style={{position:"absolute",left:`${p.x}%`,top:`${p.y}%`,fontSize:`${p.size}px`,opacity:p.opacity,animation:`float ${p.duration}s ${p.delay}s ease-in-out infinite`}}>{p.icon}</div>
      ))}
      <div style={{position:"absolute",left:0,right:0,height:"1px",background:"linear-gradient(90deg,transparent,rgba(0,212,170,0.15),transparent)",animation:"scan-line 8s linear infinite"}}/>
    </div>
  );
});

// ════════════════════════════════════════════════════════════
// STYLES
// ════════════════════════════════════════════════════════════
const S = {
  app:{fontFamily:"'Segoe UI',sans-serif",background:"transparent",minHeight:"100vh"},
  sidebar:{width:250,background:"var(--sidebar-bg)",backdropFilter:"blur(20px)",borderRight:"1px solid rgba(0,212,170,0.12)",position:"fixed",top:0,left:0,height:"100vh",display:"flex",flexDirection:"column",zIndex:100},
  sidebarTop:{padding:"28px 24px",borderBottom:"1px solid rgba(0,212,170,0.1)",background:"rgba(0,212,170,0.03)"},
  sidebarTitle:{fontSize:15,fontWeight:800,color:"#00D4AA",marginBottom:4,letterSpacing:"0.05em"},
  sidebarSub:{fontSize:10,color:"var(--muted)",letterSpacing:"0.1em",textTransform:"uppercase"},
  nav:(a)=>({display:"flex",alignItems:"center",gap:12,padding:"11px 24px",cursor:"pointer",fontSize:13,background:a?"rgba(0,212,170,0.08)":"transparent",color:a?"#00D4AA":"var(--muted-2)",borderLeft:a?"3px solid #00D4AA":"3px solid transparent",transition:"all 0.15s"}),
  main:{marginLeft:250,padding:"36px",position:"relative",zIndex:1},
  title:{fontSize:26,fontWeight:800,color:"var(--text)",marginBottom:6,letterSpacing:"-0.02em"},
  sub:{fontSize:13,color:"var(--muted)",marginBottom:28},
  kgrid:{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(160px,1fr))",gap:16,marginBottom:32},
  kcard:(c)=>({background:"var(--w03)",backdropFilter:"blur(10px)",borderRadius:12,padding:20,border:`1px solid ${c}25`,borderTop:`2px solid ${c}`,boxShadow:`0 0 20px ${c}08`}),
  kval:{fontSize:34,fontWeight:900,color:"var(--text)"},
  klbl:{fontSize:12,color:"var(--muted)",marginTop:4},
  card:{background:"var(--w03)",backdropFilter:"blur(10px)",borderRadius:14,padding:24,border:"1px solid var(--w06)",marginBottom:24},
  cardTitle:{fontSize:15,fontWeight:700,color:"var(--text)",marginBottom:16},
  btn:(c="#00D4AA")=>({background:`${c}18`,color:c,border:`1px solid ${c}40`,padding:"9px 18px",borderRadius:8,cursor:"pointer",fontSize:13,fontWeight:600,transition:"all 0.15s"}),
  btnSolid:(c="#00D4AA")=>({background:c,color:"#020B18",border:"none",padding:"10px 20px",borderRadius:8,cursor:"pointer",fontSize:13,fontWeight:700}),
  btnO:{background:"transparent",color:"#60A5FA",border:"1px solid rgba(96,165,250,0.3)",padding:"9px 18px",borderRadius:8,cursor:"pointer",fontSize:13,fontWeight:600},
  tbl:{width:"100%",borderCollapse:"collapse",fontSize:13},
  th:{textAlign:"left",padding:"10px 14px",background:"var(--w03)",color:"var(--muted)",fontWeight:600,fontSize:11,textTransform:"uppercase",letterSpacing:"0.08em",borderBottom:"1px solid var(--w06)"},
  td:{padding:"12px 14px",borderBottom:"1px solid var(--w04)",color:"var(--text-2)"},
  inp:{width:"100%",padding:"10px 14px",background:"var(--w05)",border:"1px solid var(--w1)",borderRadius:8,fontSize:13,color:"var(--text)",boxSizing:"border-box",outline:"none"},
  sel:{width:"100%",padding:"10px 14px",background:"var(--select-bg)",border:"1px solid var(--w1)",borderRadius:8,fontSize:13,color:"var(--text)",boxSizing:"border-box"},
  lbl:{fontSize:11,fontWeight:700,color:"var(--muted-2)",marginBottom:6,display:"block",textTransform:"uppercase",letterSpacing:"0.06em"},
  fgrid:{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16,marginBottom:20},
  overlay:{position:"fixed",inset:0,background:"rgba(0,0,0,0.7)",backdropFilter:"blur(4px)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:200},
  modal:{background:"var(--modal-bg)",backdropFilter:"blur(20px)",borderRadius:16,padding:32,width:"100%",maxWidth:560,maxHeight:"90vh",overflowY:"auto",border:"1px solid rgba(0,212,170,0.15)",boxShadow:"var(--shadow)"},
  toast:(t)=>({position:"fixed",top:24,right:24,zIndex:999,background:t==="e"?"rgba(255,77,109,0.15)":"rgba(0,212,170,0.12)",backdropFilter:"blur(10px)",border:`1px solid ${t==="e"?"rgba(255,77,109,0.4)":"rgba(0,212,170,0.4)"}`,color:t==="e"?"#FF4D6D":"#00D4AA",padding:"12px 20px",borderRadius:10,fontWeight:600,fontSize:14,boxShadow:"0 8px 32px rgba(0,0,0,0.4)"}),
};

// ════════════════════════════════════════════════════════════
// PAGE CONNEXION
// ════════════════════════════════════════════════════════════
function PageConnexion({onLogin,onGoToInscription}) {
  const [email,setEmail]=useState("");
  const [password,setPassword]=useState("");
  const [erreur,setErreur]=useState("");
  const [chargement,setChargement]=useState(false);

  async function seConnecter() {
    if(!email||!password){setErreur("Veuillez remplir tous les champs.");return;}
    setChargement(true);setErreur("");
    try {
      const res=await fetch(`${API}/auth/login`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email,password})});
      const data=await res.json();
      if(!res.ok){setErreur(data.erreur||"Erreur de connexion.");return;}
      localStorage.setItem("token",data.token);
      localStorage.setItem("user",JSON.stringify(data.user));
      localStorage.setItem("organisation",JSON.stringify(data.organisation||null));
      localStorage.setItem("preferences",JSON.stringify(data.preferences||{monitoring_actif:0,monitoring_equip_id:1}));
      onLogin(data.user,data.token,data.preferences||{monitoring_actif:0,monitoring_equip_id:1},data.organisation||null);
    }catch{setErreur("Impossible de contacter le serveur.");}
    finally{setChargement(false);}
  }

  return (
    <div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",position:"relative",fontFamily:"'Segoe UI',sans-serif"}}>
      <AnimatedBackground/>
      <div style={{position:"relative",zIndex:1,width:"100%",maxWidth:460,padding:"0 24px"}}>
        <div style={{textAlign:"center",marginBottom:40}}>
          <div style={{width:80,height:80,borderRadius:"50%",margin:"0 auto 16px",background:"rgba(0,212,170,0.1)",border:"2px solid rgba(0,212,170,0.3)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:36,boxShadow:"0 0 40px rgba(0,212,170,0.15)"}}>🏥</div>
          <h1 style={{fontSize:28,fontWeight:900,color:"var(--text)",margin:0,letterSpacing:"-0.02em"}}>BioMed Plateforme</h1>
          <p style={{fontSize:12,color:"var(--muted)",marginTop:6,textTransform:"uppercase",letterSpacing:"0.15em"}}>Gestion Intelligente du Parc Biomédical</p>
        </div>
        <div style={{background:"var(--panel-bg)",backdropFilter:"blur(20px)",borderRadius:20,padding:"40px 36px",border:"1px solid rgba(0,212,170,0.15)",boxShadow:"0 25px 60px rgba(0,0,0,0.5)"}}>
          <div style={{marginBottom:20}}>
            <label style={S.lbl}>Adresse email</label>
            <input type="email" value={email} onChange={e=>setEmail(e.target.value)} onKeyDown={e=>e.key==="Enter"&&seConnecter()} placeholder="votre@email.com" style={S.inp}/>
          </div>
          <div style={{marginBottom:28}}>
            <label style={S.lbl}>Mot de passe</label>
            <input type="password" value={password} onChange={e=>setPassword(e.target.value)} onKeyDown={e=>e.key==="Enter"&&seConnecter()} placeholder="••••••••" style={S.inp}/>
          </div>
          {erreur&&<div style={{background:"rgba(255,77,109,0.1)",border:"1px solid rgba(255,77,109,0.3)",borderRadius:8,padding:"10px 14px",marginBottom:16,color:"#FF4D6D",fontSize:13}}>❌ {erreur}</div>}
          <button onClick={seConnecter} disabled={chargement} style={{width:"100%",padding:"13px",background:chargement?"rgba(0,212,170,0.3)":"#00D4AA",color:"#020B18",border:"none",borderRadius:10,fontSize:15,fontWeight:800,cursor:chargement?"not-allowed":"pointer",boxShadow:chargement?"none":"0 0 20px rgba(0,212,170,0.3)"}}>
            {chargement?"Connexion...":"→ Se connecter"}
          </button>
          <div style={{marginTop:24,textAlign:"center"}}>
            <span style={{fontSize:13,color:"var(--muted)"}}>Pas encore de compte ? </span>
            <span onClick={onGoToInscription} style={{fontSize:13,color:"#00D4AA",fontWeight:700,cursor:"pointer"}}>Créez-en un</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// PAGE INSCRIPTION — 3 modes : Individuel / Créer organisation / Rejoindre
// ════════════════════════════════════════════════════════════
function PageInscription({onLogin,onRetourConnexion}) {
  const [mode,setMode]=useState(null); // null | "INDIVIDUEL" | "CREER_ORGANISATION" | "REJOINDRE_ORGANISATION"
  const [form,setForm]=useState({nom:"",prenom:"",email:"",password:"",nomOrganisation:"",codeInvitation:""});
  const [erreur,setErreur]=useState("");
  const [chargement,setChargement]=useState(false);
  const [codeGenere,setCodeGenere]=useState(null);
  const [codeIngenieurGenere,setCodeIngenieurGenere]=useState(null);

  async function sInscrire() {
    if(!form.nom||!form.email||!form.password){setErreur("Veuillez remplir tous les champs obligatoires.");return;}
    if(mode==="CREER_ORGANISATION" && !form.nomOrganisation){setErreur("Le nom de l'organisation est obligatoire.");return;}
    if(mode==="REJOINDRE_ORGANISATION" && !form.codeInvitation){setErreur("Le code d'invitation est obligatoire.");return;}
    setChargement(true);setErreur("");
    try {
      const res=await fetch(`${API}/auth/inscription`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({...form,mode})});
      const data=await res.json();
      if(!res.ok){setErreur(data.erreur||"Erreur lors de l'inscription.");return;}
      if(data.codeGenere){
        setCodeGenere(data.codeGenere);setCodeIngenieurGenere(data.codeIngenieur||null);
        // On garde les infos en mémoire pour finaliser la connexion après que l'utilisateur ait vu son code
        window.__pendingLogin = {user:data.user, token:data.token, preferences:data.preferences, organisation:data.organisation};
        return;
      }
      localStorage.setItem("token",data.token);
      localStorage.setItem("user",JSON.stringify(data.user));
      localStorage.setItem("organisation",JSON.stringify(data.organisation||null));
      localStorage.setItem("preferences",JSON.stringify(data.preferences||{monitoring_actif:0,monitoring_equip_id:1}));
      onLogin(data.user,data.token,data.preferences||{monitoring_actif:0,monitoring_equip_id:1},data.organisation||null);
    }catch{setErreur("Impossible de contacter le serveur.");}
    finally{setChargement(false);}
  }

  function continuerApresCode(){
    const p=window.__pendingLogin;
    if(!p) return;
    localStorage.setItem("token",p.token);
    localStorage.setItem("user",JSON.stringify(p.user));
    localStorage.setItem("organisation",JSON.stringify(p.organisation||null));
    localStorage.setItem("preferences",JSON.stringify(p.preferences||{monitoring_actif:0,monitoring_equip_id:1}));
    onLogin(p.user,p.token,p.preferences,p.organisation);
  }

  // ─── ÉCRAN : code d'invitation généré, à afficher avant de continuer ───
  if(codeGenere){
    return (
      <div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",position:"relative",fontFamily:"'Segoe UI',sans-serif"}}>
        <AnimatedBackground/>
        <div style={{position:"relative",zIndex:1,width:"100%",maxWidth:460,padding:"0 24px",textAlign:"center"}}>
          <div style={{background:"var(--panel-bg)",backdropFilter:"blur(20px)",borderRadius:20,padding:"40px 36px",border:"1px solid rgba(0,212,170,0.2)",boxShadow:"0 25px 60px rgba(0,0,0,0.5)"}}>
            <div style={{fontSize:44,marginBottom:12}}>🎉</div>
            <h2 style={{color:"var(--text)",fontSize:20,marginBottom:8}}>Organisation créée !</h2>
            <p style={{color:"var(--text-3)",fontSize:13,marginBottom:20}}>Chaque code donne un rôle précis à la personne qui l'utilise pour rejoindre votre organisation. Vous les retrouverez à tout moment dans la page « Utilisateurs ».</p>
            <div style={{background:"rgba(0,212,170,0.1)",border:"2px dashed rgba(0,212,170,0.4)",borderRadius:12,padding:"16px",marginBottom:12}}>
              <div style={{fontSize:11,color:"var(--muted)",textTransform:"uppercase",letterSpacing:"0.1em",marginBottom:6}}>🛠️ Code Technicien — à partager avec l'équipe</div>
              <div style={{fontSize:28,fontWeight:900,color:"#00D4AA",letterSpacing:"0.15em"}}>{codeGenere}</div>
            </div>
            {codeIngenieurGenere&&(
              <div style={{background:"rgba(59,130,246,0.1)",border:"2px dashed rgba(59,130,246,0.4)",borderRadius:12,padding:"16px",marginBottom:24}}>
                <div style={{fontSize:11,color:"var(--muted)",textTransform:"uppercase",letterSpacing:"0.1em",marginBottom:6}}>🔧 Code Ingénieur — à donner aux ingénieurs seulement</div>
                <div style={{fontSize:28,fontWeight:900,color:"#60A5FA",letterSpacing:"0.15em"}}>{codeIngenieurGenere}</div>
              </div>
            )}
            <button onClick={continuerApresCode} style={{width:"100%",padding:"13px",background:"#00D4AA",color:"#020B18",border:"none",borderRadius:10,fontSize:15,fontWeight:800,cursor:"pointer",boxShadow:"0 0 20px rgba(0,212,170,0.3)"}}>
              → Accéder à ma plateforme
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ─── ÉCRAN : choix du mode (si aucun mode sélectionné) ───
  if(!mode){
    return (
      <div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",position:"relative",fontFamily:"'Segoe UI',sans-serif"}}>
        <AnimatedBackground/>
        <div style={{position:"relative",zIndex:1,width:"100%",maxWidth:520,padding:"0 24px"}}>
          <div style={{textAlign:"center",marginBottom:32}}>
            <h1 style={{fontSize:24,fontWeight:900,color:"var(--text)",margin:0}}>Créer votre compte</h1>
            <p style={{fontSize:13,color:"var(--muted)",marginTop:8}}>Choisissez comment vous souhaitez utiliser la plateforme</p>
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:14}}>
            {[
              {id:"INDIVIDUEL",icon:"👤",titre:"Utilisation individuelle",desc:"Gérez votre propre parc d'équipements en toute autonomie.",c:"#00D4AA"},
              {id:"CREER_ORGANISATION",icon:"🏥",titre:"Créer une organisation",desc:"Vous êtes responsable d'un hôpital/service. Un code sera généré pour inviter votre équipe.",c:"#A78BFA"},
              {id:"REJOINDRE_ORGANISATION",icon:"🔑",titre:"Rejoindre une organisation",desc:"Un administrateur vous a donné un code d'invitation. Ce code détermine votre rôle (technicien ou ingénieur).",c:"#60A5FA"},
            ].map(opt=>(
              <div key={opt.id} onClick={()=>setMode(opt.id)} style={{cursor:"pointer",background:"var(--panel-bg)",backdropFilter:"blur(20px)",borderRadius:14,padding:"20px 24px",border:`1px solid ${opt.c}30`,display:"flex",alignItems:"center",gap:16,transition:"all 0.15s"}}>
                <div style={{fontSize:32,width:50,height:50,borderRadius:12,background:`${opt.c}15`,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>{opt.icon}</div>
                <div>
                  <div style={{fontWeight:700,color:"var(--text)",fontSize:15,marginBottom:4}}>{opt.titre}</div>
                  <div style={{fontSize:12,color:"var(--muted-2)"}}>{opt.desc}</div>
                </div>
              </div>
            ))}
          </div>
          <div style={{marginTop:24,textAlign:"center"}}>
            <span onClick={onRetourConnexion} style={{fontSize:13,color:"var(--muted)",cursor:"pointer"}}>← Retour à la connexion</span>
          </div>
        </div>
      </div>
    );
  }

  // ─── ÉCRAN : formulaire d'inscription selon le mode choisi ───
  const titres={
    INDIVIDUEL:{titre:"Compte individuel",icon:"👤",c:"#00D4AA"},
    CREER_ORGANISATION:{titre:"Créer une organisation",icon:"🏥",c:"#A78BFA"},
    REJOINDRE_ORGANISATION:{titre:"Rejoindre une organisation",icon:"🔑",c:"#60A5FA"},
  };
  const t=titres[mode];

  return (
    <div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",position:"relative",fontFamily:"'Segoe UI',sans-serif"}}>
      <AnimatedBackground/>
      <div style={{position:"relative",zIndex:1,width:"100%",maxWidth:460,padding:"0 24px"}}>
        <div style={{textAlign:"center",marginBottom:24}}>
          <div style={{width:64,height:64,borderRadius:"50%",margin:"0 auto 12px",background:`${t.c}15`,border:`2px solid ${t.c}40`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:28}}>{t.icon}</div>
          <h2 style={{color:"var(--text)",fontSize:20,margin:0}}>{t.titre}</h2>
        </div>
        <div style={{background:"var(--panel-bg)",backdropFilter:"blur(20px)",borderRadius:20,padding:"32px",border:"1px solid rgba(0,212,170,0.15)",boxShadow:"0 25px 60px rgba(0,0,0,0.5)"}}>
          <div style={S.fgrid}>
            <div><label style={S.lbl}>Nom *</label><input style={S.inp} value={form.nom} onChange={e=>setForm(p=>({...p,nom:e.target.value}))}/></div>
            <div><label style={S.lbl}>Prénom</label><input style={S.inp} value={form.prenom} onChange={e=>setForm(p=>({...p,prenom:e.target.value}))}/></div>
          </div>
          <div style={{marginBottom:16}}>
            <label style={S.lbl}>Email *</label>
            <input type="email" style={S.inp} value={form.email} onChange={e=>setForm(p=>({...p,email:e.target.value}))}/>
          </div>
          <div style={{marginBottom:16}}>
            <label style={S.lbl}>Mot de passe *</label>
            <input type="password" style={S.inp} placeholder="Minimum 6 caractères" value={form.password} onChange={e=>setForm(p=>({...p,password:e.target.value}))}/>
          </div>
          {mode==="CREER_ORGANISATION" && (
            <div style={{marginBottom:16}}>
              <label style={S.lbl}>Nom de l'organisation *</label>
              <input style={S.inp} placeholder="Ex: Hôpital Central de Ouagadougou" value={form.nomOrganisation} onChange={e=>setForm(p=>({...p,nomOrganisation:e.target.value}))}/>
            </div>
          )}
          {mode==="REJOINDRE_ORGANISATION" && (
            <div style={{marginBottom:16}}>
              <label style={S.lbl}>Code d'invitation *</label>
              <input style={{...S.inp,letterSpacing:"0.1em",fontWeight:700}} placeholder="Ex: AB3X9K2P" value={form.codeInvitation} onChange={e=>setForm(p=>({...p,codeInvitation:e.target.value.toUpperCase()}))}/>
              <div style={{fontSize:11,color:"var(--muted)",marginTop:6}}>Votre rôle (technicien ou ingénieur) dépend du code que l'administrateur vous a transmis.</div>
            </div>
          )}
          {erreur&&<div style={{background:"rgba(255,77,109,0.1)",border:"1px solid rgba(255,77,109,0.3)",borderRadius:8,padding:"10px 14px",marginBottom:16,color:"#FF4D6D",fontSize:13}}>❌ {erreur}</div>}
          <button onClick={sInscrire} disabled={chargement} style={{width:"100%",padding:"13px",background:chargement?`${t.c}50`:t.c,color:"#020B18",border:"none",borderRadius:10,fontSize:15,fontWeight:800,cursor:chargement?"not-allowed":"pointer",marginBottom:12}}>
            {chargement?"Création...":"→ Créer mon compte"}
          </button>
          <div style={{textAlign:"center"}}>
            <span onClick={()=>setMode(null)} style={{fontSize:13,color:"var(--muted)",cursor:"pointer"}}>← Changer de mode</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// MODULE IA — Composant principal
// ════════════════════════════════════════════════════════════
const ModuleIA = memo(({equipements, token, setOnglet}) => {
  const [predictions, setPredictions] = useState([]);
  const [statsIA, setStatsIA] = useState(null);
  const [predictionDetail, setPredictionDetail] = useState(null);
  const [chargement, setChargement] = useState(false);
  const [entrainement, setEntrainement] = useState(false);
  const [iaConnectee, setIaConnectee] = useState(false);
  const [equipSelectionne, setEquipSelectionne] = useState(null);
  const [erreurIA, setErreurIA] = useState("");
  const [triIA, setTriIA] = useTri("ia", "risque_desc", TRIS_EQUIPEMENT);

  // Le serveur IA travaille avec l'identité de l'utilisateur connecté :
  // il n'analyse que les équipements de son organisation.
  const enTetesIA = () => ({"Content-Type":"application/json","Authorization":`Bearer ${token}`});
  async function lireErreur(r) {
    try { const d = await r.json(); return d.erreur || `Erreur ${r.status}`; } catch { return `Erreur ${r.status}`; }
  }

  useEffect(() => {
    verifierIA();
  }, []);

  async function verifierIA() {
    try {
      const r = await fetch(`${API_IA}/ping`);
      if (r.ok) {
        setIaConnectee(true);
        chargerStats();
      }
    } catch {
      setIaConnectee(false);
    }
  }

  async function chargerStats() {
    try {
      const r = await fetch(`${API_IA}/stats`, {headers: enTetesIA()});
      if (r.ok) { setStatsIA(await r.json()); setErreurIA(""); }
      else setErreurIA(await lireErreur(r));
    } catch {}
  }

  async function entrainerModele() {
    setEntrainement(true);
    try {
      const r = await fetch(`${API_IA}/entrainer`, {method:"POST", headers: enTetesIA()});
      const data = await r.json();
      alert(data.message || data.erreur);
      chargerStats();
    } catch {
      alert("Erreur lors de l'entraînement");
    } finally {
      setEntrainement(false);
    }
  }

  async function analyserEquipement(id) {
    setChargement(true);
    setPredictionDetail(null);
    setEquipSelectionne(id);
    try {
      const r = await fetch(`${API_IA}/prediction/${id}`, {headers: enTetesIA()});
      if (!r.ok) { setErreurIA(await lireErreur(r)); return; }
      setErreurIA("");
      if (r.ok) {
        const data = await r.json();
        setPredictionDetail(data);
        // Mettre à jour la liste
        setPredictions(p => {
          const exists = p.find(x => x.equipement_id === id);
          if (exists) return p.map(x => x.equipement_id === id ? data : x);
          return [data, ...p];
        });
      }
    } catch {
      alert("Serveur IA inaccessible. Vérifiez que le service IA est en ligne sur Railway.");
    } finally {
      setChargement(false);
    }
  }

  async function analyserTous() {
    setChargement(true);
    try {
      const r = await fetch(`${API_IA}/predictions`, {headers: enTetesIA()});
      if (r.ok) { setPredictions(await r.json()); setErreurIA(""); }
      else setErreurIA(await lireErreur(r));
    } catch {
      setErreurIA("Serveur IA inaccessible.");
    }
    chargerStats();
    setChargement(false);
  }

  if (!iaConnectee) return (
    <div style={{...S.card, padding:48, textAlign:"center"}}>
      <div style={{fontSize:56, marginBottom:16}}>🤖</div>
      <div style={{fontSize:20, fontWeight:700, color:"var(--text)", marginBottom:8}}>Serveur IA non connecté</div>
      <div style={{fontSize:14, color:"var(--muted)", marginBottom:24, maxWidth:400, margin:"0 auto 24px"}}>
        Le serveur IA (service « perpetual-strength » sur Railway) ne répond pas.
        Vérifiez qu'il est en ligne, puis réessayez.
      </div>
      <button style={S.btnSolid()} onClick={verifierIA}>🔄 Réessayer la connexion</button>
    </div>
  );

  return (
    <div>
      {/* Statut IA */}
      <div style={{...S.card, display:"flex", alignItems:"center", justifyContent:"space-between", flexWrap:"wrap", gap:16}}>
        <div style={{display:"flex", alignItems:"center", gap:12}}>
          <div style={{width:12, height:12, borderRadius:"50%", background:"#00D4AA", boxShadow:"0 0 8px #00D4AA"}}/>
          <div>
            <div style={{fontWeight:700, color:"var(--text)", fontSize:15}}>🤖 Serveur IA connecté</div>
            <div style={{fontSize:12, color:"var(--muted)"}}>
              {statsIA?.organisation ? `Organisation : ${statsIA.organisation} — ` : ""}
              Modèle : {statsIA?.modele_entraine ? `RandomForest entraîné sur ${statsIA.modele_nb_equipements} équipement(s)` : "non entraîné (méthode heuristique)"}
            </div>
          </div>
        </div>
        <div style={{display:"flex", gap:12, flexWrap:"wrap"}}>
          <button style={S.btn("#A78BFA")} onClick={entrainerModele} disabled={entrainement}>
            {entrainement ? "⏳ Entraînement..." : "🧠 Entraîner le modèle"}
          </button>
          <button style={S.btnSolid()} onClick={analyserTous} disabled={chargement}>
            {chargement ? "⏳ Analyse..." : "🔍 Analyser tous les équipements"}
          </button>
        </div>
      </div>

      {erreurIA && (
        <div style={{background:"rgba(255,77,109,0.1)",border:"1px solid rgba(255,77,109,0.3)",borderRadius:8,padding:"10px 14px",marginBottom:16,color:"#FF4D6D",fontSize:13}}>
          ❌ {erreurIA}
        </div>
      )}

      {/* Stats globales */}
      {statsIA && (
        <div style={S.kgrid}>
          {[
            {v:statsIA.total_equipements, l:"Total équipements", c:"#3B82F6"},
            {v:statsIA.risque_critique, l:"Risque critique", c:"#FF4D6D"},
            {v:statsIA.risque_haute, l:"Risque élevé", c:"#F59E0B"},
            {v:statsIA.risque_normal, l:"Risque normal", c:"#00D4AA"},
            {v:statsIA.score_moyen+"%", l:"Score moyen", c:"#A78BFA"},
          ].map((k,i)=>(
            <div key={i} style={S.kcard(k.c)}>
              <div style={S.kval}>{k.v}</div>
              <div style={S.klbl}>{k.l}</div>
            </div>
          ))}
        </div>
      )}

      <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:24}}>
        {/* Analyse par équipement */}
        <div style={S.card}>
          <div style={S.cardTitle}>🔍 Analyser un équipement</div>
          <SelecteurTri tris={TRIS_EQUIPEMENT} valeur={triIA} onChange={setTriIA} style={{maxWidth:"100%",marginBottom:12}}/>
          <div style={{display:"flex",justifyContent:"space-between",fontSize:10,color:"var(--muted)",textTransform:"uppercase",letterSpacing:"0.06em",padding:"0 14px",marginBottom:6}}>
            <span>Équipement</span>
            <span title="Calculé par règles : panne en cours, pannes signalées, anomalies et maintenances correctives récentes">Score de risque (règles) ⓘ</span>
          </div>
          <div style={{display:"flex", flexDirection:"column", gap:8}}>
            {trierListe(equipements,TRIS_EQUIPEMENT,triIA).map(e => (
              <div key={e.id} onClick={() => analyserEquipement(e.id)}
                style={{
                  display:"flex", justifyContent:"space-between", alignItems:"center",
                  padding:"10px 14px", borderRadius:8, cursor:"pointer",
                  background: equipSelectionne===e.id ? "rgba(0,212,170,0.08)" : "var(--w02)",
                  border: equipSelectionne===e.id ? "1px solid rgba(0,212,170,0.3)" : "1px solid var(--w05)",
                  transition:"all 0.15s",
                }}>
                <div>
                  <div style={{fontWeight:600, color:"var(--text)", fontSize:13}}>{e.nom}</div>
                  <div style={{fontSize:11, color:"var(--muted)"}}>{e.service}{e.dateAcquisition?` · ${texteAnciennete(e.dateAcquisition)}`:""}</div>
                </div>
                <div style={{display:"flex", alignItems:"center", gap:8}}>
                  <div style={{width:50, height:4, background:"var(--w08)", borderRadius:2}}>
                    <div style={{width:`${e.scoreRisque}%`, height:"100%", background:riskColor(e.scoreRisque), borderRadius:2}}/>
                  </div>
                  <span style={{fontWeight:700, color:riskColor(e.scoreRisque), fontSize:13}}>{e.scoreRisque}%</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Résultat prédiction */}
        <div style={S.card}>
          <div style={S.cardTitle}>📊 Résultat de l'analyse IA</div>
          {chargement ? (
            <div style={{textAlign:"center", padding:40, color:"var(--muted)"}}>
              <div style={{fontSize:36, marginBottom:12}}>⏳</div>
              <div>Analyse en cours...</div>
            </div>
          ) : predictionDetail ? (
            <div>
              {/* Jauge circulaire */}
              <div style={{textAlign:"center", marginBottom:20}}>
                <div style={{
                  width:140, height:140, borderRadius:"50%",
                  background:`conic-gradient(${predictionDetail.couleur} ${predictionDetail.pourcentage * 3.6}deg, var(--w05) 0deg)`,
                  display:"flex", alignItems:"center", justifyContent:"center",
                  margin:"0 auto",
                  boxShadow:`0 0 30px ${predictionDetail.couleur}30`,
                }}>
                  <div style={{width:110, height:110, borderRadius:"50%", background:"var(--panel-bg)", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center"}}>
                    <div style={{fontSize:28, fontWeight:900, color:predictionDetail.couleur}}>{predictionDetail.pourcentage}%</div>
                    <div style={{fontSize:10, color:"var(--muted)", textTransform:"uppercase", letterSpacing:"0.05em"}}>Probabilité IA</div>
                  </div>
                </div>
                <div style={{marginTop:12}}>
                  <span style={badge(predictionDetail.niveau_risque)}>{predictionDetail.niveau_risque}</span>
                </div>
                <div style={{fontSize:11,color:"var(--muted)",marginTop:10,lineHeight:1.5,maxWidth:340,marginLeft:"auto",marginRight:"auto"}}>
                  {predictionDetail.source_modele==="random_forest"
                    ? "Probabilité, estimée par le modèle RandomForest, que cet équipement appartienne au groupe « à risque », en le comparant aux autres équipements de l'organisation."
                    : "Estimation par méthode heuristique (le modèle n'est pas encore entraîné)."}
                  {" "}Elle diffère du score de risque de la liste, qui est calculé par règles fixes.
                  {typeof predictionDetail.equipement_id!=="undefined"&&(()=>{const eq=equipements.find(x=>x.id===predictionDetail.equipement_id);return eq?<div style={{marginTop:4}}>Score de risque (règles) : <b style={{color:riskColor(eq.scoreRisque)}}>{eq.scoreRisque}%</b></div>:null;})()}
                </div>
              </div>

              <div style={{background:"var(--w02)", borderRadius:8, padding:14, marginBottom:12}}>
                <div style={{fontSize:11, color:"var(--muted)", marginBottom:6, textTransform:"uppercase", letterSpacing:"0.06em"}}>Équipement</div>
                <div style={{fontWeight:700, color:"var(--text)"}}>{predictionDetail.equipement_nom}</div>
              </div>

              <div style={{background:"var(--w02)", borderRadius:8, padding:14, marginBottom:12}}>
                <div style={{fontSize:11, color:"var(--muted)", marginBottom:6, textTransform:"uppercase", letterSpacing:"0.06em"}}>Délai estimé avant panne</div>
                <div style={{fontWeight:700, color:predictionDetail.couleur, fontSize:18}}>~{predictionDetail.delai_estime_jours} jours</div>
              </div>

              <div style={{background:"var(--w02)", borderRadius:8, padding:14, marginBottom:12}}>
                <div style={{fontSize:11, color:"var(--muted)", marginBottom:8, textTransform:"uppercase", letterSpacing:"0.06em"}}>Facteurs clés</div>
                {predictionDetail.facteurs_cles?.map((f,i)=>(
                  <div key={i} style={{display:"flex", alignItems:"center", gap:8, marginBottom:4}}>
                    <div style={{width:4, height:4, borderRadius:"50%", background:predictionDetail.couleur, flexShrink:0}}/>
                    <div style={{fontSize:12, color:"var(--text-2)"}}>{f}</div>
                  </div>
                ))}
              </div>

              <div style={{background:`${predictionDetail.couleur}10`, border:`1px solid ${predictionDetail.couleur}30`, borderRadius:8, padding:14}}>
                <div style={{fontSize:13, color:predictionDetail.couleur, fontWeight:600}}>{predictionDetail.recommandation}</div>
              </div>

              {predictionDetail.niveau_risque !== "BASSE" && (
                <button style={{...S.btnSolid("#FF4D6D"), width:"100%", marginTop:12}}
                  onClick={()=>setOnglet("maintenances")}>
                  🔧 Planifier une maintenance
                </button>
              )}
            </div>
          ) : (
            <div style={{textAlign:"center", padding:40, color:"var(--muted-3)"}}>
              <div style={{fontSize:36, marginBottom:12}}>🤖</div>
              <div>Sélectionnez un équipement à gauche pour l'analyser</div>
            </div>
          )}
        </div>
      </div>

      {/* Liste prédictions */}
      {predictions.length > 0 && (
        <div style={S.card}>
          <div style={S.cardTitle}>📋 Résultats — Tous les équipements ({predictions.length})</div>
          <table style={S.tbl}>
            <thead>
              <tr>{["Équipement","Score IA","Niveau","Délai estimé","Recommandation","Action"].map(h=><th key={h} style={S.th}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {predictions.map((p,i)=>(
                <tr key={i}>
                  <td style={S.td}><div style={{fontWeight:600, color:"var(--text)"}}>{p.equipement_nom}</div></td>
                  <td style={S.td}>
                    <div style={{display:"flex", alignItems:"center", gap:8}}>
                      <div style={{width:70, height:5, background:"var(--w08)", borderRadius:3}}>
                        <div style={{width:`${p.pourcentage}%`, height:"100%", background:p.couleur, borderRadius:3}}/>
                      </div>
                      <span style={{fontWeight:700, color:p.couleur}}>{p.pourcentage}%</span>
                    </div>
                  </td>
                  <td style={S.td}><span style={badge(p.niveau_risque)}>{p.niveau_risque}</span></td>
                  <td style={S.td}><span style={{color:p.couleur, fontWeight:600}}>~{p.delai_estime_jours} jours</span></td>
                  <td style={{...S.td, fontSize:12, color:"var(--muted-2)", maxWidth:200}}>{p.recommandation?.substring(0,60)}...</td>
                  <td style={S.td}>
                    <button onClick={()=>{setPredictionDetail(p);setEquipSelectionne(p.equipement_id);window.scrollTo(0,0);}}
                      style={{...S.btn("#60A5FA"), fontSize:11, padding:"4px 10px"}}>
                      Détail
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
});

// ════════════════════════════════════════════════════════════
// AUTRES COMPOSANTS (identiques à v8)
// ════════════════════════════════════════════════════════════

const Dashboard = memo(({equipements,maintenances,pieStatuts,barServices,pieMaint,total,serv,maint,panne,dispo,crit,exportPDF,setOnglet})=>(
  <div>
    <div style={S.kgrid}>
      {[
        {v:total,l:"Total équipements",c:"#3B82F6"},
        {v:serv,l:"En service",c:"#00D4AA"},
        {v:maint,l:"En maintenance",c:"#F59E0B"},
        {v:panne,l:"En panne",c:"#FF4D6D"},
        {v:dispo+"%",l:"Disponibilité",c:"#A78BFA"},
        {v:crit,l:"Risque critique",c:"#FF4D6D"},
      ].map((k,i)=>(
        <div key={i} style={S.kcard(k.c)}>
          <div style={S.kval}>{k.v}</div>
          <div style={S.klbl}>{k.l}</div>
        </div>
      ))}
    </div>
    <div style={{marginBottom:24,display:"flex",gap:12,flexWrap:"wrap"}}>
      <button style={S.btn("#00D4AA")} onClick={exportPDF}>📄 Exporter PDF</button>
      <button style={S.btn("#7C3AED")} onClick={()=>setOnglet("iot")}>📡 Surveillance IoT</button>
      <button style={S.btn("#F59E0B")} onClick={()=>setOnglet("ia")}>🤖 Analyse IA</button>
    </div>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:24,marginBottom:24}}>
      <div style={S.card}>
        <div style={S.cardTitle}>📊 Répartition par statut</div>
        <ResponsiveContainer width="100%" height={220}>
          <PieChart>
            <Pie data={pieStatuts} cx="50%" cy="50%" outerRadius={80} dataKey="value" label={({name,value})=>`${name}: ${value}`}>
              {pieStatuts.map((_,i)=><Cell key={i} fill={COULEURS[i]}/>)}
            </Pie>
            <Tooltip contentStyle={{background:"var(--tooltip-bg)",border:"1px solid rgba(0,212,170,0.2)",borderRadius:8,color:"var(--text)"}}/>
            <Legend wrapperStyle={{color:"var(--text-3)",fontSize:12}}/>
          </PieChart>
        </ResponsiveContainer>
      </div>
      <div style={S.card}>
        <div style={S.cardTitle}>🏥 Équipements par service</div>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={barServices}>
            <XAxis dataKey="service" tick={{fontSize:11,fill:"var(--muted-2)"}}/>
            <YAxis allowDecimals={false} tick={{fill:"var(--muted-2)"}}/>
            <Tooltip contentStyle={{background:"var(--tooltip-bg)",border:"1px solid rgba(0,212,170,0.2)",borderRadius:8,color:"var(--text)"}}/>
            <Bar dataKey="count" name="Équipements" fill="#00D4AA" radius={[4,4,0,0]}/>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:24}}>
      <div style={S.card}>
        <div style={S.cardTitle}>🔧 Statut maintenances</div>
        <ResponsiveContainer width="100%" height={200}>
          <PieChart>
            <Pie data={pieMaint} cx="50%" cy="50%" outerRadius={70} dataKey="value" label={({name,value})=>`${name}: ${value}`}>
              {pieMaint.map((_,i)=><Cell key={i} fill={["#3B82F6","#F59E0B","#00D4AA"][i]}/>)}
            </Pie>
            <Tooltip contentStyle={{background:"var(--tooltip-bg)",border:"1px solid rgba(0,212,170,0.2)",borderRadius:8,color:"var(--text)"}}/>
          </PieChart>
        </ResponsiveContainer>
      </div>
      <div style={S.card}>
        <div style={S.cardTitle}>⚠️ Risques élevés</div>
        {equipements.filter(e=>e.scoreRisque>=50).sort((a,b)=>b.scoreRisque-a.scoreRisque).slice(0,4).map(e=>(
          <div key={e.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 0",borderBottom:"1px solid var(--w04)"}}>
            <div>
              <div style={{fontWeight:600,fontSize:13,color:"var(--text)"}}>{e.nom}</div>
              <div style={{fontSize:11,color:"var(--muted)"}}>{e.service}</div>
            </div>
            <div style={{fontWeight:800,color:riskColor(e.scoreRisque),fontSize:18}}>{e.scoreRisque}%</div>
          </div>
        ))}
        {equipements.filter(e=>e.scoreRisque>=50).length===0&&<div style={{color:"var(--muted)",fontSize:13}}>✅ Aucun risque élevé</div>}
      </div>
    </div>
  </div>
));

// ── IoT : configuration des capteurs et seuils ─────────────
const NOMS_CAPTEURS_DEFAUT=['Température','Vibration','Paramètre 3','Paramètre 4','Paramètre 5','Paramètre 6','Paramètre 7','Paramètre 8'];

// Formulaire de configuration (les seuils sont gardés en texte : "" = pas de seuil)
function formDepuisConfig(config){
  const f={nb_capteurs_actifs:config?.nb_capteurs_actifs||2};
  for(let i=1;i<=8;i++){
    f[`param${i}_nom`]=config?.[`param${i}_nom`]||NOMS_CAPTEURS_DEFAUT[i-1];
    f[`param${i}_unite`]=config?.[`param${i}_unite`]??(i===1?'°C':i===2?'g':'');
    f[`param${i}_min`]=config?.[`param${i}_min`]??'';
    f[`param${i}_max`]=config?.[`param${i}_max`]??'';
  }
  return f;
}

const aSeuil=v=>v!==null&&v!==undefined&&v!=='';
const fmtSeuil=v=>Number.isInteger(Number(v))?String(v):Number(v).toFixed(2);

// État d'un capteur par rapport à ses seuils : null (normal / pas de mesure), "haut" ou "bas"
function etatSeuil(config,idx,valeur){
  if(!config||valeur===null||valeur===undefined||isNaN(valeur)) return null;
  const min=config[`param${idx}_min`],max=config[`param${idx}_max`];
  if(aSeuil(max)&&valeur>Number(max)) return "haut";
  if(aSeuil(min)&&valeur<Number(min)) return "bas";
  return null;
}

// Liste lisible des dépassements pour la dernière mesure
function depassementsSeuils(config,mesure){
  if(!config||!mesure) return [];
  const liste=[];
  for(let idx=1;idx<=(config.nb_capteurs_actifs||2);idx++){
    const v=parseFloat(mesure[`param${idx}`]);
    const sens=etatSeuil(config,idx,v);
    if(!sens) continue;
    const nom=config[`param${idx}_nom`]||NOMS_CAPTEURS_DEFAUT[idx-1];
    const unite=config[`param${idx}_unite`]||'';
    const seuil=sens==="haut"?config[`param${idx}_max`]:config[`param${idx}_min`];
    liste.push(`${nom} ${sens==="haut"?"au-dessus du seuil":"en dessous du seuil"} : ${v.toFixed(2)} ${unite} (${sens==="haut"?"max":"min"} ${fmtSeuil(seuil)})`);
  }
  return liste;
}

function texteSeuils(config,idx){
  if(!config) return "";
  const min=config[`param${idx}_min`],max=config[`param${idx}_max`],u=config[`param${idx}_unite`]||'';
  if(aSeuil(min)&&aSeuil(max)) return `Plage normale : ${fmtSeuil(min)} à ${fmtSeuil(max)} ${u}`;
  if(aSeuil(max)) return `Seuil max : ${fmtSeuil(max)} ${u}`;
  if(aSeuil(min)) return `Seuil min : ${fmtSeuil(min)} ${u}`;
  return "Aucun seuil configuré";
}

const IoT = memo(({equipements,iotData,iotEquipId,monitoringActif,toggleMonitoring,changerEquipMonitoring,token,peutModifier})=>{
  const [capteursConfig,setCapteursConfig]=useState(null);
  const [cleAppareil,setCleAppareil]=useState(null);
  const [erreurCle,setErreurCle]=useState("");
  const [cleCopiee,setCleCopiee]=useState(false);
  useEffect(()=>{setCleAppareil(null);setErreurCle("");setCleCopiee(false);},[iotEquipId]);

  async function afficherCle(regenerer=false){
    setErreurCle("");setCleCopiee(false);
    if(regenerer&&!window.confirm("⚠️ Régénérer la clé ?\n\nL'ESP32 qui utilise l'ancienne clé ne pourra plus envoyer de données tant que vous n'aurez pas téléversé la nouvelle clé dans son programme.")) return;
    try{
      const r=await fetch(`${API}/equipements/${iotEquipId}/cle`,{method:regenerer?"POST":"GET",headers:{"Content-Type":"application/json","Authorization":`Bearer ${token}`}});
      const d=await r.json();
      if(r.ok) setCleAppareil(d.cle_appareil); else setErreurCle(d.erreur||"Impossible d'obtenir la clé.");
    }catch(err){setErreurCle("Erreur réseau : "+err.message);}
  }
  async function copierCle(){
    try{await navigator.clipboard.writeText(cleAppareil);setCleCopiee(true);setTimeout(()=>setCleCopiee(false),2500);}catch{setErreurCle("Copie impossible : sélectionnez la clé et faites Ctrl + C.");}
  }
  const [showConfigModal,setShowConfigModal]=useState(false);
  const [configForm,setConfigForm]=useState(()=>formDepuisConfig(null));
  const [erreurConfig,setErreurConfig]=useState("");
  const [sauvegarde,setSauvegarde]=useState(false);

  const dernier=iotData.length>0?iotData[iotData.length-1]:null;
  const equipementActuel=equipements.find(e=>e.id===iotEquipId);

  useEffect(()=>{
    if(!iotEquipId||!token) return;
    chargerConfig();
  },[iotEquipId]);

  async function chargerConfig(){
    try{
      const r=await fetch(`${API}/capteurs/config/${iotEquipId}`,{headers:{"Content-Type":"application/json","Authorization":`Bearer ${token}`}});
      if(r.ok){
        const config=await r.json();
        setCapteursConfig(config);
        setConfigForm(formDepuisConfig(config));
      }
    }catch(err){console.error("Erreur config:",err);}
  }

  async function sauvegarderConfig(){
    setErreurConfig("");
    if(!iotEquipId){setErreurConfig("Veuillez d'abord sélectionner un équipement.");return;}
    if(!token){setErreurConfig("Vous n'êtes pas connecté.");return;}
    setSauvegarde(true);
    try{
      const r=await fetch(`${API}/capteurs/config`,{
        method:'POST',
        headers:{"Content-Type":"application/json","Authorization":`Bearer ${token}`},
        body:JSON.stringify({equipement_id:iotEquipId,...configForm})
      });
      if(r.ok){
        await chargerConfig();
        setShowConfigModal(false);
        setErreurConfig("");
      }else{
        const err=await r.json();
        setErreurConfig("Erreur : "+(err.erreur||"Impossible de sauvegarder."));
      }
    }catch(err){
      setErreurConfig("Erreur réseau : "+err.message);
    }finally{
      setSauvegarde(false);
    }
  }

  const chartData=iotData.slice(-15).map((d,i)=>{
    const point={i};
    for(let idx=1;idx<=8;idx++) point[`param${idx}`]=parseFloat(d[`param${idx}`])||0;
    return point;
  });

  return(
    <div>
      {/* Modal configuration */}
      {showConfigModal&&(
        <div style={S.overlay}>
          <div style={{...S.modal,maxWidth:600}}>
            <h3 style={{marginBottom:8,color:"var(--text)"}}>⚙️ Configurer les capteurs</h3>
            <div style={{background:"rgba(0,212,170,0.08)",border:"1px solid rgba(0,212,170,0.2)",borderRadius:8,padding:"10px 14px",marginBottom:20}}>
              <span style={{fontSize:12,color:"var(--muted)"}}>Équipement : </span>
              <span style={{fontWeight:700,color:"#00D4AA"}}>{equipementActuel?.nom||"—"}</span>
            </div>
            <div style={{marginBottom:16}}>
              <label style={S.lbl}>Nombre de capteurs actifs (2 à 8)</label>
              <input type="number" min="2" max="8"
                value={configForm.nb_capteurs_actifs}
                onChange={e=>setConfigForm(p=>({...p,nb_capteurs_actifs:Math.min(8,Math.max(2,parseInt(e.target.value)||2))}))}
                style={{...S.inp,maxWidth:100}}
              />
            </div>
            <div style={{fontSize:12,color:"var(--muted-2)",marginBottom:14,lineHeight:1.6}}>
              Seuils : laissez une case vide pour ne pas fixer de limite de ce côté.
              Une mesure en dehors de la plage déclenche une alerte « Anomalie », et les seuils sont envoyés automatiquement à l'ESP32.
            </div>
            {[...Array(configForm.nb_capteurs_actifs)].map((_,i)=>{
              const idx=i+1;
              return(
                <div key={idx} style={{border:"1px solid var(--w06)",borderRadius:10,padding:"14px 14px 2px",marginBottom:12}}>
                  <div style={{fontSize:12,fontWeight:700,color:"#A78BFA",marginBottom:10}}>Capteur {idx} — param{idx}</div>
                  <div style={{...S.fgrid,marginBottom:12}}>
                    <div>
                      <label style={S.lbl}>Nom</label>
                      <input style={S.inp} value={configForm[`param${idx}_nom`]}
                        onChange={e=>setConfigForm(p=>({...p,[`param${idx}_nom`]:e.target.value}))}
                        placeholder={`Paramètre ${idx}`}
                      />
                    </div>
                    <div>
                      <label style={S.lbl}>Unité</label>
                      <input style={S.inp} value={configForm[`param${idx}_unite`]}
                        onChange={e=>setConfigForm(p=>({...p,[`param${idx}_unite`]:e.target.value}))}
                        placeholder="Ex: °C, g, bar..."
                      />
                    </div>
                  </div>
                  <div style={{...S.fgrid,marginBottom:12}}>
                    <div>
                      <label style={S.lbl}>Seuil min</label>
                      <input style={S.inp} type="number" step="any" value={configForm[`param${idx}_min`]}
                        onChange={e=>setConfigForm(p=>({...p,[`param${idx}_min`]:e.target.value}))}
                        placeholder="Aucun"
                      />
                    </div>
                    <div>
                      <label style={S.lbl}>Seuil max</label>
                      <input style={S.inp} type="number" step="any" value={configForm[`param${idx}_max`]}
                        onChange={e=>setConfigForm(p=>({...p,[`param${idx}_max`]:e.target.value}))}
                        placeholder="Aucun"
                      />
                    </div>
                  </div>
                </div>
              );
            })}
            {erreurConfig&&(
              <div style={{background:"rgba(255,77,109,0.1)",border:"1px solid rgba(255,77,109,0.3)",borderRadius:8,padding:"10px 14px",marginBottom:16,color:"#FF4D6D",fontSize:13}}>
                ❌ {erreurConfig}
              </div>
            )}
            <div style={{display:'flex',gap:12,marginTop:8}}>
              <button onClick={()=>{setShowConfigModal(false);setErreurConfig("");}} style={S.btnO}>Annuler</button>
              <button onClick={sauvegarderConfig} disabled={sauvegarde}
                style={{...S.btnSolid("#00D4AA"),flex:1,opacity:sauvegarde?0.6:1}}>
                {sauvegarde?"⏳ Sauvegarde...":"✅ Sauvegarder la configuration"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Interface principale */}
      <div style={{...S.card,display:"flex",alignItems:"center",gap:20,flexWrap:"wrap"}}>
        <div style={{flex:1}}>
          <label style={S.lbl}>Équipement à surveiller</label>
          <select style={{...S.sel,maxWidth:320}} value={iotEquipId} onChange={e=>changerEquipMonitoring(parseInt(e.target.value))}>
            {equipements.map(e=><option key={e.id} value={e.id}>{e.nom}</option>)}
          </select>
          {iotEquipId&&peutModifier&&(
            <button onClick={()=>{setErreurConfig("");setShowConfigModal(true);}}
              style={{...S.btn("#A78BFA"),marginTop:10,fontSize:12}}>
              ⚙️ Configurer les capteurs
            </button>
          )}
        </div>
        <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:8}}>
          <div style={{fontSize:10,fontWeight:700,color:"var(--muted)",textTransform:"uppercase",letterSpacing:"0.1em"}}>Monitoring</div>
          <button onClick={toggleMonitoring} style={{padding:"10px 28px",borderRadius:10,border:"none",cursor:"pointer",fontWeight:700,fontSize:14,background:monitoringActif?"#00D4AA":"var(--w08)",color:monitoringActif?"#020B18":"var(--muted-2)",boxShadow:monitoringActif?"0 0 20px rgba(0,212,170,0.4)":"none"}}>
            {monitoringActif?"⏹️ Arrêter":"▶️ Démarrer"}
          </button>
          <div style={{fontSize:11,color:monitoringActif?"#00D4AA":"var(--muted-3)",fontWeight:600}}>{monitoringActif?"● EN COURS":"○ INACTIF"}</div>
        </div>
      </div>

      {/* Clé d'appareil ESP32 (réservée à l'administrateur et à l'ingénieur) */}
      {peutModifier&&equipementActuel&&(
        <div style={S.card}>
          <div style={S.cardTitle}>🔑 Clé de l'appareil ESP32 — {equipementActuel.nom}</div>
          <div style={{fontSize:13,color:"var(--muted-2)",marginBottom:14,lineHeight:1.6}}>
            Cette clé secrète identifie l'ESP32 installé sur cet équipement. Copiez-la dans le programme Arduino
            (ligne <code style={{color:"#A78BFA"}}>DEVICE_KEY</code>) avant de le téléverser. Ne la partagez pas.
          </div>
          {!cleAppareil?(
            <button style={S.btn("#A78BFA")} onClick={()=>afficherCle(false)}>👁️ Afficher la clé</button>
          ):(
            <>
              <div style={{fontFamily:"monospace",fontSize:13,color:"#00D4AA",background:"var(--code-bg)",border:"1px solid rgba(0,212,170,0.25)",borderRadius:8,padding:"12px 14px",wordBreak:"break-all",userSelect:"all",marginBottom:12}}>
                const char* DEVICE_KEY = "{cleAppareil}";
              </div>
              <div style={{display:"flex",gap:10,flexWrap:"wrap"}}>
                <button style={S.btn("#00D4AA")} onClick={copierCle}>{cleCopiee?"✅ Copiée !":"📋 Copier la clé"}</button>
                <button style={S.btn("#64748B")} onClick={()=>setCleAppareil(null)}>🙈 Masquer</button>
                <button style={S.btn("#FF4D6D")} onClick={()=>afficherCle(true)}>🔄 Régénérer</button>
              </div>
            </>
          )}
          {erreurCle&&<div style={{marginTop:12,color:"#FF4D6D",fontSize:13}}>❌ {erreurCle}</div>}
        </div>
      )}

      {monitoringActif?(
        <>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(160px,1fr))",gap:16,marginBottom:24}}>
            <div style={{background:"rgba(0,212,170,0.08)",border:"1px solid rgba(0,212,170,0.2)",borderRadius:12,padding:20,textAlign:"center"}}>
              <div style={{fontSize:32}}>{dernier?.etat?"⚡":"💤"}</div>
              <div style={{fontSize:28,fontWeight:900,color:dernier?.etat?"#00D4AA":"var(--muted)",marginTop:4}}>{dernier?.etat?"Actif":"Inactif"}</div>
              <div style={{fontSize:12,color:"var(--muted)",marginTop:4}}>État</div>
            </div>
            <div style={{background:"rgba(255,77,109,0.08)",border:"1px solid rgba(255,77,109,0.2)",borderRadius:12,padding:20,textAlign:"center"}}>
              <div style={{fontSize:32}}>{dernier?.panne?"🔴":"✅"}</div>
              <div style={{fontSize:28,fontWeight:900,color:dernier?.panne?"#FF4D6D":"#00D4AA",marginTop:4}}>{dernier?.panne?"OUI":"NON"}</div>
              <div style={{fontSize:12,color:"var(--muted)",marginTop:4}}>Panne</div>
            </div>
            {(()=>{
              const alertes=depassementsSeuils(capteursConfig,dernier);
              const enAlerte=alertes.length>0;
              const c=!dernier?"#475569":enAlerte?"#F59E0B":"#00D4AA";
              return(
                <div style={{background:`${c}14`,border:`1px solid ${c}40`,borderRadius:12,padding:20,textAlign:"center",boxShadow:enAlerte?`0 0 18px ${c}30`:"none"}}>
                  <div style={{fontSize:32}}>{!dernier?"⏳":enAlerte?"⚠️":"✅"}</div>
                  <div style={{fontSize:24,fontWeight:900,color:c,marginTop:4}}>{!dernier?"--":enAlerte?"ALERTE":"NORMAL"}</div>
                  <div style={{fontSize:12,color:"var(--muted)",marginTop:4}}>Seuils</div>
                  {enAlerte&&<div style={{fontSize:11,color:"#F59E0B",marginTop:8,lineHeight:1.5,textAlign:"left"}}>{alertes.map((a,k)=><div key={k}>• {a}</div>)}</div>}
                </div>
              );
            })()}
            {capteursConfig&&[...Array(capteursConfig.nb_capteurs_actifs||2)].map((_,i)=>{
              const idx=i+1;
              const nom=capteursConfig[`param${idx}_nom`]||`Paramètre ${idx}`;
              const unite=capteursConfig[`param${idx}_unite`]||'';
              const val=dernier?parseFloat(dernier[`param${idx}`]):null;
              const sens=etatSeuil(capteursConfig,idx,val);
              const c=sens?"#F59E0B":null;
              return(
                <div key={idx} style={{background:c?`${c}14`:"var(--w03)",border:`1px solid ${c?`${c}50`:"var(--w06)"}`,borderRadius:12,padding:20,textAlign:"center"}}>
                  <div style={{fontSize:32}}>{sens==="haut"?"🔺":sens==="bas"?"🔻":"📊"}</div>
                  <div style={{fontSize:24,fontWeight:900,color:c||"var(--text)",marginTop:4}}>{val!==null&&!isNaN(val)?val.toFixed(2):"--"}</div>
                  <div style={{fontSize:12,color:"var(--muted)",marginTop:4}}>{nom} {unite&&`(${unite})`}</div>
                  <div style={{fontSize:10,color:c||"var(--muted-3)",marginTop:6}}>{texteSeuils(capteursConfig,idx)}</div>
                </div>
              );
            })}
          </div>
          {chartData.length>0&&capteursConfig&&(
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(400px,1fr))",gap:24}}>
              {[...Array(capteursConfig.nb_capteurs_actifs||2)].map((_,i)=>{
                const idx=i+1;
                const nom=capteursConfig[`param${idx}_nom`]||`Paramètre ${idx}`;
                const unite=capteursConfig[`param${idx}_unite`]||'';
                const couleur=COULEURS[i%COULEURS.length];
                return(
                  <div key={idx} style={S.card}>
                    <div style={S.cardTitle}>📈 Évolution {nom} {unite&&`(${unite})`}</div>
                    <ResponsiveContainer width="100%" height={200}>
                      <LineChart data={chartData}>
                        <XAxis dataKey="i" hide/><YAxis tick={{fill:"var(--muted-2)"}}/>
                        <Tooltip contentStyle={{background:"var(--tooltip-bg)",border:`1px solid ${couleur}30`,borderRadius:8,color:"var(--text)"}} formatter={v=>`${v} ${unite}`}/>
                        <Line type="monotone" dataKey={`param${idx}`} stroke={couleur} strokeWidth={2} dot={false}/>
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                );
              })}
            </div>
          )}
        </>
      ):(
        <div style={{...S.card,padding:48,textAlign:"center"}}>
          <div style={{fontSize:48,marginBottom:16}}>📡</div>
          <div style={{fontSize:18,fontWeight:700,color:"var(--text)",marginBottom:8}}>Monitoring désactivé</div>
          <div style={{fontSize:14,color:"var(--muted)",marginBottom:24}}>
            {equipementActuel?`Appuyez sur "▶️ Démarrer" pour surveiller ${equipementActuel.nom} en temps réel.`:"Sélectionnez d'abord un équipement ci-dessus, puis démarrez le monitoring."}
          </div>
          <button onClick={toggleMonitoring} style={{...S.btnSolid("#00D4AA"),fontSize:15,padding:"12px 32px"}}>▶️ Démarrer le monitoring</button>
        </div>
      )}
      <div style={{...S.card,marginTop:24}}>
        <div style={S.cardTitle}>📋 Historique des mesures ({iotData.length} entrées)</div>
        {iotData.length===0?(
          <div style={{textAlign:"center",padding:32,color:"var(--muted-3)"}}><div style={{fontSize:32,marginBottom:8}}>📂</div><div>Aucune donnée disponible</div></div>
        ):(
          <table style={S.tbl}>
            <thead>
              <tr>
                <th style={S.th}>Date & Heure</th>
                {capteursConfig&&[...Array(capteursConfig.nb_capteurs_actifs||2)].map((_,i)=>{
                  const idx=i+1;
                  return <th key={idx} style={S.th}>{capteursConfig[`param${idx}_nom`]||`Param ${idx}`} {capteursConfig[`param${idx}_unite`]&&`(${capteursConfig[`param${idx}_unite`]})`}</th>;
                })}
                <th style={S.th}>Seuils</th>
                <th style={S.th}>État</th>
                <th style={S.th}>Panne</th>
              </tr>
            </thead>
            <tbody>
              {[...iotData].reverse().slice(0,15).map((d,i)=>(
                <tr key={i}>
                  <td style={{...S.td,fontSize:12,color:"var(--muted)"}}>{formaterDate(d.timestamp)}</td>
                  {capteursConfig&&[...Array(capteursConfig.nb_capteurs_actifs||2)].map((_,j)=>{
                    const idx=j+1;
                    const val=d[`param${idx}`];
                    const hors=etatSeuil(capteursConfig,idx,parseFloat(val));
                    return <td key={idx} style={S.td}><span style={{color:hors?"#F59E0B":"var(--text)",fontWeight:700}}>{val!==null&&val!==undefined?parseFloat(val).toFixed(2):"--"}{hors==="haut"?" 🔺":hors==="bas"?" 🔻":""}</span></td>;
                  })}
                  <td style={S.td}>{depassementsSeuils(capteursConfig,d).length>0?<span style={{color:"#F59E0B"}}>⚠️ Alerte</span>:"✅ Normal"}</td>
                  <td style={S.td}>{d.etat==1?"⚡ Actif":"💤 Inactif"}</td>
                  <td style={S.td}>{d.panne?"🔴 Oui":"✅ Non"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
});

const Equipements = memo(({equipements,peutModifier,supprimerEquipement,changerEquipMonitoring,setOnglet,token,charger})=>{
  const [recherche,setRecherche]=useState("");
  const [filtreStatut,setFiltreStatut]=useState("Tous");
  const [showForm,setShowForm]=useState(false);
  const FORM_VIDE={nom:"",marque:"",numeroSerie:"",service:"",statut:"En service",dateAcquisition:"",prochaineMaintenance:""};
  const [form,setForm]=useState(FORM_VIDE);
  const [enEdition,setEnEdition]=useState(null); // id de l'équipement modifié, ou null pour un ajout
  const [erreurForm,setErreurForm]=useState("");
  const [envoi,setEnvoi]=useState(false);
  function ouvrirAjout(){setEnEdition(null);setForm(FORM_VIDE);setErreurForm("");setShowForm(true);}
  function ouvrirModification(e){
    setEnEdition(e.id);setErreurForm("");
    setForm({nom:e.nom||"",marque:e.marque||"",numeroSerie:e.numeroSerie||"",service:e.service||"",statut:e.statut||"En service",dateAcquisition:e.dateAcquisition||"",prochaineMaintenance:e.prochaineMaintenance||""});
    setShowForm(true);
  }
  function fermerForm(){setShowForm(false);setEnEdition(null);setForm(FORM_VIDE);setErreurForm("");}

  const filtres=equipements.filter(e=>{
    const r=recherche.toLowerCase();
    return(e.nom?.toLowerCase().includes(r)||e.numeroSerie?.toLowerCase().includes(r)||e.service?.toLowerCase().includes(r))&&(filtreStatut==="Tous"||e.statut===filtreStatut);
  });
  const [triEq,setTriEq]=useTri("equipements","ajout_recent",TRIS_EQUIPEMENT);
  const listeTriee=trierListe(filtres,TRIS_EQUIPEMENT,triEq);

  async function sauvegarder(){
    if(!form.nom.trim()||!form.numeroSerie.trim()){setErreurForm("Le nom et le numéro de série sont obligatoires.");return;}
    setEnvoi(true);setErreurForm("");
    try{
      const url=enEdition?`${API}/equipements/${enEdition}`:`${API}/equipements`;
      const r=await fetch(url,{method:enEdition?"PUT":"POST",headers:{"Content-Type":"application/json","Authorization":`Bearer ${token}`},body:JSON.stringify(form)});
      if(!r.ok){const d=await r.json().catch(()=>({}));setErreurForm(d.erreur||`Erreur ${r.status}`);return;}
      fermerForm();
      await charger();
    }catch{setErreurForm("Serveur inaccessible.");}
    finally{setEnvoi(false);}
  }

  return(
    <div>
      <div style={{display:"flex",gap:12,marginBottom:20,flexWrap:"wrap"}}>
        <input style={{...S.inp,maxWidth:280}} placeholder="🔍 Rechercher..." value={recherche} onChange={e=>setRecherche(e.target.value)}/>
        <select style={{...S.sel,maxWidth:180}} value={filtreStatut} onChange={e=>setFiltreStatut(e.target.value)}>
          {["Tous","En service","En maintenance","En panne"].map(s=><option key={s}>{s}</option>)}
        </select>
        <SelecteurTri tris={TRIS_EQUIPEMENT} valeur={triEq} onChange={setTriEq}/>
        {peutModifier&&<button style={S.btn()} onClick={ouvrirAjout}>+ Ajouter</button>}
      </div>
      <div style={S.card}>
        <table style={S.tbl}>
          <thead><tr>{["Équipement","N° Série","Service","Ancienneté","Statut","Risque","Proch. Maint.","Actions"].map(h=><th key={h} style={S.th}>{h}</th>)}</tr></thead>
          <tbody>
            {listeTriee.map(e=>(
              <tr key={e.id}>
                <td style={S.td}><div style={{fontWeight:600,color:"var(--text)"}}>{e.nom}</div><div style={{fontSize:11,color:"var(--muted-3)"}}>{e.marque}</div></td>
                <td style={S.td}><code style={{background:"rgba(0,212,170,0.08)",color:"#00D4AA",padding:"2px 8px",borderRadius:4,fontSize:11}}>{e.numeroSerie}</code></td>
                <td style={S.td}>{e.service}</td>
                <td style={S.td}><span style={{color:"var(--text-2)",whiteSpace:"nowrap"}} title={e.dateAcquisition?`Acquis le ${new Date(e.dateAcquisition).toLocaleDateString("fr-FR")}`:"Date d'acquisition non renseignée"}>{texteAnciennete(e.dateAcquisition)}</span></td>
                <td style={S.td}><span style={badge(e.statut)}>{e.statut}</span></td>
                <td style={S.td}>
                  <div style={{display:"flex",alignItems:"center",gap:8}}>
                    <div style={{width:60,height:5,background:"var(--w08)",borderRadius:3}}>
                      <div style={{width:`${e.scoreRisque}%`,height:"100%",background:riskColor(e.scoreRisque),borderRadius:3}}/>
                    </div>
                    <span style={{fontWeight:700,color:riskColor(e.scoreRisque),fontSize:13}}>{e.scoreRisque}%</span>
                  </div>
                </td>
                <td style={S.td}><span style={{color:"var(--muted)"}}>{e.prochaineMaintenance||"—"}</span></td>
                <td style={S.td}>
                  <div style={{display:"flex",gap:6}}>
                    <button onClick={()=>{changerEquipMonitoring(e.id);setOnglet("iot");}} style={{background:"rgba(59,130,246,0.12)",color:"#60A5FA",border:"1px solid rgba(59,130,246,0.2)",padding:"4px 8px",borderRadius:6,cursor:"pointer",fontSize:11}}>📡</button>
                    <button onClick={()=>setOnglet("ia")} style={{background:"rgba(245,158,11,0.12)",color:"#F59E0B",border:"1px solid rgba(245,158,11,0.2)",padding:"4px 8px",borderRadius:6,cursor:"pointer",fontSize:11}}>🤖</button>
                    {peutModifier&&<button onClick={()=>ouvrirModification(e)} title="Modifier" style={{background:"rgba(167,139,250,0.12)",color:"#A78BFA",border:"1px solid rgba(167,139,250,0.25)",padding:"4px 8px",borderRadius:6,cursor:"pointer",fontSize:11}}>✏️</button>}
                    {peutModifier&&<button onClick={()=>supprimerEquipement(e.id)} style={{background:"rgba(255,77,109,0.1)",color:"#FF4D6D",border:"1px solid rgba(255,77,109,0.2)",padding:"4px 8px",borderRadius:6,cursor:"pointer",fontSize:11}}>✕</button>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtres.length===0&&<div style={{textAlign:"center",padding:40,color:"var(--muted-3)"}}>Aucun équipement trouvé</div>}
      </div>
      {showForm&&(
        <div style={S.overlay}>
          <div style={S.modal}>
            <h3 style={{marginBottom:20,color:"var(--text)",fontSize:18}}>{enEdition?"✏️ Modifier l'équipement":"➕ Nouvel équipement"}</h3>
            <div style={S.fgrid}>
              <div><label style={S.lbl}>Nom *</label><input style={S.inp} placeholder="Ex: Electrocardiographe" value={form.nom} onChange={e=>setForm(p=>({...p,nom:e.target.value}))}/></div>
              <div><label style={S.lbl}>Marque</label><input style={S.inp} placeholder="Ex: GE Healthcare" value={form.marque} onChange={e=>setForm(p=>({...p,marque:e.target.value}))}/></div>
              <div><label style={S.lbl}>N° Série *</label><input style={S.inp} placeholder="Ex: ECG-2024-001" value={form.numeroSerie} onChange={e=>setForm(p=>({...p,numeroSerie:e.target.value}))}/></div>
              <div><label style={S.lbl}>Service</label><input style={S.inp} placeholder="Ex: Cardiologie" value={form.service} onChange={e=>setForm(p=>({...p,service:e.target.value}))}/></div>
              <div><label style={S.lbl}>Date acquisition</label><input style={S.inp} type="date" max={new Date().toISOString().split("T")[0]} value={form.dateAcquisition} onChange={e=>setForm(p=>({...p,dateAcquisition:e.target.value}))}/></div>
              <div><label style={S.lbl}>Prochaine maintenance</label><input style={S.inp} type="date" value={form.prochaineMaintenance} onChange={e=>setForm(p=>({...p,prochaineMaintenance:e.target.value}))}/></div>
              <div><label style={S.lbl}>Statut</label><select style={S.sel} value={form.statut} onChange={e=>setForm(p=>({...p,statut:e.target.value}))}><option>En service</option><option>En maintenance</option><option>En panne</option></select></div>
            </div>
            {enEdition&&<div style={{fontSize:12,color:"var(--muted)",marginBottom:12}}>ℹ️ Le score de risque est recalculé automatiquement. La clé de l'ESP32 n'est pas modifiée.</div>}
            {erreurForm&&<div style={{background:"rgba(255,77,109,0.1)",border:"1px solid rgba(255,77,109,0.3)",borderRadius:8,padding:"8px 12px",marginBottom:12,color:"#FF4D6D",fontSize:13}}>❌ {erreurForm}</div>}
            <div style={{display:"flex",gap:12,justifyContent:"flex-end"}}>
              <button style={S.btnO} onClick={fermerForm}>Annuler</button>
              <button style={S.btnSolid()} onClick={sauvegarder} disabled={envoi}>{envoi?"⏳ Enregistrement...":"Enregistrer"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
});

const Maintenances = memo(({maintenances,equipements,ajouterMaintenance,changerStatutMaintenance})=>{
  const [showForm,setShowForm]=useState(false);
  const [form,setForm]=useState({equipementId:"",type:"Préventive",statut:"Planifiée",datePlanifiee:"",technicien:"",description:""});
  function sauvegarder(){ajouterMaintenance(form,()=>{setShowForm(false);setForm({equipementId:"",type:"Préventive",statut:"Planifiée",datePlanifiee:"",technicien:"",description:""});});}
  const [triM,setTriM]=useTri("maintenances","date_desc",TRIS_MAINTENANCE);
  const listeTriee=trierListe(maintenances,TRIS_MAINTENANCE,triM);
  return(
    <div>
      <div style={{display:"flex",gap:12,marginBottom:20,flexWrap:"wrap"}}>
        <button style={S.btn()} onClick={()=>setShowForm(true)}>+ Planifier une maintenance</button>
        <SelecteurTri tris={TRIS_MAINTENANCE} valeur={triM} onChange={setTriM}/>
      </div>
      <div style={S.card}>
        <table style={S.tbl}>
          <thead><tr>{["Équipement","Type","Date","Technicien","Description","Statut","Action"].map(h=><th key={h} style={S.th}>{h}</th>)}</tr></thead>
          <tbody>
            {listeTriee.map(m=>(
              <tr key={m.id}>
                <td style={S.td}><div style={{fontWeight:600,color:"var(--text)"}}>{m.equipementNom}</div></td>
                <td style={S.td}><span style={{background:m.type==="Préventive"?"rgba(59,130,246,0.12)":"rgba(255,77,109,0.1)",color:m.type==="Préventive"?"#60A5FA":"#FF4D6D",border:`1px solid ${m.type==="Préventive"?"rgba(59,130,246,0.25)":"rgba(255,77,109,0.25)"}`,padding:"3px 10px",borderRadius:999,fontSize:11,fontWeight:600}}>{m.type}</span></td>
                <td style={S.td}>{m.datePlanifiee}</td>
                <td style={S.td}>{m.technicien||"—"}</td>
                <td style={{...S.td,color:"var(--muted)"}}>{m.description}</td>
                <td style={S.td}><span style={badge(m.statut)}>{m.statut}</span></td>
                <td style={S.td}>
                  {m.statut==="Planifiée"&&(
                    <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                      <button style={{...S.btn("#F59E0B"),fontSize:11,padding:"4px 10px"}} onClick={()=>changerStatutMaintenance(m,"En cours")}>▶️ Démarrer</button>
                      <button style={{...S.btn("#00D4AA"),fontSize:11,padding:"4px 10px"}} onClick={()=>changerStatutMaintenance(m,"Terminée")}>✅ Terminer</button>
                    </div>
                  )}
                  {m.statut==="En cours"&&(
                    <button style={{...S.btn("#00D4AA"),fontSize:11,padding:"4px 10px"}} onClick={()=>changerStatutMaintenance(m,"Terminée")}>✅ Terminer</button>
                  )}
                  {m.statut==="Terminée"&&<span style={{fontSize:11,color:"var(--muted)"}}>{m.dateTerminee?`Terminée le ${formaterDate(m.dateTerminee)}`:"—"}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {maintenances.length===0&&<div style={{textAlign:"center",padding:40,color:"var(--muted-3)"}}>Aucune maintenance</div>}
      </div>
      {showForm&&(
        <div style={S.overlay}>
          <div style={S.modal}>
            <h3 style={{marginBottom:20,color:"var(--text)",fontSize:18}}>🔧 Planifier une maintenance</h3>
            <div style={S.fgrid}>
              <div style={{gridColumn:"1 / -1"}}><label style={S.lbl}>Équipement *</label>
                <select style={S.sel} value={form.equipementId} onChange={e=>setForm(p=>({...p,equipementId:e.target.value}))}>
                  <option value="">-- Sélectionner --</option>
                  {trierListe(equipements,TRIS_EQUIPEMENT,"nom_az").map(e=><option key={e.id} value={e.id}>{e.nom} ({e.numeroSerie})</option>)}
                </select>
              </div>
              <div><label style={S.lbl}>Type</label><select style={S.sel} value={form.type} onChange={e=>setForm(p=>({...p,type:e.target.value}))}><option>Préventive</option><option>Corrective</option><option>Calibration</option></select></div>
              <div><label style={S.lbl}>Date *</label><input style={S.inp} type="date" value={form.datePlanifiee} onChange={e=>setForm(p=>({...p,datePlanifiee:e.target.value}))}/></div>
              <div><label style={S.lbl}>Technicien</label><input style={S.inp} placeholder="Nom du technicien" value={form.technicien} onChange={e=>setForm(p=>({...p,technicien:e.target.value}))}/></div>
              <div><label style={S.lbl}>Statut</label><select style={S.sel} value={form.statut} onChange={e=>setForm(p=>({...p,statut:e.target.value}))}><option>Planifiée</option><option>En cours</option><option>Terminée</option></select></div>
              <div style={{gridColumn:"1 / -1"}}><label style={S.lbl}>Description</label><input style={S.inp} placeholder="Description" value={form.description} onChange={e=>setForm(p=>({...p,description:e.target.value}))}/></div>
            </div>
            <div style={{display:"flex",gap:12,justifyContent:"flex-end"}}>
              <button style={S.btnO} onClick={()=>setShowForm(false)}>Annuler</button>
              <button style={S.btnSolid()} onClick={sauvegarder}>Enregistrer</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
});

const Calendrier = memo(({maintenances})=>{
  const [moisCal,setMoisCal]=useState(new Date());
  function joursDuMois(d){const y=d.getFullYear(),m=d.getMonth();const p=new Date(y,m,1),l=new Date(y,m+1,0);const j=[];for(let i=0;i<p.getDay();i++) j.push(null);for(let dd=1;dd<=l.getDate();dd++) j.push(new Date(y,m,dd));return j;}
  const jours=joursDuMois(moisCal);
  const nomsJ=["Dim","Lun","Mar","Mer","Jeu","Ven","Sam"];
  const retard=maintenances.filter(m=>new Date(m.datePlanifiee)<new Date()&&m.statut==="Planifiée");
  return(
    <div>
      {retard.length>0&&(<div style={{background:"rgba(255,77,109,0.08)",border:"1px solid rgba(255,77,109,0.2)",borderRadius:10,padding:16,marginBottom:20}}><div style={{fontWeight:700,color:"#FF4D6D",marginBottom:8}}>⚠️ {retard.length} maintenance(s) en retard !</div>{retard.map(m=><div key={m.id} style={{fontSize:13,color:"rgba(255,77,109,0.8)"}}>• {m.equipementNom} — prévu le {m.datePlanifiee}</div>)}</div>)}
      <div style={S.card}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}}>
          <button style={S.btnO} onClick={()=>setMoisCal(new Date(moisCal.getFullYear(),moisCal.getMonth()-1))}>← Précédent</button>
          <div style={{fontSize:18,fontWeight:700,color:"var(--text)",textTransform:"capitalize"}}>{moisCal.toLocaleDateString("fr-FR",{month:"long",year:"numeric"})}</div>
          <button style={S.btnO} onClick={()=>setMoisCal(new Date(moisCal.getFullYear(),moisCal.getMonth()+1))}>Suivant →</button>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:4}}>
          {nomsJ.map(j=><div key={j} style={{textAlign:"center",fontSize:11,fontWeight:700,color:"var(--muted-3)",padding:"8px 0",textTransform:"uppercase",letterSpacing:"0.05em"}}>{j}</div>)}
          {jours.map((date,i)=>{
            const maints=date?maintenances.filter(m=>m.datePlanifiee===date.toISOString().split("T")[0]):[];
            const auj=date&&date.toDateString()===new Date().toDateString();
            return(<div key={i} style={{minHeight:68,padding:6,borderRadius:8,background:auj?"rgba(0,212,170,0.08)":date?"var(--w02)":"transparent",border:auj?"1px solid rgba(0,212,170,0.3)":date?"1px solid var(--w04)":"none"}}>{date&&<><div style={{fontSize:13,fontWeight:auj?700:400,color:auj?"#00D4AA":"var(--muted-2)"}}>{date.getDate()}</div>{maints.map(m=><div key={m.id} style={{fontSize:9,padding:"2px 4px",borderRadius:3,marginTop:2,background:m.type==="Préventive"?"rgba(59,130,246,0.2)":"rgba(255,77,109,0.15)",color:m.type==="Préventive"?"#60A5FA":"#FF4D6D",fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>🔧 {m.equipementNom}</div>)}</>}</div>);
          })}
        </div>
      </div>
    </div>
  );
});

const Alertes = memo(({alertes,equipements,lireAlerte,setOnglet})=>(
  <div>
    {alertes.length>0&&(<div style={S.card}><div style={S.cardTitle}>🔔 Alertes automatiques</div>{alertes.slice(0,10).map(a=>(<div key={a.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"12px 16px",marginBottom:8,borderRadius:8,background:a.estLue?"var(--w02)":a.severite==="CRITIQUE"?"rgba(255,77,109,0.06)":a.severite==="INFO"?"rgba(0,212,170,0.06)":"rgba(245,158,11,0.06)",border:`1px solid ${a.estLue?"var(--w05)":a.severite==="CRITIQUE"?"rgba(255,77,109,0.2)":a.severite==="INFO"?"rgba(0,212,170,0.2)":"rgba(245,158,11,0.2)"}`,opacity:a.estLue?0.6:1}}><div><div style={{fontWeight:700,color:a.severite==="CRITIQUE"?"#FF4D6D":a.severite==="INFO"?"#00D4AA":"#F59E0B",fontSize:13}}>{a.severite==="CRITIQUE"?"🔴":a.severite==="INFO"?"✅":"🟡"} {String(a.type||"").replace(/_/g," ")} — {equipements.find(e=>e.id===a.equipement_id)?.nom||`Équipement #${a.equipement_id}`}</div><div style={{fontSize:12,color:"var(--muted)",marginTop:4}}>{a.message}</div><div style={{fontSize:11,color:"var(--muted-3)",marginTop:2}}>{formaterDate(a.createdAt)}</div></div><div style={{display:"flex",gap:8,alignItems:"center"}}><span style={badge(a.severite)}>{a.severite}</span>{!a.estLue&&<button style={{...S.btn("#64748B"),fontSize:11,padding:"4px 10px"}} onClick={()=>lireAlerte(a.id)}>Lue</button>}</div></div>))}</div>)}
    {equipements.filter(e=>e.scoreRisque>=75).map(e=>(<div key={e.id} style={{background:"rgba(255,77,109,0.06)",border:"1px solid rgba(255,77,109,0.2)",borderRadius:10,padding:16,marginBottom:12,display:"flex",justifyContent:"space-between",alignItems:"center"}}><div><div style={{fontWeight:700,color:"#FF4D6D"}}>🔴 RISQUE CRITIQUE — {e.nom}</div><div style={{fontSize:13,color:"rgba(255,77,109,0.7)",marginTop:4}}>Service : {e.service} | Score : {e.scoreRisque}%</div></div><button style={S.btnSolid("#FF4D6D")} onClick={()=>setOnglet("maintenances")}>Planifier</button></div>))}
    {alertes.length===0&&equipements.filter(e=>e.scoreRisque>=50).length===0&&(<div style={{...S.card,padding:32,textAlign:"center"}}><div style={{fontSize:18,color:"#00D4AA",fontWeight:700}}>✅ Aucune alerte active</div></div>)}
  </div>
));

const Utilisateurs = memo(({utilisateurs,currentUserId,desactiverUtilisateur,reactiverUtilisateur,ajouterUtilisateur,organisation,changerRole,token,transfererPropriete})=>{
  const MAX_ADMINS=3;
  const jeSuisProprio=!!utilisateurs.find(u=>u.id===currentUserId)?.est_proprietaire;
  const nbAdmins=utilisateurs.filter(u=>u.role==="ADMIN"&&u.actif===1).length;
  const [codes,setCodes]=useState(null);
  const [erreurCodes,setErreurCodes]=useState("");
  const enTetes={"Content-Type":"application/json","Authorization":`Bearer ${token}`};
  useEffect(()=>{(async()=>{try{const r=await fetch(`${API}/organisation/codes`,{headers:enTetes});const d=await r.json();if(r.ok)setCodes(d);else setErreurCodes(d.erreur||"");}catch{}})();},[]);
  async function regenererCode(role){
    if(!window.confirm(`Régénérer le code ${role==="INGENIEUR"?"Ingénieur":"Technicien"} ?\n\nL'ancien code ne fonctionnera plus. Les comptes déjà créés ne sont pas touchés.`)) return;
    try{const r=await fetch(`${API}/organisation/codes/regenerer`,{method:"POST",headers:enTetes,body:JSON.stringify({role})});const d=await r.json();if(r.ok){setCodes(d);setErreurCodes("");}else setErreurCodes(d.erreur||"Erreur");}catch{setErreurCodes("Erreur réseau");}
  }
  const [showForm,setShowForm]=useState(false);
  const [form,setForm]=useState({nom:"",prenom:"",email:"",password:"",role:"TECHNICIEN"});
  function sauvegarder(){ajouterUtilisateur(form,()=>{setShowForm(false);setForm({nom:"",prenom:"",email:"",password:"",role:"TECHNICIEN"});});}
  return(
    <div>
      {codes&&(
        <div style={S.card}>
          <div style={S.cardTitle}>🔑 Codes d'invitation de {organisation?.nom||"votre organisation"}</div>
          <div style={{fontSize:13,color:"var(--muted-2)",marginBottom:16,lineHeight:1.6}}>Le code utilisé à l'inscription (« Rejoindre une organisation ») détermine le rôle de la personne. Pour nommer un administrateur, changez le rôle dans le tableau ci-dessous.</div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(240px,1fr))",gap:16}}>
            {[{role:"TECHNICIEN",titre:"🛠️ Code Technicien",aide:"À partager avec l'équipe de terrain",code:codes.technicien,c:"#00D4AA"},{role:"INGENIEUR",titre:"🔧 Code Ingénieur",aide:"À donner aux ingénieurs biomédicaux seulement",code:codes.ingenieur,c:"#60A5FA"}].map(k=>(
              <div key={k.role} style={{background:`${k.c}10`,border:`1px solid ${k.c}40`,borderRadius:12,padding:16}}>
                <div style={{fontSize:13,fontWeight:700,color:"var(--text)"}}>{k.titre}</div>
                <div style={{fontSize:11,color:"var(--muted)",marginBottom:10}}>{k.aide}</div>
                <div style={{fontSize:24,fontWeight:900,color:k.c,letterSpacing:"0.12em",userSelect:"all",marginBottom:10}}>{k.code}</div>
                <button style={{...S.btn("#64748B"),fontSize:11,padding:"4px 10px"}} onClick={()=>regenererCode(k.role)}>🔄 Régénérer</button>
              </div>
            ))}
          </div>
        </div>
      )}
      {erreurCodes&&<div style={{color:"#FF4D6D",fontSize:13,marginBottom:12}}>❌ {erreurCodes}</div>}
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:12,marginBottom:20}}>
        <button style={S.btn()} onClick={()=>setShowForm(true)}>+ Ajouter un utilisateur</button>
        <div style={{fontSize:12,color:"var(--muted-2)"}}>
          👑 Administrateurs : <strong style={{color:nbAdmins>=MAX_ADMINS?"#F59E0B":"var(--text)"}}>{nbAdmins} / {MAX_ADMINS}</strong> (le propriétaire + {MAX_ADMINS-1} adjoints maximum)
          {!jeSuisProprio&&<span> — seul le propriétaire peut nommer ou retirer un administrateur</span>}
        </div>
      </div>
      <div style={S.card}>
        <table style={S.tbl}>
          <thead><tr>{["Nom","Email","Rôle","Statut","Créé le","Actions"].map(h=><th key={h} style={S.th}>{h}</th>)}</tr></thead>
          <tbody>{utilisateurs.map(u=>(<tr key={u.id} style={{opacity:u.actif?1:0.5}}><td style={S.td}><div style={{fontWeight:600,color:"var(--text)"}}>{u.prenom} {u.nom}</div></td><td style={{...S.td,color:"var(--muted)"}}>{u.email}</td><td style={S.td}>{u.est_proprietaire?<span style={{...badge("ADMIN"),background:"rgba(245,158,11,0.15)",color:"#F59E0B",border:"1px solid rgba(245,158,11,0.35)"}}>👑 PROPRIÉTAIRE</span>
      :(u.actif===1&&(u.role!=="ADMIN"||jeSuisProprio))?<select value={u.role} onChange={e=>changerRole(u,e.target.value)} title="Changer le rôle" style={{...badge(u.role),cursor:"pointer",outline:"none",appearance:"auto"}}><option value="TECHNICIEN">TECHNICIEN</option><option value="INGENIEUR">INGENIEUR</option>{(jeSuisProprio||u.role==="ADMIN")&&<option value="ADMIN" disabled={u.role!=="ADMIN"&&nbAdmins>=MAX_ADMINS}>ADMIN{u.role==="ADMIN"?" (adjoint)":nbAdmins>=MAX_ADMINS?" — limite atteinte":""}</option>}</select>
      :<span style={badge(u.role)}>{u.role}{u.role==="ADMIN"?" (adjoint)":""}</span>}</td><td style={S.td}><span style={badge(u.actif?"En service":"En panne")}>{u.actif?"✅ Actif":"❌ Inactif"}</span></td><td style={{...S.td,color:"var(--muted-3)"}}>{u.createdAt?.split("T")[0]||u.createdAt}</td><td style={S.td}><div style={{display:"flex",gap:6}}>{jeSuisProprio&&u.role==="ADMIN"&&u.actif===1&&!u.est_proprietaire&&<button onClick={()=>transfererPropriete(u)} style={{background:"rgba(245,158,11,0.1)",color:"#F59E0B",border:"1px solid rgba(245,158,11,0.25)",padding:"5px 10px",borderRadius:6,cursor:"pointer",fontSize:11}}>👑 Transférer la propriété</button>}{u.id!==currentUserId&&u.actif===1&&!u.est_proprietaire&&(u.role!=="ADMIN"||jeSuisProprio)&&<button onClick={()=>desactiverUtilisateur(u.id)} style={{background:"rgba(255,77,109,0.1)",color:"#FF4D6D",border:"1px solid rgba(255,77,109,0.2)",padding:"5px 10px",borderRadius:6,cursor:"pointer",fontSize:11}}>🚫 Désactiver</button>}{u.actif===0&&(u.role!=="ADMIN"||jeSuisProprio)&&<button onClick={()=>reactiverUtilisateur(u.id)} style={{background:"rgba(0,212,170,0.1)",color:"#00D4AA",border:"1px solid rgba(0,212,170,0.2)",padding:"5px 10px",borderRadius:6,cursor:"pointer",fontSize:11}}>✅ Réactiver</button>}{u.id===currentUserId&&<span style={{fontSize:11,color:"var(--muted-3)",fontStyle:"italic"}}>Votre compte</span>}</div></td></tr>))}</tbody>
        </table>
      </div>
      {showForm&&(<div style={S.overlay}><div style={S.modal}><h3 style={{marginBottom:20,color:"var(--text)",fontSize:18}}>👤 Nouvel utilisateur</h3><div style={S.fgrid}><div><label style={S.lbl}>Nom *</label><input style={S.inp} placeholder="Nom de famille" value={form.nom} onChange={e=>setForm(p=>({...p,nom:e.target.value}))}/></div><div><label style={S.lbl}>Prénom</label><input style={S.inp} placeholder="Prénom" value={form.prenom} onChange={e=>setForm(p=>({...p,prenom:e.target.value}))}/></div><div><label style={S.lbl}>Email *</label><input style={S.inp} type="email" placeholder="email@hopital.dz" value={form.email} onChange={e=>setForm(p=>({...p,email:e.target.value}))}/></div><div><label style={S.lbl}>Mot de passe *</label><input style={S.inp} type="password" placeholder="Minimum 6 caractères" value={form.password} onChange={e=>setForm(p=>({...p,password:e.target.value}))}/></div><div><label style={S.lbl}>Rôle</label><select style={S.sel} value={form.role} onChange={e=>setForm(p=>({...p,role:e.target.value}))}><option value="TECHNICIEN">Technicien</option><option value="INGENIEUR">Ingénieur Biomédical</option>{jeSuisProprio&&<option value="ADMIN" disabled={nbAdmins>=MAX_ADMINS}>Administrateur adjoint{nbAdmins>=MAX_ADMINS?" (limite atteinte)":""}</option>}</select></div></div><div style={{display:"flex",gap:12,justifyContent:"flex-end"}}><button style={S.btnO} onClick={()=>setShowForm(false)}>Annuler</button><button style={S.btnSolid()} onClick={sauvegarder}>Créer</button></div></div></div>)}
    </div>
  );
});

// ════════════════════════════════════════════════════════════
// APP + PLATEFORME
// ════════════════════════════════════════════════════════════
export default function App(){
  const [user,setUser]=useState(null);
  const [token,setToken]=useState(null);
  const [organisation,setOrganisation]=useState(null);
  const [preferences,setPreferences]=useState({monitoring_actif:0,monitoring_equip_id:1});
  const [ecran,setEcran]=useState("connexion"); // "connexion" | "inscription"
  useEffect(()=>{
    const t=localStorage.getItem("token");const u=localStorage.getItem("user");
    const p=localStorage.getItem("preferences");const o=localStorage.getItem("organisation");
    if(t&&u){setToken(t);setUser(JSON.parse(u));setPreferences(p?JSON.parse(p):{monitoring_actif:0,monitoring_equip_id:1});setOrganisation(o?JSON.parse(o):null);}
  },[]);
  function gererConnexion(u,t,p,o){setUser(u);setToken(t);setPreferences(p);setOrganisation(o||null);}
  if(!user||!token){
    // Choix du thème disponible avant la connexion (coin supérieur droit)
    const choixTheme=(
      <div style={{position:"fixed",top:16,right:16,zIndex:50,background:"var(--panel-bg)",border:"1px solid var(--w06)",borderRadius:12,padding:"8px 12px 0",boxShadow:"var(--shadow)"}}>
        <SelecteurTheme/>
      </div>
    );
    if(ecran==="inscription") return <>{choixTheme}<PageInscription onLogin={gererConnexion} onRetourConnexion={()=>setEcran("connexion")}/></>;
    return <>{choixTheme}<PageConnexion onLogin={gererConnexion} onGoToInscription={()=>setEcran("inscription")}/></>;
  }
  return <Plateforme user={user} token={token} organisation={organisation} prefInitiales={preferences} onMajUtilisateur={u=>{setUser(u);localStorage.setItem("user",JSON.stringify(u));}} onLogout={()=>{localStorage.clear();setUser(null);setToken(null);setOrganisation(null);setEcran("connexion");}}/>;
}

function Plateforme({user,token,organisation,prefInitiales,onLogout,onMajUtilisateur}){
  const [onglet,setOnglet]=useState("dashboard");
  const [equipements,setEquipements]=useState([]);
  const [maintenances,setMaintenances]=useState([]);
  const [alertes,setAlertes]=useState([]);
  const [iotData,setIotData]=useState([]);
  const [utilisateurs,setUtilisateurs]=useState([]);
  const [chargement,setChargement]=useState(true);
  const [message,setMessage]=useState(null);
  const [monitoringActif,setMonitoringActif]=useState(prefInitiales?.monitoring_actif===1||prefInitiales?.monitoring_actif===true);
  const [iotEquipId,setIotEquipId]=useState(prefInitiales?.monitoring_equip_id||1);
  const iotTimerRef=useRef(null);
  const hdrs=useCallback(()=>({"Content-Type":"application/json","Authorization":`Bearer ${token}`}),[token]);

  useEffect(()=>{charger();},[]);

  // Rafraîchissement automatique : alertes et statut des équipements toutes les 10 s,
  // avec une notification quand une nouvelle alerte arrive (pas besoin d'appuyer sur F5)
  const alertesConnuesRef=useRef(null);
  const equipementsRef=useRef([]);
  useEffect(()=>{equipementsRef.current=Array.isArray(equipements)?equipements:[];},[equipements]);
  useEffect(()=>{if(Array.isArray(alertes)&&alertesConnuesRef.current===null&&!chargement) alertesConnuesRef.current=new Set(alertes.map(a=>a.id));},[alertes,chargement]);
  useEffect(()=>{
    const id=setInterval(rafraichirEnDirect,10000);
    return()=>clearInterval(id);
  },[]);
  async function rafraichirEnDirect(){
    try{
      const h=hdrs();
      const [ra,re]=await Promise.all([fetch(`${API}/alertes`,{headers:h}),fetch(`${API}/equipements`,{headers:h})]);
      if(!ra.ok||!re.ok) return;
      const liste=await ra.json(),eqs=await re.json();
      if(!Array.isArray(liste)||!Array.isArray(eqs)) return;
      const connues=alertesConnuesRef.current;
      if(connues){
        const nouvelles=liste.filter(a=>!connues.has(a.id));
        if(nouvelles.length>0){
          const a=nouvelles[0];
          const nom=eqs.find(e=>e.id===a.equipement_id)?.nom||`Équipement #${a.equipement_id}`;
          const icone=a.severite==="CRITIQUE"?"🔴":a.severite==="INFO"?"✅":"🟡";
          toast(`${icone} Nouvelle alerte : ${String(a.type||"").replace(/_/g," ")} — ${nom}${nouvelles.length>1?` (+${nouvelles.length-1})`:""}`,a.severite==="CRITIQUE"?"e":"s");
        }
      }
      alertesConnuesRef.current=new Set(liste.map(a=>a.id));
      setAlertes(liste);
      setEquipements(eqs);
    }catch{}
  }
  // Si l'équipement mémorisé pour le monitoring n'appartient pas à cette organisation
  // (ex. nouveau compte, ou équipement supprimé), on sélectionne le premier de la liste.
  useEffect(()=>{
    if(!Array.isArray(equipements)||equipements.length===0) return;
    if(!equipements.some(e=>e.id===iotEquipId)) changerEquipMonitoring(equipements[0].id);
  },[equipements]);
  useEffect(()=>{clearInterval(iotTimerRef.current);if(monitoringActif){chargerIot(iotEquipId);iotTimerRef.current=setInterval(()=>chargerIot(iotEquipId),5000);}return()=>clearInterval(iotTimerRef.current);},[monitoringActif,iotEquipId]);

  async function charger(){
    try{setChargement(true);const h=hdrs();const [r1,r2,r3]=await Promise.all([fetch(`${API}/equipements`,{headers:h}),fetch(`${API}/maintenances`,{headers:h}),fetch(`${API}/alertes`,{headers:h})]);if(r1.status===401){onLogout();return;}try{const rm=await fetch(`${API}/moi`,{headers:h});if(rm.ok){const moi=await rm.json();if(moi.role&&moi.role!==user.role){onMajUtilisateur({...user,role:moi.role});toast(`ℹ️ Votre rôle a été modifié : ${moi.role}`);}}}catch{}setEquipements(await r1.json());setMaintenances(await r2.json());setAlertes(await r3.json());if(user.role==="ADMIN"){const r4=await fetch(`${API}/utilisateurs`,{headers:h});setUtilisateurs(await r4.json());}}catch{toast("❌ Serveur inaccessible","e");}finally{setChargement(false);}
  }
  async function chargerIot(id){try{const r=await fetch(`${API}/capteurs/${id}`,{headers:hdrs()});if(r.ok){const d=await r.json();if(Array.isArray(d))setIotData(d.reverse());}}catch{}}
  function toast(t,type="s"){setMessage({t,type});setTimeout(()=>setMessage(null),3500);}
  async function toggleMonitoring(){const n=!monitoringActif;setMonitoringActif(n);const p={monitoring_actif:n?1:0,monitoring_equip_id:iotEquipId};localStorage.setItem("preferences",JSON.stringify(p));try{await fetch(`${API}/preferences/monitoring`,{method:"POST",headers:hdrs(),body:JSON.stringify(p)});}catch{}toast(n?"▶️ Monitoring activé":"⏹️ Monitoring désactivé");}
  async function changerEquipMonitoring(id){setIotEquipId(id);const p={monitoring_actif:monitoringActif?1:0,monitoring_equip_id:id};localStorage.setItem("preferences",JSON.stringify(p));try{await fetch(`${API}/preferences/monitoring`,{method:"POST",headers:hdrs(),body:JSON.stringify(p)});}catch{}}
  async function supprimerEquipement(id){if(!window.confirm("⚠️ Attention : supprimer cet équipement supprimera aussi définitivement toutes ses maintenances, alertes et données IoT associées.\n\nConfirmer la suppression ?")) return;const rs=await fetch(`${API}/equipements/${id}`,{method:"DELETE",headers:hdrs()});if(!rs.ok){const e=await rs.json().catch(()=>({}));toast("❌ "+(e.erreur||"Suppression impossible"),"e");return;}setEquipements(p=>p.filter(e=>e.id!==id));toast("✅ Équipement supprimé.");}
  async function ajouterMaintenance(form,onSuccess){if(!form.equipementId||!form.datePlanifiee){toast("⚠️ Équipement et date obligatoires.","e");return;}const eq=equipements.find(e=>e.id===parseInt(form.equipementId));try{const r=await fetch(`${API}/maintenances`,{method:"POST",headers:hdrs(),body:JSON.stringify({...form,equipementId:parseInt(form.equipementId),equipementNom:eq?.nom})});const m=await r.json();if(!r.ok){toast("❌ "+(m.erreur||"Erreur"),"e");return;}setMaintenances(p=>[m,...p]);onSuccess();toast("✅ Maintenance planifiée !");rafraichirEnDirect();}catch{toast("❌ Erreur","e");}}
  async function changerStatutMaintenance(m,statut){
    if(statut==="Terminée"&&!window.confirm(`Marquer la maintenance de « ${m.equipementNom} » comme terminée ?\n\nL'équipement repassera « En service » et son score de risque sera recalculé (les pannes et anomalies antérieures ne compteront plus).`)) return;
    try{
      const r=await fetch(`${API}/maintenances/${m.id}/statut`,{method:"PATCH",headers:hdrs(),body:JSON.stringify({statut})});
      const d=await r.json();
      if(!r.ok){toast("❌ "+(d.erreur||"Erreur"),"e");return;}
      setMaintenances(p=>p.map(x=>x.id===m.id?d.maintenance:x));
      if(d.equipement) setEquipements(p=>p.map(e=>e.id===d.equipement.id?{...e,statut:d.equipement.statut,scoreRisque:d.equipement.scoreRisque}:e));
      toast(statut==="Terminée"?`✅ Maintenance terminée — risque de ${m.equipementNom} : ${d.equipement?.scoreRisque??0}%`:"▶️ Maintenance démarrée — équipement « En maintenance »");
    }catch{toast("❌ Erreur réseau","e");}
  }
  async function ajouterUtilisateur(form,onSuccess){if(!form.nom||!form.email||!form.password){toast("⚠️ Champs obligatoires.","e");return;}try{const r=await fetch(`${API}/utilisateurs`,{method:"POST",headers:hdrs(),body:JSON.stringify(form)});if(!r.ok){const e=await r.json();toast("❌ "+e.erreur,"e");return;}onSuccess();charger();toast("✅ Utilisateur créé !");}catch{toast("❌ Erreur","e");}}
  async function desactiverUtilisateur(id){if(!window.confirm("Désactiver ?")) return;const r=await fetch(`${API}/utilisateurs/${id}/desactiver`,{method:"PATCH",headers:hdrs()});if(!r.ok){const e=await r.json().catch(()=>({}));toast("❌ "+(e.erreur||"Erreur"),"e");return;}charger();toast("✅ Désactivé.");}
  async function changerRole(u,role){if(role===u.role) return;if(!window.confirm(`Changer le rôle de ${u.prenom||""} ${u.nom} : ${u.role} → ${role} ?`)) return;const r=await fetch(`${API}/utilisateurs/${u.id}/role`,{method:"PATCH",headers:hdrs(),body:JSON.stringify({role})});const d=await r.json().catch(()=>({}));if(!r.ok){toast("❌ "+(d.erreur||"Erreur"),"e");charger();return;}setUtilisateurs(p=>p.map(x=>x.id===u.id?{...x,role}:x));toast(`✅ Rôle modifié : ${role}`);if(u.id===user.id){onMajUtilisateur({...user,role});}}
  async function transfererPropriete(u){if(!window.confirm(`Transférer la propriété de l'organisation à ${u.prenom||""} ${u.nom} ?\n\nIl deviendra le propriétaire : lui seul pourra ensuite nommer ou retirer les administrateurs. Vous resterez administrateur adjoint.`)) return;const r=await fetch(`${API}/organisation/proprietaire`,{method:"POST",headers:hdrs(),body:JSON.stringify({utilisateur_id:u.id})});const d=await r.json().catch(()=>({}));if(!r.ok){toast("❌ "+(d.erreur||"Erreur"),"e");return;}charger();toast(`👑 ${u.prenom||""} ${u.nom} est maintenant propriétaire`);}
  async function reactiverUtilisateur(id){if(!window.confirm("Réactiver ?")) return;const rr=await fetch(`${API}/utilisateurs/${id}/reactiver`,{method:"PATCH",headers:hdrs()});if(!rr.ok){const e=await rr.json().catch(()=>({}));toast("❌ "+(e.erreur||"Erreur"),"e");return;}charger();toast("✅ Réactivé !");}
  async function lireAlerte(id){await fetch(`${API}/alertes/${id}/lire`,{method:"PATCH",headers:hdrs()});setAlertes(p=>p.map(a=>a.id===id?{...a,estLue:1}:a));}

  function exportPDF(){
    const doc=new jsPDF();const now=new Date().toLocaleDateString("fr-FR");
    const total=equipements.length,serv=equipements.filter(e=>e.statut==="En service").length;
    const maint=equipements.filter(e=>e.statut==="En maintenance").length,panne=equipements.filter(e=>e.statut==="En panne").length;
    const dispo=total>0?Math.round(serv/total*100):0,crit=equipements.filter(e=>e.scoreRisque>=75).length;
    doc.setFillColor(2,11,24);doc.rect(0,0,210,35,"F");
    doc.setTextColor(255,255,255);doc.setFontSize(18);doc.setFont("helvetica","bold");
    doc.text("Rapport Parc Biomedical",14,15);
    doc.setFontSize(10);doc.setFont("helvetica","normal");
    doc.text(`Genere le ${now} par ${user.prenom} ${user.nom}`,14,25);
    doc.setTextColor(2,11,24);doc.setFontSize(13);doc.setFont("helvetica","bold");
    doc.text("Indicateurs cles",14,48);
    autoTable(doc,{startY:53,head:[["Indicateur","Valeur"]],body:[["Total",total],["En service",serv],["En maintenance",maint],["En panne",panne],["Disponibilite",dispo+"%"],["Risque critique",crit]],theme:"grid",headStyles:{fillColor:[0,40,30],textColor:255}});
    doc.text("Equipements",14,doc.lastAutoTable.finalY+12);
    autoTable(doc,{startY:doc.lastAutoTable.finalY+17,head:[["Nom","Marque","N Serie","Service","Statut","Risque"]],body:equipements.map(e=>[e.nom,e.marque||"-",e.numeroSerie,e.service||"-",e.statut,e.scoreRisque+"%"]),theme:"striped",headStyles:{fillColor:[0,40,30],textColor:255},styles:{fontSize:9}});
    doc.save(`rapport_biomedical_${now.replace(/\//g,"-")}.pdf`);
    toast("✅ PDF exporté !");
  }

  const total=equipements.length,serv=equipements.filter(e=>e.statut==="En service").length;
  const panne=equipements.filter(e=>e.statut==="En panne").length,maint=equipements.filter(e=>e.statut==="En maintenance").length;
  const dispo=total>0?Math.round(serv/total*100):0,crit=equipements.filter(e=>e.scoreRisque>=75).length;
  const alertesNonLues=alertes.filter(a=>!a.estLue).length;
  const pieStatuts=[{name:"En service",value:serv},{name:"En maintenance",value:maint},{name:"En panne",value:panne}].filter(d=>d.value>0);
  const barServices=Object.entries(equipements.reduce((a,e)=>{const s=e.service||"Autre";a[s]=(a[s]||0)+1;return a},{})).map(([service,count])=>({service,count}));
  const pieMaint=[{name:"Planifiée",value:maintenances.filter(m=>m.statut==="Planifiée").length},{name:"En cours",value:maintenances.filter(m=>m.statut==="En cours").length},{name:"Terminée",value:maintenances.filter(m=>m.statut==="Terminée").length}].filter(d=>d.value>0);
  const estAdmin=user.role==="ADMIN",peutModifier=user.role==="ADMIN"||user.role==="INGENIEUR";
  const estModeOrganisation=organisation?.type==="ORGANISATION";

  const nav=[
    {id:"dashboard",icon:"📊",label:"Tableau de bord"},
    {id:"equipements",icon:"🏥",label:"Équipements"},
    {id:"maintenances",icon:"🔧",label:"Maintenances"},
    {id:"calendrier",icon:"📅",label:"Calendrier"},
    {id:"iot",icon:"📡",label:`IoT ${monitoringActif?"● Actif":"○ Inactif"}`},
    {id:"ia",icon:"🤖",label:"Intelligence IA"},
    {id:"alertes",icon:"🔔",label:`Alertes${alertesNonLues>0?` (${alertesNonLues})`:""}`,badge:alertesNonLues>0},
    ...(estAdmin&&estModeOrganisation?[{id:"utilisateurs",icon:"👥",label:"Utilisateurs"}]:[]),
  ];

  const titres={
    dashboard:{title:"Tableau de bord",sub:"Vue d'ensemble du parc biomédical"},
    equipements:{title:"Parc d'équipements",sub:`${total} équipements enregistrés`},
    maintenances:{title:"Gestion des maintenances",sub:`${maintenances.length} interventions`},
    calendrier:{title:"Calendrier de maintenance",sub:"Planning visuel"},
    iot:{title:"Surveillance IoT",sub:monitoringActif?"● Monitoring actif":"○ Monitoring inactif"},
    ia:{title:"Intelligence Artificielle",sub:"Prédiction de pannes & Détection d'anomalies"},
    alertes:{title:"Alertes & Risques",sub:`${alertesNonLues} alerte(s) non lue(s)`},
    utilisateurs:{title:"Gestion des utilisateurs",sub:`${utilisateurs.length} utilisateurs`},
  };

  if(chargement) return(
    <div style={{display:"flex",alignItems:"center",justifyContent:"center",height:"100vh",flexDirection:"column",gap:16,fontFamily:"Segoe UI",position:"relative"}}>
      <AnimatedBackground/>
      <div style={{position:"relative",zIndex:1,textAlign:"center"}}>
        <div style={{fontSize:56,marginBottom:16,filter:"drop-shadow(0 0 20px rgba(0,212,170,0.5))"}}>🏥</div>
        <div style={{fontSize:20,fontWeight:800,color:"var(--text)",letterSpacing:"-0.02em"}}>Chargement...</div>
        <div style={{fontSize:13,color:"var(--muted-3)",marginTop:8}}>Connexion à la base de données</div>
      </div>
    </div>
  );

  return(
    <div style={{...S.app,position:"relative"}}>
      <AnimatedBackground/>
      {message&&<div style={S.toast(message.type)}>{message.t}</div>}
      <div style={S.sidebar}>
        <div style={S.sidebarTop}>
          <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:4}}>
            <span style={{fontSize:22}}>🏥</span>
            <div><div style={S.sidebarTitle}>BioMed Plateforme</div><div style={S.sidebarSub}>{organisation?.nom||"Gestion Biomédicale"}</div></div>
          </div>
        </div>
        <div style={{padding:"14px 20px",borderBottom:"1px solid rgba(0,212,170,0.08)",background:"rgba(0,212,170,0.02)"}}>
          <div style={{fontSize:13,fontWeight:700,color:"var(--text)"}}>{user.prenom} {user.nom}</div>
          <div style={{marginTop:5}}><span style={badge(user.role)}>{user.role}</span></div>
        </div>
        <nav style={{flex:1,paddingTop:8,overflowY:"auto"}}>
          {nav.map(item=>(
            <div key={item.id} style={S.nav(onglet===item.id)} onClick={()=>setOnglet(item.id)}>
              <span>{item.icon}</span>
              <span style={{flex:1,fontSize:13}}>{item.label}</span>
              {item.badge&&<span style={{background:"#FF4D6D",color:"white",borderRadius:"999px",fontSize:10,padding:"1px 6px",fontWeight:700}}>{alertesNonLues}</span>}
            </div>
          ))}
        </nav>
        <div style={{padding:"12px 20px",borderTop:"1px solid rgba(0,212,170,0.08)"}}>
          <SelecteurTheme/>
          <button onClick={onLogout} style={{width:"100%",background:"var(--w03)",color:"var(--muted)",border:"1px solid var(--w06)",padding:"9px",borderRadius:8,cursor:"pointer",fontSize:13,display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>🚪 Se déconnecter</button>
          <div style={{fontSize:9,color:"var(--muted-4)",textAlign:"center",marginTop:8,letterSpacing:"0.05em"}}>v9.0.0 ✅ IA INTÉGRÉE</div>
        </div>
      </div>
      <div style={S.main}>
        <div style={S.title}>{titres[onglet]?.title}</div>
        <div style={S.sub}>{titres[onglet]?.sub}</div>
        {onglet==="dashboard"&&<Dashboard equipements={equipements} maintenances={maintenances} pieStatuts={pieStatuts} barServices={barServices} pieMaint={pieMaint} total={total} serv={serv} maint={maint} panne={panne} dispo={dispo} crit={crit} exportPDF={exportPDF} setOnglet={setOnglet}/>}
        {onglet==="equipements"&&<Equipements equipements={equipements} peutModifier={peutModifier} supprimerEquipement={supprimerEquipement} changerEquipMonitoring={changerEquipMonitoring} setOnglet={setOnglet} token={token} charger={charger}/>}
        {onglet==="maintenances"&&<Maintenances maintenances={maintenances} equipements={equipements} ajouterMaintenance={ajouterMaintenance} changerStatutMaintenance={changerStatutMaintenance}/>}
        {onglet==="calendrier"&&<Calendrier maintenances={maintenances}/>}
        {onglet==="iot"&&<IoT equipements={equipements} iotData={iotData} iotEquipId={iotEquipId} monitoringActif={monitoringActif} toggleMonitoring={toggleMonitoring} changerEquipMonitoring={changerEquipMonitoring} token={token} peutModifier={peutModifier}/>}
        {onglet==="ia"&&<ModuleIA equipements={equipements} token={token} setOnglet={setOnglet}/>}
        {onglet==="alertes"&&<Alertes alertes={alertes} equipements={equipements} lireAlerte={lireAlerte} setOnglet={setOnglet}/>}
        {onglet==="utilisateurs"&&estAdmin&&estModeOrganisation&&<Utilisateurs utilisateurs={utilisateurs} currentUserId={user.id} desactiverUtilisateur={desactiverUtilisateur} reactiverUtilisateur={reactiverUtilisateur} ajouterUtilisateur={ajouterUtilisateur} organisation={organisation} changerRole={changerRole} token={token} transfererPropriete={transfererPropriete}/>}
      </div>
    </div>
  );
}
