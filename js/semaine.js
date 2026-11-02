// Onglet « 7 jours » : prévision quotidienne (Météo-France pour les premiers jours, puis meilleurs modèles disponibles).

const API = 'https://api.open-meteo.com/v1/forecast';

export async function chargerSemaine(lat, lon) {
  const params = new URLSearchParams({
    latitude: lat.toFixed(4),
    longitude: lon.toFixed(4),
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,precipitation_hours,wind_speed_10m_max,wind_gusts_10m_max,wind_direction_10m_dominant,sunrise,sunset,uv_index_max',
    hourly: 'temperature_2m,apparent_temperature,precipitation,precipitation_probability,weather_code,wind_speed_10m,wind_gusts_10m,wind_direction_10m,relative_humidity_2m',
    timezone: 'auto',
    forecast_days: '7',
  });
  const rep = await fetch(`${API}?${params}`);
  if (!rep.ok) throw new Error(`Prévision indisponible (${rep.status})`);
  const j = await rep.json();
  const h = j.hourly;
  // heures regroupées par jour (les heures sont déjà à l'heure locale du lieu)
  const parJour = new Map();
  h.time.forEach((t, i) => {
    const jour = t.slice(0, 10);
    if (!parJour.has(jour)) parJour.set(jour, []);
    parJour.get(jour).push({
      heure: +t.slice(11, 13),
      temp: h.temperature_2m[i],
      ressenti: h.apparent_temperature[i],
      pluie: h.precipitation[i] ?? 0,
      proba: h.precipitation_probability[i],
      code: h.weather_code[i],
      vent: h.wind_speed_10m[i],
      rafales: h.wind_gusts_10m[i],
      direction: h.wind_direction_10m[i],
      humidite: h.relative_humidity_2m[i],
    });
  });
  const d = j.daily;
  return {
    recu: Date.now(),
    jours: d.time.map((jour, i) => ({
      date: jour,
      code: d.weather_code[i],
      tmin: d.temperature_2m_min[i],
      tmax: d.temperature_2m_max[i],
      pluie: d.precipitation_sum[i] ?? 0,
      proba: d.precipitation_probability_max[i],
      heuresPluie: d.precipitation_hours[i],
      vent: d.wind_speed_10m_max[i],
      rafales: d.wind_gusts_10m_max[i],
      direction: d.wind_direction_10m_dominant[i],
      lever: d.sunrise[i]?.slice(11, 16),
      coucher: d.sunset[i]?.slice(11, 16),
      uv: d.uv_index_max[i],
      heures: parJour.get(jour) || [],
    })),
  };
}

// ---------- codes météo (OMM) ----------
const TEMPS = {
  0: ['Ensoleillé', 'soleil'], 1: ['Plutôt ensoleillé', 'eclaircies'], 2: ['Partiellement nuageux', 'eclaircies'],
  3: ['Couvert', 'nuages'], 45: ['Brouillard', 'brouillard'], 48: ['Brouillard givrant', 'brouillard'],
  51: ['Bruine légère', 'bruine'], 53: ['Bruine', 'bruine'], 55: ['Bruine dense', 'bruine'],
  56: ['Bruine verglaçante', 'bruine'], 57: ['Bruine verglaçante', 'bruine'],
  61: ['Pluie faible', 'pluie'], 63: ['Pluie modérée', 'pluie'], 65: ['Pluie forte', 'pluie'],
  66: ['Pluie verglaçante', 'pluie'], 67: ['Pluie verglaçante', 'pluie'],
  71: ['Neige faible', 'neige'], 73: ['Neige', 'neige'], 75: ['Neige forte', 'neige'], 77: ['Grains de neige', 'neige'],
  80: ['Averses', 'averses'], 81: ['Averses', 'averses'], 82: ['Fortes averses', 'averses'],
  85: ['Averses de neige', 'neige'], 86: ['Averses de neige', 'neige'],
  95: ['Orages', 'orage'], 96: ['Orages et grêle', 'orage'], 99: ['Orages et grêle', 'orage'],
};
export const libelleTemps = (code) => TEMPS[code]?.[0] ?? '—';

export function iconeTemps(code, taille = 40, nuit = false) {
  const type = TEMPS[code]?.[1] ?? 'nuages';
  const lune = (cx, cy, r) => `<path d="M${cx + r * 0.35} ${cy - r}a${r} ${r} 0 1 0 ${r * 0.65} ${r * 1.55}A${r * 0.8} ${r * 0.8} 0 0 1 ${cx + r * 0.35} ${cy - r}z" fill="#fcd34d"/>`;
  const soleil = (cx, cy, r) =>
    `<g fill="#f59e0b" stroke="#f59e0b" stroke-width="2.5" stroke-linecap="round"><circle cx="${cx}" cy="${cy}" r="${r}"/>${
      [0, 45, 90, 135, 180, 225, 270, 315].map((a) => {
        const rad = (a * Math.PI) / 180;
        return `<line x1="${cx + Math.cos(rad) * (r + 4)}" y1="${cy + Math.sin(rad) * (r + 4)}" x2="${cx + Math.cos(rad) * (r + 8)}" y2="${cy + Math.sin(rad) * (r + 8)}"/>`;
      }).join('')}</g>`;
  const nuage = (c, dy = 0) => `<path d="M14 ${32 + dy}a7 7 0 0 1 .9-13.9A10 10 0 0 1 34 18.5a6.8 6.8 0 0 1 .5 13.5z" fill="${c}"/>`;
  const gouttes = (n, c = '#38bdf8') => [16, 24, 32].slice(0, n).map((x) => `<path d="M${x} 36l-2.5 6" stroke="${c}" stroke-width="2.6" stroke-linecap="round"/>`).join('');
  const flocons = [16, 24, 32].map((x) => `<circle cx="${x}" cy="39" r="2.2" fill="#93c5fd"/>`).join('');
  const dessins = {
    soleil: nuit ? lune(22, 24, 11) : soleil(24, 24, 9),
    eclaircies: (nuit ? lune(28, 15, 8) : soleil(30, 16, 7)) + nuage('var(--nuage-clair)', 4),
    nuages: nuage('var(--nuage)'),
    brouillard: nuage('var(--nuage)', -4) + '<g stroke="var(--nuage)" stroke-width="2.5" stroke-linecap="round"><line x1="10" y1="35" x2="38" y2="35"/><line x1="14" y1="41" x2="34" y2="41"/></g>',
    bruine: nuage('var(--nuage)') + gouttes(2),
    pluie: nuage('var(--nuage-sombre)') + gouttes(3),
    averses: (nuit ? lune(29, 13, 6) : soleil(31, 14, 6)) + nuage('var(--nuage)') + gouttes(2),
    neige: nuage('var(--nuage)') + flocons,
    orage: nuage('var(--nuage-sombre)') + '<path d="M25 31l-5 8h5l-3 7 8-10h-5l3-5z" fill="#facc15"/>',
  };
  return `<svg viewBox="0 0 48 48" width="${taille}" height="${taille}" role="img" aria-label="${libelleTemps(code)}">${dessins[type]}</svg>`;
}

// gravité, pour retenir le temps le plus marquant d'une période
const GRAVITE = (c) => (c >= 95 ? 9 : c >= 71 && c <= 86 && ![80, 81, 82].includes(c) ? 8 : c >= 80 ? 7 : c >= 61 ? 6 : c >= 51 ? 5 : c >= 45 ? 4 : c);

// ---------- vent ----------
const POINTS = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
export const pointCardinal = (deg) => POINTS[Math.round(((deg % 360) / 45)) % 8];
export function flecheVent(deg, taille = 16) {
  // la flèche indique où va le vent (il vient de « deg »)
  return `<svg viewBox="0 0 24 24" width="${taille}" height="${taille}" aria-hidden="true" style="transform:rotate(${(deg + 180) % 360}deg)"><path d="M12 3l6 15-6-4-6 4z" fill="currentColor"/></svg>`;
}
const niveauVent = (rafales) => (rafales >= 80 ? 'fort' : rafales >= 55 ? 'soutenu' : '');

// ---------- périodes de la journée ----------
const PERIODES = [
  { nom: 'Nuit', de: 0, a: 6, nuit: true },
  { nom: 'Matin', de: 6, a: 12 },
  { nom: 'Après-midi', de: 12, a: 18 },
  { nom: 'Soirée', de: 18, a: 24, nuit: true },
];

function resumePeriode(heures, de, a) {
  const hs = heures.filter((x) => x.heure >= de && x.heure < a);
  if (!hs.length) return null;
  const moy = (k) => hs.reduce((s, x) => s + (x[k] ?? 0), 0) / hs.length;
  return {
    temp: Math.round(moy('temp')),
    ressenti: Math.round(moy('ressenti')),
    pluie: hs.reduce((s, x) => s + x.pluie, 0),
    proba: Math.max(...hs.map((x) => x.proba ?? 0)),
    vent: Math.round(moy('vent')),
    rafales: Math.round(Math.max(...hs.map((x) => x.rafales ?? 0))),
    direction: hs[Math.floor(hs.length / 2)].direction,
    code: hs.reduce((m, x) => (GRAVITE(x.code) > GRAVITE(m) ? x.code : m), hs[0].code),
  };
}

// température « matin » (moyenne 7 h–11 h) et « après-midi » (maximum 12 h–18 h)
function tempsJour(heures) {
  const matin = heures.filter((x) => x.heure >= 7 && x.heure <= 11);
  const am = heures.filter((x) => x.heure >= 12 && x.heure < 18);
  return {
    matin: matin.length ? Math.round(matin.reduce((s, x) => s + x.temp, 0) / matin.length) : null,
    apresMidi: am.length ? Math.round(Math.max(...am.map((x) => x.temp))) : null,
  };
}

const mmTexte = (v) => (v < 0.05 ? '0 mm' : v < 1 ? `${v.toFixed(1).replace('.', ',')} mm` : `${Math.round(v)} mm`);

function nomJour(date, i) {
  if (i === 0) return 'Aujourd\'hui';
  if (i === 1) return 'Demain';
  const d = new Date(`${date}T12:00:00`);
  return d.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric' }).replace('.', '');
}

// ---------- rendu ----------
export function rendreSemaine(conteneur, donnees, ouvert = 0) {
  conteneur.innerHTML = '';
  donnees.jours.forEach((j, i) => {
    const { matin, apresMidi } = tempsJour(j.heures);
    const pluieNotable = j.pluie >= 0.2 || (j.proba ?? 0) >= 40;
    const vent = niveauVent(j.rafales);
    const el = document.createElement('details');
    el.className = 'jour';
    if (i === ouvert) el.open = true;
    el.innerHTML = `
      <summary class="jour-ligne">
        <span class="jour-nom">${nomJour(j.date, i)}</span>
        <span class="jour-icone">${iconeTemps(j.code, 36)}</span>
        <span class="jour-temp">
          <span><small>matin</small><b>${matin ?? '–'}°</b></span>
          <span><small>après-midi</small><b>${apresMidi ?? '–'}°</b></span>
        </span>
        <span class="jour-pluie ${pluieNotable ? 'oui' : ''}">
          <b>${mmTexte(j.pluie)}</b><small>${j.proba ?? 0} %</small>
        </span>
        <span class="jour-vent ${vent}">
          <b>${flecheVent(j.direction)}${Math.round(j.vent)}</b><small>raf. ${Math.round(j.rafales)}</small>
        </span>
      </summary>
      <div class="jour-detail"></div>`;
    el.addEventListener('toggle', () => {
      if (el.open && !el.querySelector('.jour-detail').childElementCount) rendreDetail(el.querySelector('.jour-detail'), j);
    });
    if (el.open) rendreDetail(el.querySelector('.jour-detail'), j);
    conteneur.appendChild(el);
  });
}

function rendreDetail(zone, j) {
  const periodes = PERIODES.map((p) => ({ ...p, r: resumePeriode(j.heures, p.de, p.a) })).filter((p) => p.r);
  const hum = j.heures.length ? Math.round(j.heures.reduce((s, x) => s + (x.humidite ?? 0), 0) / j.heures.length) : null;
  zone.innerHTML = `
    <p class="jour-resume">${libelleTemps(j.code)} · min ${Math.round(j.tmin)}° / max ${Math.round(j.tmax)}°</p>
    <div class="periodes">
      ${periodes.map(({ nom, nuit, r }) => `
        <div class="periode">
          <span class="periode-nom">${nom}</span>
          ${iconeTemps(r.code, 34, nuit)}
          <b class="periode-temp">${r.temp}°</b>
          <small>ressenti ${r.ressenti}°</small>
          <small class="${r.pluie >= 0.2 ? 'pluie-oui' : ''}">💧 ${mmTexte(r.pluie)}</small>
          <small class="${r.proba >= 40 ? 'pluie-oui' : ''}">risque ${r.proba} %</small>
          <small class="periode-vent ${niveauVent(r.rafales)}">${flecheVent(r.direction, 12)} ${r.vent} km/h</small>
          <small class="periode-vent ${niveauVent(r.rafales)}">rafales ${r.rafales}</small>
        </div>`).join('')}
    </div>
    <h3 class="detail-titre">Pluie heure par heure</h3>
    ${graphiquePluie(j.heures)}
    <dl class="infos-jour">
      <div><dt>Pluie</dt><dd>${mmTexte(j.pluie)} en ${j.heuresPluie ?? 0} h · risque max ${j.proba ?? 0} %</dd></div>
      <div><dt>Vent</dt><dd>${pointCardinal(j.direction)} · ${Math.round(j.vent)} km/h, rafales ${Math.round(j.rafales)} km/h</dd></div>
      <div><dt>Soleil</dt><dd>lever ${j.lever?.replace(':', 'h')} · coucher ${j.coucher?.replace(':', 'h')}</dd></div>
      <div><dt>Indice UV</dt><dd>${j.uv != null ? `${Math.round(j.uv)} (${j.uv < 3 ? 'faible' : j.uv < 6 ? 'modéré' : j.uv < 8 ? 'élevé' : 'très élevé'})` : '–'}</dd></div>
      ${hum != null ? `<div><dt>Humidité</dt><dd>${hum} % en moyenne</dd></div>` : ''}
    </dl>`;
}

function graphiquePluie(heures) {
  if (!heures.length) return '';
  const L = 340, H = 110, bas = 18, haut = 14, gauche = 6, droite = 6;
  const larg = (L - gauche - droite) / 24;
  const max = Math.max(2, ...heures.map((x) => x.pluie));
  const yP = (v) => H - bas - (v / max) * (H - bas - haut);
  const yProba = (v) => H - bas - (v / 100) * (H - bas - haut);
  let svg = `<svg viewBox="0 0 ${L} ${H}" class="graphique-jour" role="img" aria-label="Pluie heure par heure">`;
  svg += `<line x1="${gauche}" x2="${L - droite}" y1="${H - bas}" y2="${H - bas}" class="grille"/>`;
  // risque de pluie (zone)
  const pts = heures.map((x) => `${(gauche + (x.heure + 0.5) * larg).toFixed(1)},${yProba(x.proba ?? 0).toFixed(1)}`);
  svg += `<polyline points="${pts.join(' ')}" class="courbe-proba"/>`;
  for (const x of heures) {
    if (x.pluie >= 0.05) {
      const y = yP(x.pluie);
      svg += `<rect x="${gauche + x.heure * larg + 1}" y="${y}" width="${larg - 2}" height="${H - bas - y}" rx="1.5" class="barre-pluie"><title>${x.heure}h : ${mmTexte(x.pluie)} · risque ${x.proba ?? 0} %</title></rect>`;
      if (x.pluie >= 0.5) svg += `<text x="${gauche + (x.heure + 0.5) * larg}" y="${y - 2}" class="valeur" text-anchor="middle">${x.pluie >= 1 ? Math.round(x.pluie) : x.pluie.toFixed(1).replace('.', ',')}</text>`;
    }
    if (x.heure % 3 === 0) svg += `<text x="${gauche + x.heure * larg}" y="${H - 4}" class="axe">${x.heure}h</text>`;
  }
  const total = heures.reduce((s, x) => s + x.pluie, 0);
  if (total < 0.05) svg += `<text x="${L / 2}" y="${(H - bas) / 2 + 4}" class="axe vide-svg" text-anchor="middle">Pas de pluie prévue ce jour-là</text>`;
  svg += `<text x="${L - droite}" y="10" class="axe" text-anchor="end">barres : mm · pointillés : risque %</text></svg>`;
  return svg;
}
