import {
  chargerPrevision, resumer, prochainePluie, rechercherLieu, nomDuLieu,
  niveauDepuisTaux, rangNiveau, LIBELLES,
} from './meteo.js';
import { Radar, formatDuree } from './radar.js';
import { prevoirParRadar, fusionner } from './nowcast.js';

const $ = (s) => document.querySelector(s);
// Dans l'APK Android (Capacitor), on passe par les modules natifs pour la position et les notifications.
const NATIF = !!window.Capacitor?.isNativePlatform?.();
const PLUGINS = window.Capacitor?.Plugins || {};
const RAFRAICHISSEMENT = 10 * 60000;

// ---------- stockage local (peut être indisponible : on ne compte pas dessus) ----------
const stock = {
  lire(cle, defaut) {
    try {
      const v = localStorage.getItem(cle);
      return v == null ? defaut : JSON.parse(v);
    } catch {
      return defaut;
    }
  },
  ecrire(cle, valeur) {
    try {
      localStorage.setItem(cle, JSON.stringify(valeur));
    } catch { /* stockage indisponible */ }
  },
};

const etat = {
  lieu: stock.lire('lieu', null),
  prevision: stock.lire('derniere-prevision', null),
  periode: stock.lire('periode', 2),
  alerte: stock.lire('alerte', { active: false, seuil: 'faible', avance: 30 }),
  programmees: stock.lire('programmees', [
    { nom: 'Matin', heure: '07:00', jours: ['lun', 'mar', 'mer', 'jeu', 'ven'], horizon_heures: 12, seuil: 'faible', si_sec: true },
  ]),
  derniereNotif: stock.lire('derniere-notif', null),
};

const heureCourte = (t) => new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }).replace(':', 'h');
const mm = (v) => (v > 0 && v < 0.05 ? '< 0,1 mm' : `${v.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} mm`);

function jourRelatif(t) {
  const d = new Date(t);
  const auj = new Date();
  const demain = new Date();
  demain.setDate(auj.getDate() + 1);
  if (d.toDateString() === auj.toDateString()) return '';
  if (d.toDateString() === demain.toDateString()) return 'demain ';
  return d.toLocaleDateString('fr-FR', { weekday: 'long' }) + ' ';
}

// ---------- onglets ----------
let radar = null;
document.querySelectorAll('.onglets button').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.onglets button').forEach((x) => x.classList.toggle('actif', x === b));
    document.querySelectorAll('.vue').forEach((v) => v.classList.toggle('active', v.id === b.dataset.vue));
    if (b.dataset.vue === 'vue-radar') ouvrirRadar();
    else radar?.pause();
  });
});

function ouvrirRadar() {
  if (!radar) {
    radar = new Radar($('#carte'), {
      lecture: $('#radar-lecture'),
      curseur: $('#radar-curseur'),
      libelle: $('#radar-libelle'),
      type: $('#radar-type'),
      etat: $('#radar-etat'),
    });
    if (etat.lieu) radar.placer(etat.lieu.lat, etat.lieu.lon);
    radar.definirNowcast(etat.nowcast);
  }
  requestAnimationFrame(() => {
    radar.redimensionner();
    radar.charger().catch((e) => ($('#radar-etat').textContent = e.message));
  });
}

// ---------- lieu ----------
const dialogue = $('#dialogue-lieu');
$('#btn-lieu').addEventListener('click', () => dialogue.showModal());

function definirLieu(lieu) {
  etat.lieu = lieu;
  stock.ecrire('lieu', lieu);
  $('#nom-lieu').textContent = lieu.nom;
  if (radar) {
    radar.placer(lieu.lat, lieu.lon);
    if ($('#vue-radar').classList.contains('active')) radar.charger();
  }
  actualiser();
}

function obtenirPosition() {
  const options = { enableHighAccuracy: false, timeout: 15000, maximumAge: 5 * 60000 };
  if (NATIF && PLUGINS.Geolocation) return PLUGINS.Geolocation.getCurrentPosition(options).then((p) => p.coords);
  if (!navigator.geolocation) return Promise.reject(new Error('indisponible'));
  return new Promise((ok, ko) => navigator.geolocation.getCurrentPosition((p) => ok(p.coords), ko, options));
}

$('#btn-gps').addEventListener('click', async () => {
  const info = $('#dialogue-etat');
  info.textContent = 'Recherche de ta position…';
  try {
    const { latitude: lat, longitude: lon } = await obtenirPosition();
    const nom = (await nomDuLieu(lat, lon)) || 'Ma position';
    info.textContent = '';
    dialogue.close();
    definirLieu({ nom, lat, lon, gps: true });
  } catch (err) {
    const refus = err?.code === 1 || /denied|permission|refus/i.test(err?.message || '');
    info.textContent = refus
      ? `Accès à la position refusé. Autorise-le dans les réglages ${NATIF ? 'du téléphone (Applis → Pluie en vue → Autorisations)' : 'du navigateur'}, ou cherche une ville.`
      : err?.message === 'indisponible'
        ? 'La géolocalisation n\'est pas disponible sur cet appareil.'
        : 'Position introuvable pour le moment. Vérifie que la localisation est activée, ou cherche une ville.';
  }
});

let minuterieRecherche;
$('#recherche-lieu').addEventListener('input', (e) => {
  clearTimeout(minuterieRecherche);
  const texte = e.target.value.trim();
  const liste = $('#resultats-lieu');
  if (texte.length < 2) {
    liste.innerHTML = '';
    return;
  }
  minuterieRecherche = setTimeout(async () => {
    try {
      const res = await rechercherLieu(texte);
      liste.innerHTML = '';
      if (!res.length) liste.innerHTML = '<li class="vide">Aucun résultat</li>';
      for (const r of res) {
        const li = document.createElement('li');
        const b = document.createElement('button');
        b.type = 'button';
        b.innerHTML = `<b></b><small></small>`;
        b.querySelector('b').textContent = r.nom;
        b.querySelector('small').textContent = r.detail;
        b.addEventListener('click', () => {
          dialogue.close();
          $('#recherche-lieu').value = '';
          liste.innerHTML = '';
          definirLieu({ nom: r.nom, lat: r.lat, lon: r.lon });
        });
        li.appendChild(b);
        liste.appendChild(li);
      }
    } catch (err) {
      $('#dialogue-etat').textContent = err.message;
    }
  }, 300);
});

// ---------- prévisions ----------
async function actualiser() {
  if (!etat.lieu) {
    $('#bandeau-titre').textContent = 'Choisis un lieu pour commencer';
    $('#bandeau-detail').textContent = 'Touche le bouton en haut à droite.';
    return;
  }
  try {
    const { lat, lon } = etat.lieu;
    const [prev, nc] = await Promise.all([
      chargerPrevision(lat, lon),
      prevoirParRadar(lat, lon).catch((e) => {
        console.warn('Radar :', e.message);
        return null;
      }),
    ]);
    // les 2 premières heures s'appuient sur le radar observé, le modèle prend le relais ensuite
    prev.quartModele = prev.quart;
    prev.quart = fusionner(prev.quart, nc);
    prev.radar = nc ? { t0: nc.t0, observe: nc.observeMaintenant, vitesse: nc.vitesseKmH, fiable: nc.fiable } : null;
    etat.prevision = prev;
    etat.nowcast = nc;
    radar?.definirNowcast(nc);
    const { quartModele, ...aGarder } = prev;
    stock.ecrire('derniere-prevision', aGarder);
    afficher();
    verifierAlerte();
  } catch (err) {
    if (etat.prevision) afficher();
    $('#maj').textContent = `Mise à jour impossible (${err.message}).` +
      (etat.prevision ? ` Données du ${new Date(etat.prevision.recu).toLocaleString('fr-FR')}.` : '');
  }
}

function afficher() {
  const prev = etat.prevision;
  if (!prev) return;
  const maintenant = Date.now();

  // bandeau : ce qui arrive dans l'heure
  const proche = prochainePluie(prev, 'faible', maintenant, 2);
  const bandeau = $('#bandeau');
  if (proche && proche.debut - maintenant <= 60 * 60000) {
    bandeau.dataset.niveau = proche.niveau;
    $('#bandeau-titre').textContent = proche.enCours
      ? `Pluie ${LIBELLES[proche.niveau]} en ce moment`
      : `Pluie ${LIBELLES[proche.niveau]} dans ${formatDuree(proche.dansMinutes)}`;
    $('#bandeau-detail').textContent =
      `${proche.enCours ? 'Jusqu\'à' : `Vers ${heureCourte(proche.debut)}, jusqu'à`} ${heureCourte(proche.fin)} environ · ${mm(proche.total)} au total`;
  } else {
    bandeau.dataset.niveau = 'sec';
    const suite = prochainePluie(prev, 'faible', maintenant, 24);
    const h = resumer(prev, 24, maintenant);
    $('#bandeau-titre').textContent = 'Pas de pluie dans l\'heure';
    $('#bandeau-detail').textContent = suite
      ? `Prochaine pluie vers ${jourRelatif(suite.debut)}${heureCourte(suite.debut)}`
      : h.debut
        ? `Prochaine pluie vers ${jourRelatif(h.debut)}${heureCourte(h.debut)}`
        : 'Rien de prévu sur les 24 prochaines heures';
  }
  $('#bandeau-icone').innerHTML = iconeMeteo(bandeau.dataset.niveau);
  dessinerRuban(prev, maintenant);
  // d'où vient l'information
  const source = $('#bandeau-source');
  if (prev.radar) {
    const r = prev.radar;
    const vu = niveauDepuisTaux(r.observe);
    source.textContent = `Radar de ${heureCourte(r.t0)} : ${vu === 'sec' ? 'pas de pluie détectée ici' : `pluie ${LIBELLES[vu]} détectée ici`}` +
      (r.fiable && r.vitesse ? ` · averses en mouvement à ~${r.vitesse} km/h` : '');
  } else {
    source.textContent = 'Radar indisponible : prévision du modèle uniquement';
  }

  dessinerGraphique();
  const age = Math.round((maintenant - prev.recu) / 60000);
  $('#maj').innerHTML = `Mis à jour ${age < 1 ? 'à l\'instant' : `il y a ${formatDuree(age)}`} · <u>actualiser</u><br>Radar RainViewer · Modèles Météo-France AROME/ARPEGE via Open-Meteo`;
}

// ---------- bandeau : icône et ruban des 2 prochaines heures ----------
function iconeMeteo(niveau) {
  const gouttes = { sec: 0, faible: 1, moderee: 2, forte: 3 }[niveau] ?? 0;
  const x = [[24], [18, 30], [14, 24, 34]][gouttes - 1] || [];
  const nuage = '<path d="M14 30a8 8 0 0 1 1-15.9A11 11 0 0 1 36 15a7.5 7.5 0 0 1 .5 15z" fill="currentColor"/>';
  const soleil = gouttes ? '' : '<circle cx="34" cy="13" r="6" fill="#fde68a"/>';
  const traits = x.map((cx) => `<path d="M${cx} 34l-3 7" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>`).join('');
  return `<svg viewBox="0 0 48 48">${soleil}${nuage}${traits}</svg>`;
}

function dessinerRuban(prev, maintenant) {
  const zone = $('#ruban');
  const fin = maintenant + 2 * 3600000;
  const pas = prev.quart.filter((p) => p.fin > maintenant && p.debut < fin && p.mm != null);
  if (!pas.length) {
    zone.innerHTML = '';
    return;
  }
  const L = 300, H = 46, bas = 14;
  const x = (t) => ((Math.max(t, maintenant) - maintenant) / (fin - maintenant)) * L;
  const max = Math.max(3, ...pas.map((p) => p.taux || 0));
  let svg = `<svg viewBox="0 0 ${L} ${H}" preserveAspectRatio="none" role="img" aria-label="Intensité de pluie, 2 prochaines heures">`;
  svg += `<line x1="0" x2="${L}" y1="${H - bas}" y2="${H - bas}" class="ruban-base"/>`;
  for (const p of pas) {
    const niveau = niveauDepuisTaux(p.taux);
    if (niveau === 'sec') continue;
    const h = Math.max(4, ((p.taux || 0) / max) * (H - bas - 4));
    const x0 = x(p.debut) + 1, l = Math.max(2, x(Math.min(p.fin, fin)) - x(p.debut) - 2);
    svg += `<rect x="${x0}" y="${H - bas - h}" width="${l}" height="${h}" rx="2" class="ruban-barre" data-niveau="${niveau}"/>`;
  }
  svg += '</svg>';
  const reperes = ['maint.', '30 min', '1 h', '1 h 30', '2 h'];
  zone.innerHTML = svg + `<div class="ruban-reperes">${reperes.map((r) => `<span>${r}</span>`).join('')}</div>`;
}

// ---------- graphique ----------
// Graduations et précision selon la durée choisie : plus la durée est courte, plus le détail est fin.
const GRADUATION_MIN = { 1: 15, 2: 30, 4: 60, 6: 60, 12: 120, 24: 180 };

function choisirPeriode(h) {
  etat.periode = h;
  stock.ecrire('periode', h);
  document.querySelectorAll('.selecteur button').forEach((b) => {
    const actif = +b.dataset.periode === h;
    b.classList.toggle('actif', actif);
    b.setAttribute('aria-checked', String(actif));
  });
  dessinerGraphique();
}

document.querySelectorAll('.selecteur button').forEach((b) =>
  b.addEventListener('click', () => choisirPeriode(+b.dataset.periode))
);

// Meilleure donnée disponible sur la fenêtre : quart d'heure tant qu'il existe, puis horaire.
function seriePrecise(prev, debut, fin) {
  const quarts = prev.quart.filter((p) => p.fin > debut && p.debut < fin && p.mm != null);
  const couverture = quarts.length ? quarts[quarts.length - 1].fin : debut;
  const heures = prev.heure.filter((p) => p.fin > couverture && p.debut < fin && p.mm != null);
  return [...quarts, ...heures]
    .map((p) => {
      const d = Math.max(p.debut, debut, p.duree === 60 ? couverture : 0);
      const f = Math.min(p.fin, fin);
      return { debut: d, fin: f, mm: (p.mm * (f - d)) / (p.fin - p.debut), taux: p.taux, duree: p.duree };
    })
    .filter((p) => p.fin > p.debut);
}

const arrondi1 = (v) => Math.round(v * 10) / 10;

function dessinerGraphique() {
  const prev = etat.prevision;
  const zone = $('#graphique');
  if (!prev) return;
  const h = etat.periode;
  document.querySelectorAll('.selecteur button').forEach((b) => {
    const actif = +b.dataset.periode === h;
    b.classList.toggle('actif', actif);
    b.setAttribute('aria-checked', String(actif));
  });
  const maintenant = Date.now();
  const finFenetre = maintenant + h * 3600000;
  const serie = seriePrecise(prev, maintenant, finFenetre);
  if (!serie.length) {
    zone.innerHTML = '<p class="vide">Pas de données pour cette période</p>';
    $('#resume-periode').textContent = '';
    return;
  }

  // précision affichée
  const finQuarts = serie.filter((p) => p.duree === 15).reduce((m, p) => Math.max(m, p.fin), 0);
  $('#precision').textContent = (prev.radar ? 'radar 2 h + modèle · ' : '') + (finQuarts >= finFenetre - 60000
    ? 'détail ¼ h'
    : finQuarts > maintenant ? `¼ h jusqu'à ${heureCourte(finQuarts)}, puis horaire` : 'détail horaire');

  // résumé
  const r = resumer(prev, h, maintenant);
  $('#resume-periode').innerHTML = r.niveau === 'sec'
    ? `<b>Pas de pluie</b> prévue sur les ${h} prochaines heures.`
    : `<b>${mm(r.total)}</b> sur ${h} h · pluie ${LIBELLES[r.niveau]} ${r.debut - maintenant < 120000 ? 'en cours' : `dès ${heureCourte(r.debut)}`}, jusqu'à ${heureCourte(r.fin)} · pic ${arrondi1(r.tauxMax).toLocaleString('fr-FR')} mm/h`;

  // géométrie
  const L = 340, H = 180, bas = 22, haut = 20, gauche = 30, droite = 34;
  const largeurUtile = L - gauche - droite;
  const x = (t) => gauche + ((t - maintenant) / (finFenetre - maintenant)) * largeurUtile;
  const base = H - bas;
  const tauxMax = Math.max(4, ...serie.map((p) => p.taux || 0));
  const yTaux = (v) => base - (v / tauxMax) * (base - haut);
  let cumul = 0;
  const points = [[x(maintenant), 0]];
  for (const p of serie) {
    cumul += p.mm;
    points.push([x(p.fin), cumul]);
  }
  const cumulMax = Math.max(1, Math.ceil(cumul));
  const yCumul = (v) => base - (v / cumulMax) * (base - haut);

  let svg = `<svg viewBox="0 0 ${L} ${H}" role="img" aria-label="Pluie prévue sur ${h} heures">`;
  // axes horizontaux (intensité à gauche, cumul à droite)
  for (const f of [0, 0.5, 1]) {
    const y = base - f * (base - haut);
    svg += `<line x1="${gauche}" x2="${L - droite}" y1="${y}" y2="${y}" class="grille"/>`;
    svg += `<text x="${gauche - 4}" y="${y + 3}" class="axe" text-anchor="end">${arrondi1(tauxMax * f).toLocaleString('fr-FR')}</text>`;
    svg += `<text x="${L - droite + 4}" y="${y + 3}" class="axe axe-cumul">${arrondi1(cumulMax * f).toLocaleString('fr-FR')}</text>`;
  }
  svg += `<text x="${gauche - 4}" y="10" class="axe" text-anchor="end">mm/h</text>`;
  svg += `<text x="${L - droite + 4}" y="10" class="axe axe-cumul">mm</text>`;

  // graduations de temps alignées sur l'horloge
  const pas = GRADUATION_MIN[h] * 60000;
  const decalage = new Date(maintenant).getTimezoneOffset() * 60000;
  let t = Math.ceil((maintenant - decalage) / pas) * pas + decalage;
  for (; t <= finFenetre; t += pas) {
    const xt = x(t);
    if (xt - gauche < 36 || L - droite - xt < 6) continue;
    const d = new Date(t);
    const lib = d.getMinutes() ? `${d.getHours()}h${String(d.getMinutes()).padStart(2, '0')}` : `${d.getHours()}h`;
    svg += `<line x1="${xt}" x2="${xt}" y1="${haut}" y2="${base + 3}" class="grille grille-temps"/><text x="${xt}" y="${H - 6}" class="axe" text-anchor="middle">${lib}</text>`;
  }
  svg += `<text x="${gauche}" y="${H - 6}" class="axe axe-maintenant">maint.</text>`;

  // barres d'intensité, largeur proportionnelle à leur durée réelle
  const etiquettes = h <= 2;
  for (const p of serie) {
    const niveau = niveauDepuisTaux(p.taux);
    if (niveau === 'sec') continue;
    const x0 = x(p.debut) + 0.6;
    const l = Math.max(1, x(p.fin) - x(p.debut) - 1.2);
    const y = Math.min(base - 2, yTaux(p.taux));
    svg += `<rect x="${x0}" y="${y}" width="${l}" height="${base - y}" rx="1.5" data-niveau="${niveau}"><title>${heureCourte(p.debut)}–${heureCourte(p.fin)} : ${mm(arrondi1(p.mm))} (${LIBELLES[niveau]}, ${arrondi1(p.taux).toLocaleString('fr-FR')} mm/h)</title></rect>`;
    if (etiquettes && p.mm >= 0.05 && l > 14) {
      svg += `<text x="${x0 + l / 2}" y="${y - 3}" class="valeur" text-anchor="middle">${arrondi1(p.mm).toLocaleString('fr-FR')}</text>`;
    }
  }

  // courbe du cumul
  if (cumul > 0) {
    const chemin = points.map(([px, v], i) => `${i ? 'L' : 'M'}${px.toFixed(1)},${yCumul(v).toFixed(1)}`).join(' ');
    svg += `<path d="${chemin}" class="courbe-cumul"/>`;
  } else {
    svg += `<text x="${gauche + largeurUtile / 2}" y="${(base + haut) / 2}" class="vide-svg" text-anchor="middle">Pas de pluie prévue</text>`;
  }
  svg += '</svg>';
  zone.innerHTML = svg;
}

// ---------- alertes dans l'appli ----------
async function permissionNotifs() {
  if (NATIF && PLUGINS.LocalNotifications) {
    const { display } = await PLUGINS.LocalNotifications.checkPermissions();
    return display === 'granted' ? 'granted' : display === 'denied' ? 'denied' : 'default';
  }
  return 'Notification' in window ? Notification.permission : 'indisponible';
}

async function majFormulaireAlerte() {
  $('#alerte-active').checked = etat.alerte.active;
  $('#alerte-seuil').value = etat.alerte.seuil;
  $('#alerte-avance').value = String(etat.alerte.avance);
  const n = await permissionNotifs().catch(() => 'indisponible');
  $('#etat-notifs').textContent = {
    granted: 'Notifications autorisées. L\'appli vérifie toutes les 10 minutes tant qu\'elle est ouverte.',
    denied: `Notifications bloquées : autorise-les dans les réglages ${NATIF ? 'du téléphone' : 'du navigateur pour ce site'}.`,
    default: 'Les notifications seront demandées à l\'activation.',
    indisponible: 'Ce navigateur ne gère pas les notifications. Installe l\'appli sur l\'écran d\'accueil.',
  }[n];
}

async function demanderNotifs() {
  if (NATIF && PLUGINS.LocalNotifications) {
    const { display } = await PLUGINS.LocalNotifications.requestPermissions();
    return display === 'granted';
  }
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  return (await Notification.requestPermission()) === 'granted';
}

async function notifier(titre, corps, tag) {
  if (NATIF && PLUGINS.LocalNotifications) {
    await PLUGINS.LocalNotifications.schedule({
      notifications: [{ id: Math.floor(Date.now() / 1000) % 2147483647, title: titre, body: corps }],
    });
    return;
  }
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const options = { body: corps, tag, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', renotify: true };
  const reg = await navigator.serviceWorker?.getRegistration();
  if (reg) reg.showNotification(titre, options);
  else new Notification(titre, options);
}

['#alerte-active', '#alerte-seuil', '#alerte-avance'].forEach((s) =>
  $(s).addEventListener('change', async () => {
    etat.alerte = {
      active: $('#alerte-active').checked,
      seuil: $('#alerte-seuil').value,
      avance: +$('#alerte-avance').value,
    };
    if (etat.alerte.active) await demanderNotifs();
    stock.ecrire('alerte', etat.alerte);
    majFormulaireAlerte();
    majConfig();
    verifierAlerte();
  })
);

$('#btn-test-notif').addEventListener('click', async () => {
  if (await demanderNotifs()) notifier('Pluie en vue', 'Les notifications fonctionnent.', 'test');
  majFormulaireAlerte();
});

function verifierAlerte() {
  if (!etat.alerte.active || !etat.prevision) return;
  const maintenant = Date.now();
  const p = prochainePluie(etat.prevision, etat.alerte.seuil, maintenant, 2);
  if (!p || p.debut - maintenant > etat.alerte.avance * 60000) return;
  // une seule alerte par épisode (pas de nouvelle alerte dans les 90 min)
  if (etat.derniereNotif && maintenant - etat.derniereNotif < 90 * 60000) return;
  etat.derniereNotif = maintenant;
  stock.ecrire('derniere-notif', maintenant);
  const titre = `Attention, pluie ${LIBELLES[p.niveau]} ${p.enCours ? 'en cours' : `d'ici ${formatDuree(p.dansMinutes)}`}`;
  notifier(titre, `${etat.lieu.nom} : vers ${heureCourte(p.debut)}, environ ${mm(p.total)} jusqu'à ${heureCourte(p.fin)}.`, 'pluie');
}

// ---------- alertes programmées (configuration du service en arrière-plan) ----------
const JOURS = { lun: 'L', mar: 'Ma', mer: 'Me', jeu: 'J', ven: 'V', sam: 'S', dim: 'D' };

function majListeProgrammees() {
  const ul = $('#liste-programmees');
  ul.innerHTML = '';
  if (!etat.programmees.length) ul.innerHTML = '<li class="vide">Aucune alerte programmée</li>';
  etat.programmees.forEach((a, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<div><b></b><small></small></div><button type="button" class="btn-fermer" aria-label="Supprimer">✕</button>`;
    li.querySelector('b').textContent = `${a.nom} · ${a.heure.replace(':', 'h')}`;
    li.querySelector('small').textContent =
      `${a.jours.map((j) => JOURS[j]).join(' ')} · pluie sur ${a.horizon_heures} h · seuil ${LIBELLES[a.seuil]}${a.si_sec ? ' · même si sec' : ''}`;
    li.querySelector('button').addEventListener('click', () => {
      etat.programmees.splice(i, 1);
      stock.ecrire('programmees', etat.programmees);
      majListeProgrammees();
      majConfig();
    });
    ul.appendChild(li);
  });
}

$('#form-programmee').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const jours = f.getAll('jours');
  if (!jours.length) return;
  etat.programmees.push({
    nom: f.get('nom').trim() || 'Alerte',
    heure: f.get('heure'),
    jours,
    horizon_heures: +f.get('horizon'),
    seuil: f.get('seuil'),
    si_sec: f.get('si_sec') === 'on',
  });
  stock.ecrire('programmees', etat.programmees);
  e.target.reset();
  majListeProgrammees();
  majConfig();
});

function configJson() {
  return JSON.stringify({
    alerte_imminente: { active: etat.alerte.active, avance_minutes: etat.alerte.avance, seuil: etat.alerte.seuil },
    alertes_programmees: etat.programmees,
  }, null, 2);
}

function majConfig() {
  $('#config-json').value = configJson();
}

$('#btn-copier-config').addEventListener('click', async () => {
  const zone = $('#config-json');
  majConfig();
  zone.hidden = false;
  try {
    await navigator.clipboard.writeText(zone.value);
    $('#btn-copier-config').textContent = 'Copié ✓';
  } catch {
    zone.select();
    $('#btn-copier-config').textContent = 'Sélectionne et copie le texte';
  }
  setTimeout(() => ($('#btn-copier-config').textContent = 'Copier la configuration'), 2500);
});

// ---------- démarrage ----------
if (!NATIF && 'serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

if (etat.lieu) $('#nom-lieu').textContent = etat.lieu.nom;
majFormulaireAlerte();
majListeProgrammees();
majConfig();
if (etat.prevision) afficher();
if (!etat.lieu) dialogue.showModal();

// Actualisation : si le lieu vient du GPS, on reprend d'abord la position (la personne a pu bouger).
let enCours = null;
async function rafraichir({ position = true } = {}) {
  if (enCours) return enCours;
  const bouton = $('#btn-actualiser');
  bouton.classList.add('tourne');
  enCours = (async () => {
    if (position && etat.lieu?.gps) {
      try {
        const { latitude: lat, longitude: lon } = await obtenirPosition();
        const distanceKm = Math.hypot((lat - etat.lieu.lat) * 111, (lon - etat.lieu.lon) * 111 * Math.cos((lat * Math.PI) / 180));
        if (distanceKm > 1) {
          const nom = (await nomDuLieu(lat, lon)) || 'Ma position';
          etat.lieu = { nom, lat, lon, gps: true };
          stock.ecrire('lieu', etat.lieu);
          $('#nom-lieu').textContent = nom;
          if (radar) radar.placer(lat, lon);
        }
      } catch { /* on garde la dernière position connue */ }
    }
    await actualiser();
  })().finally(() => {
    bouton.classList.remove('tourne');
    enCours = null;
  });
  return enCours;
}
$('#btn-actualiser').addEventListener('click', () => {
  rafraichir();
  if ($('#vue-radar').classList.contains('active') && radar) {
    radar.grilleChargee = 0;
    setTimeout(() => radar.charger(), 1500);
  }
});
$('#maj').addEventListener('click', () => rafraichir());
rafraichir();

setInterval(() => {
  if (document.visibilityState === 'visible') rafraichir({ position: false });
}, RAFRAICHISSEMENT);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !etat.prevision) return;
  if (Date.now() - etat.prevision.recu > 5 * 60000) rafraichir();
  else afficher();
});

// pour le débogage dans la console
window.pluie = { etat, rangNiveau };
