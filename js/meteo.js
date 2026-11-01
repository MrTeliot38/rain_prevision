// Données de prévision (Météo-France AROME / ARPEGE via Open-Meteo) et analyse de la pluie.

const API_PREVISION = 'https://api.open-meteo.com/v1/meteofrance';
const API_RECHERCHE = 'https://geocoding-api.open-meteo.com/v1/search';
const API_LIEU_INVERSE = 'https://api.bigdatacloud.net/data/reverse-geocode-client';

// Intensité en mm/h (seuils usuels : < 2,5 faible, 2,5–7,6 modérée, > 7,6 forte).
export const NIVEAUX = ['sec', 'faible', 'moderee', 'forte'];
export const LIBELLES = { sec: 'Sec', faible: 'faible', moderee: 'modérée', forte: 'forte' };
const SEUIL_PLUIE = 0.1; // mm/h en dessous : considéré comme sec (bruine très légère comprise au-dessus)

export function niveauDepuisTaux(mmParHeure) {
  if (mmParHeure == null || mmParHeure < SEUIL_PLUIE) return 'sec';
  if (mmParHeure < 2.5) return 'faible';
  if (mmParHeure < 7.6) return 'moderee';
  return 'forte';
}

export function rangNiveau(niveau) {
  return NIVEAUX.indexOf(niveau);
}

export async function chargerPrevision(lat, lon) {
  const params = new URLSearchParams({
    latitude: lat.toFixed(4),
    longitude: lon.toFixed(4),
    minutely_15: 'precipitation',
    hourly: 'precipitation',
    forecast_minutely_15: '32',
    past_minutely_15: '1',
    forecast_hours: '26',
    past_hours: '1',
    timeformat: 'unixtime',
    timezone: 'GMT',
  });
  const rep = await fetch(`${API_PREVISION}?${params}`);
  if (!rep.ok) throw new Error(`Prévision indisponible (${rep.status})`);
  const json = await rep.json();
  return normaliser(json);
}

// Open-Meteo : chaque valeur est le cumul de l'intervalle qui SE TERMINE à l'heure indiquée.
function serie(bloc, dureeMin) {
  if (!bloc || !bloc.time) return [];
  return bloc.time.map((t, i) => {
    const fin = t * 1000;
    const mm = bloc.precipitation[i];
    return {
      debut: fin - dureeMin * 60000,
      fin,
      duree: dureeMin,
      mm: mm == null ? null : mm,
      taux: mm == null ? null : (mm * 60) / dureeMin,
    };
  });
}

export function normaliser(json) {
  return {
    recu: Date.now(),
    quart: serie(json.minutely_15, 15),
    heure: serie(json.hourly, 60),
  };
}

// Résumé de la pluie entre maintenant et maintenant + h heures.
export function resumer(prev, heures, maintenant = Date.now()) {
  const limite = maintenant + heures * 3600000;
  // détail au quart d'heure tant qu'il existe, puis données horaires au-delà
  const quarts = prev.quart.filter((p) => p.fin > maintenant && p.debut < limite && p.mm != null);
  const couverture = quarts.length ? quarts[quarts.length - 1].fin : maintenant;
  const heuresSuite = prev.heure.filter((p) => p.fin > couverture && p.debut < limite && p.mm != null);
  const pas = [...quarts, ...heuresSuite];
  let total = 0;
  let tauxMax = 0;
  let premier = null;
  let dernier = null;
  for (const p of pas) {
    // part de l'intervalle comprise dans la fenêtre (le premier pas est souvent entamé)
    const debut = Math.max(p.debut, maintenant, p.duree === 60 ? couverture : 0);
    const fin = Math.min(p.fin, limite);
    if (fin <= debut) continue; // pas horaire entièrement couvert par le détail au quart d'heure
    const part = (fin - debut) / (p.fin - p.debut);
    total += p.mm * part;
    if (niveauDepuisTaux(p.taux) !== 'sec') {
      if (!premier) premier = p;
      dernier = p;
      tauxMax = Math.max(tauxMax, p.taux);
    }
  }
  return {
    heures,
    total: Math.round(total * 100) / 100,
    niveau: niveauDepuisTaux(tauxMax),
    tauxMax,
    debut: premier ? Math.max(premier.debut, maintenant) : null,
    fin: dernier ? Math.min(dernier.fin, limite) : null,
    complet: pas.length > 0,
  };
}

// Prochain épisode de pluie (au moins du niveau demandé) dans les 15 min de détail.
export function prochainePluie(prev, niveauMin = 'faible', maintenant = Date.now(), dansHeures = 6) {
  const limite = maintenant + dansHeures * 3600000;
  const pas = prev.quart.filter((p) => p.fin > maintenant && p.debut < limite && p.mm != null);
  const rangMin = rangNiveau(niveauMin);
  const idx = pas.findIndex((p) => rangNiveau(niveauDepuisTaux(p.taux)) >= rangMin);
  if (idx === -1) return null;
  // l'épisode court tant que les pas suivants sont pluvieux (quel que soit le niveau)
  let j = idx;
  let tauxMax = pas[idx].taux;
  let total = 0;
  while (j < pas.length && niveauDepuisTaux(pas[j].taux) !== 'sec') {
    tauxMax = Math.max(tauxMax, pas[j].taux);
    total += pas[j].mm;
    j++;
  }
  const debut = Math.max(pas[idx].debut, maintenant);
  return {
    debut,
    fin: pas[j - 1].fin,
    dansMinutes: Math.max(0, Math.round((debut - maintenant) / 60000)),
    enCours: pas[idx].debut <= maintenant,
    niveau: niveauDepuisTaux(tauxMax),
    tauxMax,
    total: Math.round(total * 100) / 100,
  };
}

// Grille de points autour du lieu, pour l'animation « radar prévu ».
export function grilleAutour(lat, lon, n = 13, pasLat = 0.07) {
  const pasLon = pasLat / Math.cos((lat * Math.PI) / 180);
  const demi = (n - 1) / 2;
  const lats = [];
  const lons = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      lats.push(+(lat + (demi - i) * pasLat).toFixed(4)); // ligne 0 = nord
      lons.push(+(lon + (j - demi) * pasLon).toFixed(4));
    }
  }
  return {
    n,
    lats,
    lons,
    nord: lat + demi * pasLat,
    sud: lat - demi * pasLat,
    ouest: lon - demi * pasLon,
    est: lon + demi * pasLon,
  };
}

export async function chargerGrille(grille, pas = 24) {
  const params = new URLSearchParams({
    latitude: grille.lats.join(','),
    longitude: grille.lons.join(','),
    minutely_15: 'precipitation',
    forecast_minutely_15: String(pas + 1),
    timeformat: 'unixtime',
    timezone: 'GMT',
  });
  const rep = await fetch(`${API_PREVISION}?${params}`);
  if (!rep.ok) throw new Error(`Grille de prévision indisponible (${rep.status})`);
  let json = await rep.json();
  if (!Array.isArray(json)) json = [json];
  const temps = json[0].minutely_15.time.map((t) => t * 1000);
  // valeurs[k] = tableau n*n des cumuls 15 min (mm) à l'instant temps[k]
  const valeurs = temps.map((_, k) => json.map((loc) => loc.minutely_15.precipitation[k] ?? 0));
  return { temps, valeurs };
}

export async function rechercherLieu(texte) {
  const params = new URLSearchParams({ name: texte, count: '6', language: 'fr', format: 'json' });
  const rep = await fetch(`${API_RECHERCHE}?${params}`);
  if (!rep.ok) throw new Error('Recherche indisponible');
  const json = await rep.json();
  return (json.results || []).map((r) => ({
    nom: r.name,
    detail: [r.postcodes?.[0], r.admin2 || r.admin1, r.country_code !== 'FR' ? r.country : null]
      .filter(Boolean)
      .join(' · '),
    lat: r.latitude,
    lon: r.longitude,
  }));
}

export async function nomDuLieu(lat, lon) {
  try {
    const params = new URLSearchParams({ latitude: lat, longitude: lon, localityLanguage: 'fr' });
    const rep = await fetch(`${API_LIEU_INVERSE}?${params}`);
    if (!rep.ok) return null;
    const json = await rep.json();
    return json.city || json.locality || null;
  } catch {
    return null;
  }
}
