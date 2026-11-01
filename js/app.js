import {
  chargerPrevision, resumer, prochainePluie, rechercherLieu, nomDuLieu,
  niveauDepuisTaux, rangNiveau, LIBELLES,
} from './meteo.js';
import { Radar, formatDuree } from './radar.js';

const $ = (s) => document.querySelector(s);
// Dans l'APK Android (Capacitor), on passe par les modules natifs pour la position et les notifications.
const NATIF = !!window.Capacitor?.isNativePlatform?.();
const PLUGINS = window.Capacitor?.Plugins || {};
const HORIZONS = [1, 2, 4, 12, 24];
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
  periode: 6,
  alerte: stock.lire('alerte', { active: false, seuil: 'faible', avance: 30 }),
  programmees: stock.lire('programmees', [
    { nom: 'Matin', heure: '07:00', jours: ['lun', 'mar', 'mer', 'jeu', 'ven'], horizon_heures: 12, seuil: 'faible', si_sec: true },
  ]),
  derniereNotif: stock.lire('derniere-notif', null),
};

const heureCourte = (t) => new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }).replace(':', 'h');
const mm = (v) => `${v.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} mm`;

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
    const prev = await chargerPrevision(etat.lieu.lat, etat.lieu.lon);
    etat.prevision = prev;
    stock.ecrire('derniere-prevision', prev);
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
      `${proche.enCours ? 'Jusqu\'à' : `Vers ${heureCourte(proche.debut)}, jusqu'à`} ${heureCourte(proche.fin)} environ · ${mm(proche.total)}`;
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

  // tuiles 1 h … 24 h
  const conteneur = $('#horizons');
  conteneur.innerHTML = '';
  for (const h of HORIZONS) {
    const r = resumer(prev, h, maintenant);
    const tuile = document.createElement('div');
    tuile.className = 'horizon';
    tuile.dataset.niveau = r.niveau;
    const sec = r.niveau === 'sec';
    tuile.innerHTML = `
      <span class="horizon-duree">${h} h</span>
      <span class="horizon-valeur">${sec ? 'Sec' : mm(r.total)}</span>
      <span class="horizon-detail">${sec ? (r.complet ? 'pas de pluie' : 'données indispo.') : `${LIBELLES[r.niveau]} · ${r.debut - maintenant < 120000 ? 'en cours' : `dès ${heureCourte(r.debut)}`}`}</span>`;
    conteneur.appendChild(tuile);
  }

  dessinerGraphique();
  const age = Math.round((maintenant - prev.recu) / 60000);
  $('#maj').textContent = `Mis à jour ${age < 1 ? 'à l\'instant' : `il y a ${formatDuree(age)}`} · Météo-France AROME/ARPEGE via Open-Meteo`;
}

// ---------- graphique ----------
document.querySelectorAll('.bascule button').forEach((b) => {
  b.addEventListener('click', () => {
    etat.periode = +b.dataset.periode;
    document.querySelectorAll('.bascule button').forEach((x) => x.classList.toggle('actif', x === b));
    dessinerGraphique();
  });
});

function dessinerGraphique() {
  const prev = etat.prevision;
  const zone = $('#graphique');
  if (!prev) return;
  const maintenant = Date.now();
  const detail = etat.periode === 6;
  const serie = (detail ? prev.quart : prev.heure)
    .filter((p) => p.fin > maintenant && p.debut < maintenant + etat.periode * 3600000);
  if (!serie.length) {
    zone.innerHTML = '<p class="vide">Pas de données</p>';
    return;
  }
  const L = 340, H = 156, bas = 22, haut = 18, gauche = 28;
  const largeur = (L - gauche) / serie.length;
  const tauxMax = Math.max(4, ...serie.map((p) => p.taux || 0));
  const echelle = (H - bas - haut) / tauxMax;
  const graduations = [0, Math.round(tauxMax / 2), Math.round(tauxMax)];
  let svg = `<svg viewBox="0 0 ${L} ${H}" role="img" aria-label="Intensité de pluie prévue">`;
  for (const g of graduations) {
    const y = H - bas - g * echelle;
    svg += `<line x1="${gauche}" x2="${L}" y1="${y}" y2="${y}" class="grille"/><text x="${gauche - 4}" y="${y + 3}" class="axe" text-anchor="end">${g}</text>`;
  }
  svg += `<text x="${gauche - 4}" y="8" class="axe" text-anchor="end">mm/h</text>`;
  serie.forEach((p, i) => {
    const x = gauche + i * largeur;
    const niveau = niveauDepuisTaux(p.taux);
    const h = Math.max(niveau === 'sec' ? 0 : 2, (p.taux || 0) * echelle);
    svg += `<rect x="${x + 0.6}" y="${H - bas - h}" width="${Math.max(1, largeur - 1.2)}" height="${h}" rx="1.5" data-niveau="${niveau}"><title>${heureCourte(p.debut)}–${heureCourte(p.fin)} : ${mm(p.mm || 0)} (${LIBELLES[niveau]})</title></rect>`;
    const d = new Date(p.debut);
    const etiquette = detail ? d.getMinutes() === 0 : d.getHours() % 3 === 0;
    if (etiquette && x < L - 14) {
      svg += `<line x1="${x}" x2="${x}" y1="${H - bas}" y2="${H - bas + 3}" class="grille"/><text x="${x}" y="${H - 6}" class="axe" text-anchor="${i === 0 ? 'start' : 'middle'}">${d.getHours()}h</text>`;
    }
  });
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
actualiser();
if (!etat.lieu) dialogue.showModal();

setInterval(() => {
  if (document.visibilityState === 'visible') actualiser();
}, RAFRAICHISSEMENT);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !etat.prevision) return;
  if (Date.now() - etat.prevision.recu > 5 * 60000) actualiser();
  else afficher();
});

// pour le débogage dans la console
window.pluie = { etat, rangNiveau };
