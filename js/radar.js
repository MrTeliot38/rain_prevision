// Carte radar animée : images radar observées (RainViewer, 2 dernières heures)
// puis prévision quart d'heure par quart d'heure (modèle AROME via Open-Meteo).
/* global L */
import { grilleAutour, chargerGrille } from './meteo.js';
import { CLE_CARTO } from './config.js';

const RAINVIEWER = 'https://api.rainviewer.com/public/weather-maps.json';
const OPACITE = 0.75;

// Palette de la prévision, en mm/h (même découpage que les niveaux faible / modérée / forte).
export const PALETTE = [
  // mêmes teintes que le radar observé (palette « Universal Blue » de RainViewer)
  { min: 0.1, couleur: [222, 208, 151], alpha: 170 },
  { min: 0.3, couleur: [136, 221, 238], alpha: 215 },
  { min: 0.65, couleur: [0, 163, 224], alpha: 225 },
  { min: 1.3, couleur: [0, 119, 170], alpha: 230 },
  { min: 2.7, couleur: [0, 85, 136], alpha: 235 },
  { min: 5.6, couleur: [255, 238, 0], alpha: 240 },
  { min: 11.5, couleur: [255, 170, 0], alpha: 240 },
  { min: 24, couleur: [255, 68, 0], alpha: 245 },
  { min: 49, couleur: [193, 0, 0], alpha: 245 },
];

function couleurPour(taux) {
  let c = null;
  for (const p of PALETTE) if (taux >= p.min) c = p;
  return c;
}

export class Radar {
  constructor(conteneur, controles) {
    this.ctrl = controles;
    this.images = [];
    this.index = 0;
    this.lecture = null;
    this.grilleChargee = 0;
    this.carte = L.map(conteneur, { zoomControl: true, attributionControl: true }).setView([46.6, 2.4], 6);
    this.installerFond();
    this.carte.attributionControl.addAttribution(
      'Radar <a href="https://www.rainviewer.com/">RainViewer</a> · Prévision Météo-France via <a href="https://open-meteo.com/">Open-Meteo</a>'
    );
    this.zonePrevision = L.rectangle([[0, 0], [0, 0]], {
      color: '#2563eb', weight: 1, dashArray: '4 4', fill: false, interactive: false, opacity: 0,
    }).addTo(this.carte);

    controles.lecture.addEventListener('click', () => (this.lecture ? this.pause() : this.jouer()));
    controles.curseur.addEventListener('input', () => {
      this.pause();
      this.afficher(+controles.curseur.value);
    });
  }

  // Fond de carte : CARTO (avec clé) si possible, sinon OpenStreetMap.
  // Si CARTO refuse les tuiles (clé limitée à un autre domaine, quota…), on bascule tout seul.
  installerFond() {
    const osm = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
    const sources = [];
    if (CLE_CARTO) {
      sources.push({
        url: `https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png?key=${CLE_CARTO}`,
        options: { subdomains: 'abcd', attribution: `${osm} © <a href="https://carto.com/attributions">CARTO</a>` },
      });
    }
    sources.push({ url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', options: { attribution: osm } });

    const essayer = (i) => {
      const s = sources[i];
      const couche = L.tileLayer(s.url, { maxZoom: 13, zIndex: 1, ...s.options });
      let ok = 0;
      let echecs = 0;
      couche.on('tileload', () => ok++);
      couche.on('tileerror', () => {
        echecs++;
        if (!ok && echecs >= 3 && i + 1 < sources.length) {
          this.carte.removeLayer(couche); // retire aussi son attribution
          couche.off();
          essayer(i + 1);
        }
      });
      couche.addTo(this.carte);
      this.fond = couche;
    };
    essayer(0);
  }

  placer(lat, lon) {
    if (this.marqueur) this.marqueur.setLatLng([lat, lon]);
    else {
      this.marqueur = L.circleMarker([lat, lon], {
        radius: 7, color: '#fff', weight: 3, fillColor: '#e11d48', fillOpacity: 1,
      }).addTo(this.carte);
    }
    this.carte.setView([lat, lon], 9);
    this.lieu = { lat, lon };
    this.grilleChargee = 0;
  }

  redimensionner() {
    this.carte.invalidateSize();
  }

  async charger() {
    if (!this.lieu) return;
    const recent = Date.now() - this.grilleChargee < 10 * 60000;
    if (recent && this.images.length) return;
    this.ctrl.etat.textContent = 'Chargement du radar…';
    this.pause();
    for (const im of this.images) this.carte.removeLayer(im.couche);
    this.images = [];

    const [obs, prev] = await Promise.allSettled([this.chargerObservations(), this.chargerPrevisions()]);
    const immediat = this.imagesNowcast();
    if (obs.status === 'fulfilled') this.images.push(...obs.value);
    this.images.push(...immediat);
    if (prev.status === 'fulfilled') {
      // la première heure vient du radar extrapolé quand il est disponible
      const finRadar = immediat.length ? immediat[immediat.length - 1].t : 0;
      this.images.push(...prev.value.filter((im) => im.t > finRadar));
    }
    this.images.sort((a, b) => a.t - b.t);
    for (const im of this.images) im.couche.addTo(this.carte);

    const erreurs = [];
    if (obs.status === 'rejected') erreurs.push('radar observé indisponible');
    if (prev.status === 'rejected') erreurs.push('prévision indisponible');
    this.ctrl.etat.textContent = erreurs.join(' · ');

    if (!this.images.length) return;
    this.grilleChargee = Date.now();
    this.ctrl.curseur.max = String(this.images.length - 1);
    // on démarre sur l'image la plus proche de maintenant
    const maintenant = Date.now();
    let depart = 0;
    this.images.forEach((im, i) => {
      if (im.t <= maintenant) depart = i;
    });
    this.afficher(depart);
  }

  async chargerObservations() {
    const rep = await fetch(RAINVIEWER);
    if (!rep.ok) throw new Error('RainViewer');
    const json = await rep.json();
    const passees = json.radar?.past || [];
    return passees.map((p) => ({
      t: p.time * 1000,
      type: 'obs',
      couche: L.tileLayer(`${json.host}${p.path}/256/{z}/{x}/{y}/2/1_1.png`, {
        opacity: 0,
        maxNativeZoom: 7,
        maxZoom: 13,
        zIndex: 5,
      }),
    }));
  }

  async chargerPrevisions() {
    const g = grilleAutour(this.lieu.lat, this.lieu.lon);
    const { temps, valeurs } = await chargerGrille(g);
    this.zonePrevision.setBounds([[g.sud, g.ouest], [g.nord, g.est]]);
    const maintenant = Date.now();
    const images = [];
    temps.forEach((t, k) => {
      if (t <= maintenant) return;
      const url = dessinerGrille(valeurs[k], g.n);
      images.push({
        t,
        type: 'prev',
        couche: L.imageOverlay(url, [[g.sud, g.ouest], [g.nord, g.est]], { opacity: 0, zIndex: 6, className: 'couche-prevision' }),
      });
    });
    return images;
  }

  definirNowcast(nc) {
    this.nowcast = nc;
    this.grilleChargee = 0; // forcer le rechargement de l'animation
  }

  // Images « prévision radar » : la dernière image observée, déplacée selon le mouvement mesuré.
  imagesNowcast() {
    const nc = this.nowcast;
    if (!nc || !nc.fiable) return [];
    const url = dessinerChamp(nc.champ, nc.taille);
    const dLon = (nc.bornes.est - nc.bornes.ouest) / nc.taille;
    const dLat = (nc.bornes.nord - nc.bornes.sud) / nc.taille;
    const maintenant = Date.now();
    const images = [];
    for (let k = 1; k <= 6; k++) {
      const t = nc.t0 + k * 600000;
      if (t <= maintenant) continue;
      const decX = nc.vitesse.vx * k * dLon;
      const decY = -nc.vitesse.vy * k * dLat;
      const b = [[nc.bornes.sud + decY, nc.bornes.ouest + decX], [nc.bornes.nord + decY, nc.bornes.est + decX]];
      images.push({ t, type: 'nowcast', couche: L.imageOverlay(url, b, { opacity: 0, zIndex: 6 }) });
    }
    return images;
  }

  afficher(i) {
    if (!this.images.length) return;
    this.index = i;
    this.images.forEach((im, k) => im.couche.setOpacity(k === i ? OPACITE : 0));
    const im = this.images[i];
    this.zonePrevision.setStyle({ opacity: im.type === 'prev' ? 0.7 : 0 });
    this.ctrl.curseur.value = String(i);
    const heure = new Date(im.t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }).replace(':', 'h');
    const ecart = Math.round((im.t - Date.now()) / 60000);
    const relatif = ecart > 0 ? `dans ${formatDuree(ecart)}` : ecart > -5 ? 'maintenant' : `il y a ${formatDuree(-ecart)}`;
    this.ctrl.libelle.innerHTML = `<b>${heure}</b> · ${relatif}`;
    this.ctrl.type.textContent = { obs: 'Radar observé', nowcast: 'Prévision radar', prev: 'Prévision modèle' }[im.type];
    this.ctrl.type.dataset.type = im.type;
  }

  jouer() {
    if (!this.images.length) return;
    this.ctrl.lecture.textContent = '❚❚';
    this.ctrl.lecture.setAttribute('aria-label', 'Pause');
    const avancer = () => {
      const suivant = (this.index + 1) % this.images.length;
      this.afficher(suivant);
      this.lecture = setTimeout(avancer, suivant === this.images.length - 1 ? 1600 : 550);
    };
    this.lecture = setTimeout(avancer, 200);
  }

  pause() {
    clearTimeout(this.lecture);
    this.lecture = null;
    this.ctrl.lecture.textContent = '▶';
    this.ctrl.lecture.setAttribute('aria-label', 'Lecture');
  }
}

export function formatDuree(min) {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${String(m).padStart(2, '0')}` : `${h} h`;
}

// Champ radar (mm/h) → image colorée avec la même palette que la prévision.
function dessinerChamp(champ, taille) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = taille;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(taille, taille);
  for (let k = 0; k < champ.length; k++) {
    const c = couleurPour(champ[k]);
    if (!c) continue;
    img.data[k * 4] = c.couleur[0];
    img.data[k * 4 + 1] = c.couleur[1];
    img.data[k * 4 + 2] = c.couleur[2];
    img.data[k * 4 + 3] = c.alpha;
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL('image/png');
}

// Interpolation bilinéaire de la grille n×n (cumuls 15 min) vers une image.
function dessinerGrille(valeurs, n, taille = 192) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = taille;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(taille, taille);
  const v = (i, j) => valeurs[i * n + j] * 4; // mm/15 min → mm/h
  for (let y = 0; y < taille; y++) {
    const gy = (y / (taille - 1)) * (n - 1);
    const i0 = Math.min(Math.floor(gy), n - 2);
    const fy = gy - i0;
    for (let x = 0; x < taille; x++) {
      const gx = (x / (taille - 1)) * (n - 1);
      const j0 = Math.min(Math.floor(gx), n - 2);
      const fx = gx - j0;
      const taux =
        v(i0, j0) * (1 - fx) * (1 - fy) +
        v(i0, j0 + 1) * fx * (1 - fy) +
        v(i0 + 1, j0) * (1 - fx) * fy +
        v(i0 + 1, j0 + 1) * fx * fy;
      const c = couleurPour(taux);
      if (!c) continue;
      const k = (y * taille + x) * 4;
      img.data[k] = c.couleur[0];
      img.data[k + 1] = c.couleur[1];
      img.data[k + 2] = c.couleur[2];
      img.data[k + 3] = c.alpha;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL('image/png');
}
