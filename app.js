
const { mapbox, categories } = window.APP_CONFIG;
mapboxgl.accessToken = mapbox.token;

// The map does not depend on Mapbox analytics/events.
// Disable telemetry when supported to avoid unnecessary cross-origin
// requests during local development, especially in Firefox.
if (typeof mapboxgl.setTelemetryEnabled === "function") {
  mapboxgl.setTelemetryEnabled(false);
}

const state = {
  map: null,
  records: [],
  bySubcategory: new Map(),
  subcategoryMeta: new Map(),
  categoryEnabled: new Map(categories.map(c => [c.id, true])),
  subcategoryEnabled: new Map(),
  markers: new Map(),
  loading: false,
  search: "",
  sourceStatus: new Map(),
  diagnostics: {
    mapbox: "pending",
    sources: "pending",
    layers: "pending",
    loaded: 0,
    total: 0
  },
  forcedSettlementFeatures: [],
  forcedSettlementLayoutTimer: null
};

categories.forEach(cat => cat.subcategories.forEach(sub => {
  state.subcategoryEnabled.set(sub.id, true);
  state.subcategoryMeta.set(sub.id, {...sub, categoryId: cat.id, categoryName: cat.name, categoryColor: cat.color});
}));

const $ = s => document.querySelector(s);
const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));

function iconSvg(name, size=16) {
  // Lucide's DOM replacement is used for interface icons.
  // Markers use a small fallback symbol if a specific icon is unavailable.
  const fallback = {
    "baby":"♟","users":"♟","school":"⌂","graduation-cap":"◆","accessibility":"♿",
    "library":"▤","trophy":"★","music-2":"♪","sparkles":"✦","playground":"♧",
    "heart-handshake":"♡","users-round":"♟","calendar-heart":"♡","heart":"♡",
    "dumbbell":"●","palette":"◈","building-2":"▥","map-pin":"●","landmark":"▤",
    "info":"i","hospital":"+","stethoscope":"✚","cross":"+","house-heart":"♥",
    "tooth":"✦","syringe":"✚","brain":"◉","heart-pulse":"♥","handshake":"♧",
    "shopping-basket":"▦","croissant":"⌒","store":"▥","coffee":"●","utensils":"≡",
    "fuel":"⛽","wrench":"⌁","bus-front":"▣","car-front":"▰","train-front":"▤",
    "hand-helping":"✋","briefcase-business":"▣"
  };
  return `<span class="fallback-icon" aria-hidden="true">${fallback[name] || "•"}</span>`;
}

function findField(row, candidates) {
  const keys = Object.keys(row);
  const normalized = s => String(s).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9]/g,"");
  for (const candidate of candidates) {
    const exact = keys.find(k => normalized(k) === normalized(candidate));
    if (exact) return row[exact];
  }
  for (const candidate of candidates) {
    const c = normalized(candidate);
    const partial = keys.find(k => normalized(k).includes(c));
    if (partial) return row[partial];
  }
  return "";
}

function parseCoordinate(row, names) {
  // Google Sheets may return headers with BOM/whitespace or slightly
  // different capitalization. Use the same normalized lookup as all
  // other fields instead of accessing row["latitude"] literally.
  const value = findField(row, names);
  if (value === undefined || value === null || String(value).trim() === "") {
    return null;
  }

  // Supports both "43.1998" and locale-style "43,1998".
  const raw = String(value)
    .trim()
    .replace(/\s+/g, "")
    .replace(",", ".");

  const v = Number(raw);
  return Number.isFinite(v) ? v : null;
}


function normalizeRow(row, meta, index) {
  const lng = parseCoordinate(row, ["longitude","lon","lng","long","x","coordonneesx","coordonneex"]);
  const lat = parseCoordinate(row, ["latitude","lat","y","coordonneesy","coordonneey"]);
  if (lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;

  // Current Google Sheets schema:
  // Title | Description | Commune | Latitude | Longitude
  // Keep the generic fallbacks so future sheets can evolve without breaking.
  const name = findField(row, [
    "Title", "name", "nom", "nom de la structure", "structure",
    "établissement", "etablissement", "nom établissement",
    "nom de l'établissement", "raison sociale", "organisme", "libelle", "libellé"
  ]) || `${meta.name} ${index + 1}`;

  return {
    id: `${meta.categoryId}__${meta.id}__${index}`,
    categoryId: meta.categoryId,
    categoryName: meta.categoryName,
    categoryColor: meta.categoryColor,
    subcategoryId: meta.id,
    subcategoryName: meta.name,
    subcategoryIcon: meta.icon,
    name: String(name).trim(),
    // The current sheets provide the locality in "Commune".
    // There is no postal-code/address column in the shared schema.
    address: findField(row, ["address","adresse","adresse complète","adresse complete","voie"]),
    city: findField(row, ["Commune","city","ville","commune"]),
    postalCode: findField(row, ["postal_code","postal code","code postal","cp"]),
    phone: findField(row, ["phone","telephone","téléphone","tel"]),
    email: findField(row, ["email","mail","e-mail"]),
    website: findField(row, ["website","site","site web","url","web"]),
    description: findField(row, ["Description","description","descriptif","présentation","presentation"]),
    latitude: lat,
    longitude: lng,
    raw: row
  };
}

function recordToFeature(r) {
  return {
    type: "Feature",
    geometry: {type:"Point", coordinates:[r.longitude, r.latitude]},
    properties: r
  };
}

// One clustered GeoJSON source per CATEGORY.
// Point layers remain separate per SUBCATEGORY so their filters/icons stay independent.
function makeSourceId(categoryId) { return `src-cat-${categoryId}`; }
function makeClusterLayerId(categoryId) { return `cluster-cat-${categoryId}`; }
function makeClusterCountLayerId(categoryId) { return `cluster-count-cat-${categoryId}`; }
function makePointLayerId(subId) { return `point-${subId}`; }

/*
 * Custom replacement labels for the 16 selected Minervois localities.
 *
 * The labels stay fully visible from zoom 9 to 22.  Instead of using the
 * Mapbox collision engine (which can hide labels), we do a small, explicit
 * screen-space test against the ACTUAL rendered cluster circles currently
 * visible on the map.  When a circle intersects a label, the label is moved
 * to the nearest free side / above / below position.
 *
 * The important point is that labels are NEVER hidden by this logic.
 */
const FORCED_SETTLEMENTS = [
  {name:"Agel",               longitude:2.852754592895508, latitude:43.338101253312686, symbolrank:16, filterrank:2},
  {name:"Aigne",              longitude:2.7980804443359375, latitude:43.332701157395036, symbolrank:16, filterrank:2},
  {name:"Aigues-Vives",       longitude:2.817091941833496,  latitude:43.337601842628885, symbolrank:16, filterrank:1},
  {name:"Azillanet",          longitude:2.737741470336914, latitude:43.32458450313996,  symbolrank:16, filterrank:2},
  {name:"Beaufort",           longitude:2.7587270736694336, latitude:43.29857268764732,  symbolrank:16, filterrank:4},
  {name:"La Caunette",        longitude:2.7795839309692383, latitude:43.352488759492616, symbolrank:16, filterrank:1},
  {name:"Cesseras",           longitude:2.7167129516601562, latitude:43.32420986214322,  symbolrank:16, filterrank:5},
  {name:"Félines-Minervois",  longitude:2.601141929626465,  latitude:43.3298916690492,   symbolrank:16, filterrank:1},
  {name:"La Livinière",       longitude:2.6363325119018555, latitude:43.316092073213014,  symbolrank:16, filterrank:3},
  {name:"Minerve",            longitude:2.746281623840332,  latitude:43.35395540696757,   symbolrank:16, filterrank:3},
  {name:"Olonzac",            longitude:2.729673385620117,  latitude:43.284453573835634,   symbolrank:15, filterrank:1},
  {name:"Oupia",              longitude:2.7666234970092773, latitude:43.28979548243444,   symbolrank:16, filterrank:3},
  {name:"Siran",              longitude:2.661309242248535,  latitude:43.313562848157375,   symbolrank:16, filterrank:4},
  {name:"Pépieux",            longitude:2.680063247680664,  latitude:43.29744827659317,   symbolrank:15, filterrank:2},
  {name:"Rieux-Minervois",    longitude:2.5861215591430664, latitude:43.28267283338644,   symbolrank:15, filterrank:1},
  {name:"Lézignan-Corbières", longitude:2.7574825286865234, latitude:43.20089013057347,   symbolrank:13, filterrank:1}
];

function forcedLabelTextSize() {
  const z = state.map?.getZoom?.() ?? 9;
  if (z <= 9) return 16;
  if (z <= 13) return 16 + (z - 9) * (2 / 4);
  if (z <= 18) return 18 + (z - 13) * (2 / 5);
  return 20 + (z - 18) * (2 / 4);
}

function forcedLabelClusterRadius(pointCount) {
  // Matches the cluster circle-radius expression used in buildMapLayers().
  const count = Number(pointCount) || 0;
  if (count < 10) return 19;
  if (count < 30) return 22;
  if (count < 100) return 26;
  return 31;
}

function forcedLabelTextBox(point, anchor, textWidth, textHeight, radialOffsetPx) {
  const diagonal = Math.SQRT1_2;
  const directions = {
    top: [0, -1],
    bottom: [0, 1],
    left: [-1, 0],
    right: [1, 0],
    "top-left": [-diagonal, -diagonal],
    "top-right": [diagonal, -diagonal],
    "bottom-left": [-diagonal, diagonal],
    "bottom-right": [diagonal, diagonal]
  };

  const [dx, dy] = directions[anchor] || [0, -1];
  const ax = point.x + dx * radialOffsetPx;
  const ay = point.y + dy * radialOffsetPx;

  let x1, y1, x2, y2;
  switch (anchor) {
    case "top":
      x1 = ax - textWidth / 2; y1 = ay;
      x2 = ax + textWidth / 2; y2 = ay + textHeight;
      break;
    case "bottom":
      x1 = ax - textWidth / 2; y1 = ay - textHeight;
      x2 = ax + textWidth / 2; y2 = ay;
      break;
    case "left":
      x1 = ax; y1 = ay - textHeight / 2;
      x2 = ax + textWidth; y2 = ay + textHeight / 2;
      break;
    case "right":
      x1 = ax - textWidth; y1 = ay - textHeight / 2;
      x2 = ax; y2 = ay + textHeight / 2;
      break;
    case "top-left":
      x1 = ax; y1 = ay;
      x2 = ax + textWidth; y2 = ay + textHeight;
      break;
    case "top-right":
      x1 = ax - textWidth; y1 = ay;
      x2 = ax; y2 = ay + textHeight;
      break;
    case "bottom-left":
      x1 = ax; y1 = ay - textHeight;
      x2 = ax + textWidth; y2 = ay;
      break;
    case "bottom-right":
      x1 = ax - textWidth; y1 = ay - textHeight;
      x2 = ax; y2 = ay;
      break;
    default:
      x1 = ax - textWidth / 2; y1 = ay - textHeight / 2;
      x2 = ax + textWidth / 2; y2 = ay + textHeight / 2;
  }

  return {x1, y1, x2, y2};
}

function forcedLabelBoxesOverlapCircle(box, circle, extra = 0) {
  const nearestX = Math.max(box.x1, Math.min(circle.x, box.x2));
  const nearestY = Math.max(box.y1, Math.min(circle.y, box.y2));
  const dx = nearestX - circle.x;
  const dy = nearestY - circle.y;
  return Math.hypot(dx, dy) <= circle.radius + extra;
}

function forcedLabelFitsViewport(box, width, height, margin = 8) {
  return (
    box.x1 >= margin &&
    box.y1 >= margin &&
    box.x2 <= width - margin &&
    box.y2 <= height - margin
  );
}

function forcedLabelAnchorOrder(dx, dy) {
  // Choose the direction opposite to the nearest cluster first.
  const angle = Math.atan2(dy, dx) + Math.PI;
  const anchors = [
    ["top", -Math.PI / 2],
    ["top-right", -Math.PI / 4],
    ["right", 0],
    ["bottom-right", Math.PI / 4],
    ["bottom", Math.PI / 2],
    ["bottom-left", (3 * Math.PI) / 4],
    ["left", Math.PI],
    ["top-left", -(3 * Math.PI) / 4]
  ];

  const normalizeAngle = value => {
    let a = value;
    while (a > Math.PI) a -= Math.PI * 2;
    while (a < -Math.PI) a += Math.PI * 2;
    return a;
  };

  return anchors
    .map(([anchor, anchorAngle], index) => ({
      anchor,
      index,
      distance: Math.abs(normalizeAngle(anchorAngle - angle))
    }))
    .sort((a, b) => a.distance - b.distance || a.index - b.index)
    .map(item => item.anchor);
}

function updateForcedSettlementLabelPositions() {
  if (!state.map || !state.map.getSource("forced-settlement-labels") || !state.map.getLayer("forced-settlement-labels")) {
    return;
  }

  if (state.map.getZoom() < 9 || !state.forcedSettlementFeatures.length) return;

  const clusterLayers = categories
    .map(cat => makeClusterLayerId(cat.id))
    .filter(id => state.map.getLayer(id));

  const clusters = clusterLayers.length
    ? state.map.queryRenderedFeatures({layers: clusterLayers})
    : [];

  const clusterCircles = clusters.map(feature => {
    const point = state.map.project(feature.geometry.coordinates);
    return {
      x: point.x,
      y: point.y,
      radius: forcedLabelClusterRadius(feature.properties?.point_count) + 6
    };
  });

  const zoom = state.map.getZoom();
  const textSize = forcedLabelTextSize();
  const viewportWidth = state.map.getContainer().clientWidth;
  const viewportHeight = state.map.getContainer().clientHeight;

  const updated = state.forcedSettlementFeatures.map(feature => {
    const name = String(feature.properties?.name || "");
    const point = state.map.project(feature.geometry.coordinates);
    const textWidth = Math.min(name.length * textSize * 0.56 + 6, textSize * 11);
    const textHeight = textSize * 1.1;

    // No collision: keep the original visual position (bottom, zero offset).
    const conflicts = clusterCircles
      .map(circle => ({
        circle,
        dx: circle.x - point.x,
        dy: circle.y - point.y,
        distance: Math.hypot(circle.x - point.x, circle.y - point.y)
      }))
      .filter(item => item.distance <= item.circle.radius + Math.max(textWidth, textHeight));

    let anchor = "bottom";
    let radialOffsetEm = 0;

    if (conflicts.length) {
      const nearest = conflicts.reduce((best, current) =>
        current.distance < best.distance ? current : best
      );

      const anchors = forcedLabelAnchorOrder(nearest.dx, nearest.dy);
      const radialOffsetsEm = [0, 0.45, 0.8, 1.15, 1.5, 2.0, 2.5, 3.0, 3.5];
      let chosen = null;

      for (const candidateAnchor of anchors) {
        for (const candidateOffsetEm of radialOffsetsEm) {
          const box = forcedLabelTextBox(
            point,
            candidateAnchor,
            textWidth,
            textHeight,
            candidateOffsetEm * textSize
          );

          const clashesCluster = conflicts.some(item =>
            forcedLabelBoxesOverlapCircle(box, item.circle, 2)
          );

          if (!clashesCluster && forcedLabelFitsViewport(box, viewportWidth, viewportHeight, 8)) {
            chosen = {anchor: candidateAnchor, radialOffsetEm: candidateOffsetEm};
            break;
          }
        }
        if (chosen) break;
      }

      // There can be no completely free position at the very edge of the
      // viewport. In that case, keep the label visible and use a safe side
      // with the smallest estimated overlap rather than hiding it.
      if (!chosen) {
        const fallbackCandidates = [];
        for (const candidateAnchor of anchors) {
          for (const candidateOffsetEm of [1.5, 2.0, 2.5, 3.0, 3.5]) {
            const box = forcedLabelTextBox(
              point,
              candidateAnchor,
              textWidth,
              textHeight,
              candidateOffsetEm * textSize
            );
            const overlapScore = conflicts.reduce((score, item) => {
              const nearestX = Math.max(box.x1, Math.min(item.circle.x, box.x2));
              const nearestY = Math.max(box.y1, Math.min(item.circle.y, box.y2));
              const d = Math.hypot(nearestX - item.circle.x, nearestY - item.circle.y);
              return score + Math.max(0, item.circle.radius + 2 - d);
            }, 0);
            const viewportPenalty =
              Math.max(0, 8 - box.x1) +
              Math.max(0, 8 - box.y1) +
              Math.max(0, box.x2 - viewportWidth + 8) +
              Math.max(0, box.y2 - viewportHeight + 8);
            fallbackCandidates.push({anchor: candidateAnchor, radialOffsetEm: candidateOffsetEm, score: overlapScore + viewportPenalty * 2});
          }
        }
        fallbackCandidates.sort((a, b) => a.score - b.score);
        chosen = fallbackCandidates[0] || {anchor:"bottom", radialOffsetEm:0};
      }

      anchor = chosen.anchor;
      radialOffsetEm = chosen.radialOffsetEm;
    }

    return {
      ...feature,
      properties: {
        ...feature.properties,
        text_anchor: anchor,
        text_radial_offset: Number(radialOffsetEm.toFixed(2))
      }
    };
  });

  state.forcedSettlementFeatures = updated;
  state.map.getSource("forced-settlement-labels").setData({
    type: "FeatureCollection",
    features: updated
  });

  console.debug("Labels de communes recalculados", {
    zoom: Number(zoom.toFixed(2)),
    clusters: clusterCircles.length
  });
}

function scheduleForcedSettlementLabelLayout(delay = 70) {
  if (!state.map || !state.map.getLayer("forced-settlement-labels")) return;

  if (state.forcedSettlementLayoutTimer) {
    clearTimeout(state.forcedSettlementLayoutTimer);
  }

  state.forcedSettlementLayoutTimer = setTimeout(() => {
    state.forcedSettlementLayoutTimer = null;
    if (!state.map || !state.map.getLayer("forced-settlement-labels")) return;
    requestAnimationFrame(() => updateForcedSettlementLabelPositions());
  }, delay);
}

function addForcedSettlementLabels() {
  if (!state.map) return;

  const sourceId = "forced-settlement-labels";
  const layerId = "forced-settlement-labels";

  const features = FORCED_SETTLEMENTS.map(place => ({
    type: "Feature",
    id: `forced-settlement-${place.name}`,
    geometry: {
      type: "Point",
      coordinates: [place.longitude, place.latitude]
    },
    properties: {
      name: place.name,
      class: "settlement",
      worldview: "all",
      symbolrank: place.symbolrank,
      filterrank: place.filterrank,
      text_anchor: "bottom",
      text_radial_offset: 0,
      capital: 0
    }
  }));

  state.forcedSettlementFeatures = features;

  if (!state.map.getSource(sourceId)) {
    state.map.addSource(sourceId, {
      type: "geojson",
      data: {
        type: "FeatureCollection",
        features
      }
    });
  }

  if (!state.map.getLayer(layerId)) {
    state.map.addLayer({
      id: layerId,
      type: "symbol",
      source: sourceId,
      minzoom: 10.5,
      maxzoom: 22,

      layout: {
        "text-line-height": 1.1,

        // ===== CUSTOM TYPOGRAPHY =====
        // Increase/decrease these values to change the size of the 16 towns.
        "text-size": [
          "interpolate",
          ["linear"],
          ["zoom"],
          9, 16,
          13, 18,
          18, 20,
          22, 22
        ],

        // Position is decided per town by updateForcedSettlementLabelPositions().
        "text-anchor": ["get", "text_anchor"],
        "text-radial-offset": ["get", "text_radial_offset"],
        "symbol-sort-key": ["get", "symbolrank"],
        "icon-image": "",
        "text-font": [
          "DIN Pro Regular",
          "Arial Unicode MS Regular"
        ],
        "text-field": ["get", "name"],
        "text-max-width": 11,
        "text-allow-overlap": true,
        "text-ignore-placement": true,
        "text-padding": 2
      },

      paint: {
        // ===== CUSTOM COLOR =====
        // Change this one value to change the color of the 16 towns.
        "text-color": "#000",
        "text-halo-color": "#FFFFFF",
        "text-halo-width": 1.5,
        "text-halo-blur": 0.5
      }
    });
  }

  if (state.map.getLayer(layerId)) {
    state.map.setLayerZoomRange(layerId, 10.5, 22);
  }

  // Deterministic replacement:
  // keep our custom label from zoom 9 through 22 and remove those same
  // names from the original Mapbox label layer to prevent duplicates.
  const originalLayerId = "settlement-minor-label";

  if (state.map.getLayer(originalLayerId)) {
    const names = FORCED_SETTLEMENTS.map(place => place.name);
    const currentFilter = state.map.getFilter(originalLayerId);

    const excludeForcedNames = [
      "!",
      [
        "match",
        ["get", "name"],
        names,
        true,
        false
      ]
    ];

    state.map.setFilter(
      originalLayerId,
      currentFilter
        ? ["all", currentFilter, excludeForcedNames]
        : excludeForcedNames
    );
  }

  scheduleForcedSettlementLabelLayout(120);
}

function initMap() {
  // Keep Mapbox initialization isolated from data loading.
  // A layer/source error must never prevent the CSV diagnostic from running.
  try {
    state.map = new mapboxgl.Map({
      container: "map",
      style: mapbox.style,
      center: mapbox.center,
      zoom: Math.max(Number(mapbox.zoom) || 0, 10.5),
      minZoom: 10.5,
      attributionControl: true,
      cooperativeGestures: false
    });

    // IMPORTANT: minzoom on a layer only controls that layer's visibility.
    // minZoom here controls the map itself, preventing zooming out below 11.
    state.map.setMinZoom(10.5);

    state.map.on("load", () => {
      state.diagnostics.mapbox = "ok";
      updateDiagnostics();

      // Start data loading immediately. Layers are attempted independently.
      loadAllData();

      try {
        buildMapLayers();
        addForcedSettlementLabels();

        state.map.on("moveend", () => scheduleForcedSettlementLabelLayout(40));
        state.map.on("zoomend", () => scheduleForcedSettlementLabelLayout(40));

        state.diagnostics.layers = "ok";
        updateSources();
        updateVisibility();
      } catch (error) {
        state.diagnostics.layers = "error";
        console.error("Erreur de construction des layers Mapbox:", error);
        showToast("Les données sont chargées, mais une layer Mapbox a rencontré une erreur.");
      }

      updateDiagnostics();
    });

    state.map.on("error", event => {
      console.error("Mapbox error:", event?.error || event);
      state.diagnostics.mapbox = "error";
      updateDiagnostics();
    });

    state.map.on("click", e => {
      const clusterLayers = categories
        .map(cat => makeClusterLayerId(cat.id))
        .filter(id => state.map.getLayer(id));

      const clusters = clusterLayers.length
        ? state.map.queryRenderedFeatures(e.point, {layers: clusterLayers})
        : [];

      if (clusters.length) {
        const layerId = clusters[0].layer.id;
        const cat = categories.find(c => makeClusterLayerId(c.id) === layerId);
        const source = cat ? state.map.getSource(makeSourceId(cat.id)) : null;
        const clusterId = clusters[0].properties?.cluster_id;

        if (source && clusterId !== undefined) {
          source.getClusterExpansionZoom(clusterId, (err, zoom) => {
            if (!err) {
              state.map.easeTo({
                center: clusters[0].geometry.coordinates,
                zoom
              });
            }
          });
        }
        return;
      }

      const pointLayers = categories.flatMap(c =>
        c.subcategories.map(s => makePointLayerId(s.id))
      ).filter(id => state.map.getLayer(id));

      if (!pointLayers.length) return;

      const features = state.map.queryRenderedFeatures(e.point, {
        layers: pointLayers
      });

      if (features.length) showPopup(features[0].properties, e.lngLat);
    });

    state.map.on("mouseenter", () => {
      state.map.getCanvas().style.cursor = "pointer";
    });
    state.map.on("mouseleave", () => {
      state.map.getCanvas().style.cursor = "";
    });

    state.diagnostics.mapbox = "initializing";
    updateDiagnostics();
  } catch (error) {
    state.diagnostics.mapbox = "error";
    console.error("Impossible d'initialiser Mapbox:", error);
    updateDiagnostics();
    // Data can still be loaded and diagnosed even if Mapbox initialization fails.
    loadAllData();
  }
}

function buildMapLayers() {
  categories.forEach(cat => {
    const sourceId = makeSourceId(cat.id);

    // IMPORTANT: one source for the whole category.
    state.map.addSource(sourceId, {
      type: "geojson",
      data: {type:"FeatureCollection", features:[]},
      cluster: true,
      // Keep clusters while zooming in. Individual points only take over
      // after this zoom level.
      clusterMaxZoom: 17,
      clusterRadius: 48
    });

    state.map.addLayer({
      id: makeClusterLayerId(cat.id),
      type: "circle",
      source: sourceId,
      filter: ["has","point_count"],
      paint: {
        "circle-color": cat.color,
        "circle-radius": ["step", ["get","point_count"], 19, 10, 22, 30, 26, 100, 31],
        "circle-stroke-color": "#fff",
        "circle-stroke-width": 3,
        "circle-opacity": 0.96
      }
    });

    state.map.addLayer({
      id: makeClusterCountLayerId(cat.id),
      type: "symbol",
      source: sourceId,
      filter: ["has","point_count"],
      layout: {
        "text-field": "{point_count_abbreviated}",
        "text-font": ["Open Sans Bold"],
        "text-size": 10.5
      },
      paint: {"text-color":"#fff"}
    });

    // Points of different subcategories share the category source.
    // Their own layers preserve individual filtering.
    cat.subcategories.forEach(sub => {
      state.map.addLayer({
        id: makePointLayerId(sub.id),
        type: "circle",
        source: sourceId,
        filter: ["all", ["!",["has","point_count"]], ["==",["get","subcategoryId"],sub.id]],
        paint: {
          "circle-color": cat.color,
          "circle-radius": 8,
          "circle-stroke-color": "#fff",
          "circle-stroke-width": 3
        }
      });
    });
  });
}

// -----------------------------------------------------------------------------
// FAST DATA LOADING
// -----------------------------------------------------------------------------
// Google Sheets remains the source of truth. The optimization only changes
// how the 53 CSV sources are fetched: several requests run in parallel instead
// of one after another. A short session cache avoids downloading the same CSVs
// again during the same browser session. The refresh button bypasses the cache
// and requests fresh data from Google Sheets.
const CSV_CONCURRENCY = 8;
const CSV_CACHE_TTL_MS = 5 * 60 * 1000;
const CSV_CACHE_PREFIX = "services-equipements-csv-v2:";

function csvCacheKey(meta) {
  return `${CSV_CACHE_PREFIX}${meta.id}`;
}

function readCsvCache(meta) {
  try {
    const raw = sessionStorage.getItem(csvCacheKey(meta));
    if (!raw) return null;

    const cached = JSON.parse(raw);
    if (!cached || !cached.savedAt || !Array.isArray(cached.rows)) {
      sessionStorage.removeItem(csvCacheKey(meta));
      return null;
    }

    if (Date.now() - cached.savedAt > CSV_CACHE_TTL_MS) {
      sessionStorage.removeItem(csvCacheKey(meta));
      return null;
    }

    return cached.rows;
  } catch {
    return null;
  }
}

function writeCsvCache(meta, rows) {
  try {
    const payload = JSON.stringify({
      savedAt: Date.now(),
      rows
    });

    // Do not let a very large sheet break loading because of storage limits.
    if (payload.length > 700000) return;

    sessionStorage.setItem(csvCacheKey(meta), payload);
  } catch {
    // Cache is an optimization only; ignore storage failures.
  }
}

function parseCsvRows(csvText, meta) {
  if (!csvText.trim()) return [];

  const results = Papa.parse(csvText, {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: header => String(header ?? "").replace(/^\uFEFF/, "").trim()
  });

  if (results.errors?.length) {
    console.warn(`CSV warnings: ${meta.name}`, results.errors);
  }

  return results.data || [];
}

async function fetchCsv(meta, {forceRefresh = false} = {}) {
  if (!forceRefresh) {
    const cachedRows = readCsvCache(meta);
    if (cachedRows) {
      return {rows: cachedRows, cached: true};
    }
  }

  const baseUrl = meta.csv;
  let lastError = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const url = forceRefresh
      ? `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}_=${Date.now()}_${attempt}`
      : baseUrl;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    try {
      const response = await fetch(url, {
        method: "GET",
        mode: "cors",
        cache: forceRefresh ? "no-store" : "default",
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} — ${response.statusText}`);
      }

      const csvText = await response.text();
      const rows = parseCsvRows(csvText, meta);

      writeCsvCache(meta, rows);
      return {rows, cached: false};
    } catch (error) {
      lastError = error?.name === "AbortError"
        ? new Error("Timeout après 15 secondes")
        : error;

      if (attempt < 2) {
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError || new Error("Erreur inconnue");
}

async function loadAllData(forceRefresh = false) {
  if (state.loading) return;

  const startedAt = performance.now();

  state.loading = true;
  state.records = [];
  state.bySubcategory.clear();
  state.sourceStatus.clear();

  const sources = categories.flatMap(category =>
    category.subcategories.map(sub => ({
      category,
      meta: state.subcategoryMeta.get(sub.id)
    }))
  );

  state.diagnostics.total = sources.length;
  state.diagnostics.loaded = 0;
  state.diagnostics.sources = "loading";
  showLoading(true, sources.length);
  updateDiagnostics();

  let nextIndex = 0;
  let completed = 0;

  async function worker() {
    while (true) {
      const index = nextIndex++;
      if (index >= sources.length) return;

      const {category, meta} = sources[index];
      updateLoadingProgress(completed, sources.length, meta, "loading");

      try {
        const result = await fetchCsv(meta, {forceRefresh});
        const rows = result.rows;
        const records = rows
          .map((row, rowIndex) => normalizeRow(row, meta, rowIndex))
          .filter(Boolean);

        state.bySubcategory.set(meta.id, records);
        state.sourceStatus.set(meta.id, {
          status: "ok",
          rows: rows.length,
          valid: records.length,
          meta,
          category,
          cached: result.cached
        });

        completed += 1;
        state.diagnostics.loaded = completed;
        updateLoadingProgress(
          completed,
          sources.length,
          meta,
          "ok",
          records.length,
          null,
          rows.length
        );
        updateDiagnostics();
      } catch (error) {
        console.error(`Erreur CSV ${meta.name}`, error);

        state.bySubcategory.set(meta.id, []);
        state.sourceStatus.set(meta.id, {
          status: "error",
          rows: 0,
          valid: 0,
          meta,
          category,
          error: error?.message || String(error)
        });

        completed += 1;
        state.diagnostics.loaded = completed;
        updateLoadingProgress(
          completed,
          sources.length,
          meta,
          "error",
          0,
          error
        );
        updateDiagnostics();
      }
    }
  }

  const workerCount = Math.min(CSV_CONCURRENCY, sources.length);
  await Promise.all(
    Array.from({length: workerCount}, () => worker())
  );

  // Restore the original source/category order for stable results.
  state.records = sources.flatMap(({meta}) =>
    state.bySubcategory.get(meta.id) || []
  );

  state.diagnostics.sources = "ok";

  renderFilters();
  renderLegend();
  renderStats();
  renderResults();

  if (state.map?.isStyleLoaded?.()) {
    try {
      updateSources();
      updateVisibility();
      scheduleForcedSettlementLabelLayout(100);
    } catch (error) {
      state.diagnostics.layers = "error";
      console.error("Erreur ao atualizar sources/layers:", error);
    }
  }

  updateDiagnostics();
  showLoading(false);

  const elapsed = Math.round(performance.now() - startedAt);
  console.info(
    `Chargement des ${sources.length} sources terminé en ${elapsed} ms ` +
    `(${forceRefresh ? "refresh réseau" : "cache/réseau"}).`
  );

  const failed = [...state.sourceStatus.values()].filter(s => s.status === "error");

  if (failed.length) {
    const names = failed.map(r => r.meta.name).slice(0, 3).join(", ");
    const suffix = failed.length > 3 ? "…" : "";
    showToast(`${state.records.length} services · ${failed.length} source(s) en erreur : ${names}${suffix}`);

    console.group("Diagnostic des sources Google Sheets");
    failed.forEach(r => console.error(r.meta.name, r.error));
    console.groupEnd();
  } else {
    showToast(`${state.records.length} services chargés depuis ${sources.length} sources.`);
  }

  state.loading = false;
}

function updateSources() {
  if (!state.map) return;

  categories.forEach(cat => {
    const source = state.map.getSource(makeSourceId(cat.id));
    if (!source) return;

    // The category source contains ONLY currently selected subcategories.
    // Therefore Mapbox's cluster engine counts the selected children together.
    const features = cat.subcategories
      .filter(sub => state.subcategoryEnabled.get(sub.id) === true)
      .flatMap(sub => state.bySubcategory.get(sub.id) || [])
      .map(recordToFeature);

    source.setData({
      type: "FeatureCollection",
      features
    });
  });

  scheduleForcedSettlementLabelLayout(80);
}

function renderFilters() {
  const categoryContainer = $("#categoryFilters");
  const subContainer = $("#subcategoryFilters");

  categoryContainer.innerHTML = "";

  // Compatibility: if an older index.html still contains the standalone
  // "Sous-catégories" section, remove it because subcategories are now
  // rendered directly under their parent category.
  if (subContainer) {
    const section = subContainer.closest(".filter-section");
    if (section) {
      section.remove();
    } else {
      subContainer.innerHTML = "";
    }
  }

  categories.forEach(cat => {
    const total = cat.subcategories.reduce(
      (sum, s) => sum + (state.bySubcategory.get(s.id)?.length || 0), 0
    );

    const enabledSubs = cat.subcategories.filter(
      s => state.subcategoryEnabled.get(s.id) === true
    );
    const allSubs = enabledSubs.length === cat.subcategories.length;
    const someSubs = enabledSubs.length > 0 && !allSubs;

    const row = document.createElement("div");
    row.className = "category-row";
    row.innerHTML = `
      <input type="checkbox"
        ${allSubs ? "checked" : ""}
        data-category="${cat.id}"
        aria-label="Activer ${escapeHtml(cat.name)}">
      <span class="category-dot" style="background:${cat.color}">${iconSvg(cat.subcategories[0]?.icon)}</span>
      <span class="category-label">${cat.number} ${escapeHtml(cat.name)}</span>
      <span class="count">${total}</span>
      <button type="button"
        class="expand-btn"
        data-expand="${cat.id}"
        aria-expanded="false"
        aria-controls="subcategory-list-${cat.id}">
        <i data-lucide="chevron-down"></i>
      </button>
    `;

    const categoryInput = row.querySelector("[data-category]");
    categoryInput.checked = allSubs;
    categoryInput.indeterminate = someSubs;

    const categoryGroup = document.createElement("div");
    categoryGroup.className = "category-group";
    categoryGroup.appendChild(row);

    const subList = document.createElement("div");
    subList.id = `subcategory-list-${cat.id}`;
    subList.className = "subcategory-list";
    subList.dataset.subList = cat.id;
    subList.style.display = "none";

    cat.subcategories.forEach(sub => {
      const count = state.bySubcategory.get(sub.id)?.length || 0;
      const subRow = document.createElement("label");
      subRow.className = "subcategory-row";
      subRow.innerHTML = `
        <input type="checkbox"
          ${state.subcategoryEnabled.get(sub.id) === true ? "checked" : ""}
          data-subcategory="${sub.id}"
          data-category="${cat.id}">
        <span class="category-dot" style="background:${cat.color}">${iconSvg(sub.icon)}</span>
        <span class="category-label">${escapeHtml(sub.name)}</span>
        <span class="count">${count}</span>
      `;
      subList.appendChild(subRow);
    });

    categoryGroup.appendChild(subList);
    categoryContainer.appendChild(categoryGroup);

    state.categoryEnabled.set(cat.id, enabledSubs.length > 0);
  });

  lucide.createIcons();
  wireFilterEvents();
}

function syncCategoryCheckbox(catId) {
  const cat = categories.find(c => c.id === catId);
  if (!cat) return;

  const inputs = cat.subcategories.map(sub =>
    document.querySelector(`#categoryFilters [data-subcategory="${CSS.escape(sub.id)}"]`)
  ).filter(Boolean);

  const checked = inputs.filter(input => input.checked).length;
  const parent = document.querySelector(`#categoryFilters [data-category="${CSS.escape(catId)}"]`);

  if (parent) {
    parent.checked = checked === inputs.length && inputs.length > 0;
    parent.indeterminate = checked > 0 && checked < inputs.length;
  }

  state.categoryEnabled.set(catId, checked > 0);
}

function wireFilterEvents() {
  const categoryContainer = $("#categoryFilters");

  // Both category and subcategory controls now live inside #categoryFilters.
  categoryContainer.onchange = event => {
    const subInput = event.target.closest("[data-subcategory]");

    if (subInput) {
      const subId = subInput.dataset.subcategory;
      const catId = subInput.dataset.category;
      if (!subId || !catId) return;

      state.subcategoryEnabled.set(subId, subInput.checked);
      syncCategoryCheckbox(catId);

      updateSources();
      updateVisibility();
      renderStats();
      renderResults();
      return;
    }

    const categoryInput = event.target.closest("[data-category]");
    if (!categoryInput) return;

    const catId = categoryInput.dataset.category;
    const cat = categories.find(c => c.id === catId);
    if (!cat) return;

    const group = categoryInput.closest(".category-group");
    const children = group
      ? group.querySelectorAll("[data-subcategory]")
      : [];

    cat.subcategories.forEach(sub => {
      state.subcategoryEnabled.set(sub.id, categoryInput.checked);
    });

    children.forEach(child => {
      child.checked = categoryInput.checked;
    });

    categoryInput.indeterminate = false;
    state.categoryEnabled.set(catId, categoryInput.checked);

    updateSources();
    updateVisibility();
    renderStats();
    renderResults();
  };

  categoryContainer.onclick = event => {
    const btn = event.target.closest("[data-expand]");
    const row = event.target.closest(".category-row");

    // The checkbox keeps its normal filtering behavior.
    if (event.target.closest("input")) return;

    if (!btn && !row) return;

    event.preventDefault();

    const catId =
      btn?.dataset.expand ||
      row?.querySelector("[data-expand]")?.dataset.expand;

    if (!catId) return;

    const currentRow = row;
    const list = categoryContainer.querySelector(
      `[data-sub-list="${CSS.escape(catId)}"]`
    );

    if (!list || !currentRow) return;

    const isOpen = list.style.display !== "none";
    list.style.display = isOpen ? "none" : "block";
    currentRow.classList.toggle("open", !isOpen);

    const expandButton = currentRow.querySelector("[data-expand]");
    if (expandButton) {
      expandButton.setAttribute("aria-expanded", String(!isOpen));
    }
  };
}

function updateVisibility() {
  if (!state.map) return;

  categories.forEach(cat => {
    const categoryActive = cat.subcategories.some(
      sub => state.subcategoryEnabled.get(sub.id) === true
    );

    [makeClusterLayerId(cat.id), makeClusterCountLayerId(cat.id)].forEach(id => {
      if (state.map.getLayer(id)) {
        state.map.setLayoutProperty(id, "visibility", categoryActive ? "visible" : "none");
      }
    });

    cat.subcategories.forEach(sub => {
      const id = makePointLayerId(sub.id);
      if (state.map.getLayer(id)) {
        state.map.setLayoutProperty(
          id,
          "visibility",
          state.subcategoryEnabled.get(sub.id) === true ? "visible" : "none"
        );
      }
    });
  });
}

function renderLegend() {
  $("#categoryLegend").innerHTML = categories.map(cat => `
    <div class="legend-item"><span class="legend-color" style="background:${cat.color}"></span>${cat.number} ${escapeHtml(cat.name)}</div>
  `).join("");

  $("#iconLegend").innerHTML = categories.flatMap(c => c.subcategories).slice(0,16).map(sub => `
    <div class="icon-item" title="${escapeHtml(sub.name)}">${iconSvg(sub.icon)}</div>
  `).join("");
  lucide.createIcons();
}

function renderStats() {
  const activeRecords = state.records.filter(r => state.subcategoryEnabled.get(r.subcategoryId));
  const total = activeRecords.length;
  const cards = [`<div class="stat-card total-card"><div class="stat-top"><span>Total des services</span></div><div class="stat-value">${total}</div><div class="stat-sub">dans cette zone</div></div>`];

  categories.forEach(cat => {
    const count = activeRecords.filter(r=>r.categoryId===cat.id).length;
    cards.push(`
      <div class="stat-card">
        <div class="stat-top"><span class="stat-icon" style="background:${cat.color}">${iconSvg(cat.subcategories[0]?.icon)}</span><span>${escapeHtml(cat.name)}</span></div>
        <div class="stat-value">${count}</div>
      </div>
    `);
  });
  $("#statsRow").innerHTML = cards.join("");
}

function renderResults() {
  const activeRecords = state.records.filter(r => state.subcategoryEnabled.get(r.subcategoryId));
  const search = state.search.trim().toLowerCase();
  const filtered = search ? activeRecords.filter(r => [r.name,r.address,r.city,r.subcategoryName,r.categoryName].join(" ").toLowerCase().includes(search)) : activeRecords;
  const results = filtered.slice(0,5);

  $("#resultsTitle").textContent = `Résultats (${filtered.length} services)`;
  $("#resultsList").innerHTML = results.map(r => `
    <article class="result-card" data-result-id="${escapeHtml(r.id)}">
      <div class="result-icon" style="background:${r.categoryColor}">${iconSvg(r.subcategoryIcon)}</div>
      <div class="result-main">
        <div class="result-name">${escapeHtml(r.name)}</div>
        <div class="result-meta" style="color:${r.categoryColor}">${escapeHtml(r.subcategoryName)}</div>
        <div class="result-address">${escapeHtml([r.address,r.postalCode,r.city].filter(Boolean).join(", "))}</div>
        <div class="result-phone">${escapeHtml(r.phone)}</div>
      </div>
    </article>
  `).join("") || `<div class="result-card"><div class="result-main"><div class="result-name">Aucun résultat</div></div></div>`;

  document.querySelectorAll("[data-result-id]").forEach(card => {
    card.addEventListener("click", () => {
      const r = state.records.find(x=>x.id===card.dataset.resultId);
      if (!r) return;
      state.map.flyTo({center:[r.longitude,r.latitude],zoom:15,duration:800});
      showPopup(r, {lng:r.longitude,lat:r.latitude});
    });
  });
}

function showPopup(r, lngLat) {
  const address = [r.address,r.postalCode,r.city].filter(Boolean).join(", ");
  const website = r.website ? String(r.website).trim() : "";
  const websiteUrl = website && /^https?:\/\//i.test(website) ? website : (website ? `https://${website}` : "");

  const safeDescription = escapeHtml(r.description || "")
    .replace(/&lt;br\s*\/?&gt;/gi, "<br>");

  const html = `
    <div class="popup">
      <div class="popup-head">
        <div class="popup-icon" style="background:${r.categoryColor}">${iconSvg(r.subcategoryIcon)}</div>
        <div>
          <div class="popup-name">${escapeHtml(r.name)}</div>
          <div class="popup-category" style="color:${r.categoryColor}">${escapeHtml(r.subcategoryName)} · ${escapeHtml(r.categoryName)}</div>
        </div>
      </div>
      <div class="popup-body">
        ${address ? `<div class="popup-line"><i data-lucide="map-pin"></i><span>${escapeHtml(address)}</span></div>` : ""}
        ${r.phone ? `<div class="popup-line"><i data-lucide="phone"></i><span>${escapeHtml(r.phone)}</span></div>` : ""}
        ${r.email ? `<div class="popup-line"><i data-lucide="mail"></i><span>${escapeHtml(r.email)}</span></div>` : ""}
        ${r.description ? `<div class="popup-line"><i data-lucide="align-left"></i><span>${safeDescription}</span></div>` : ""}
        ${websiteUrl ? `<a class="popup-link" style="color:${r.categoryColor}" href="${escapeHtml(websiteUrl)}" target="_blank" rel="noopener"><i data-lucide="external-link"></i> Visiter le site</a>` : ""}
      </div>
    </div>
  `;

  new mapboxgl.Popup({offset:16,maxWidth:"320px"}).setLngLat(lngLat).setHTML(html).addTo(state.map);
  setTimeout(()=>lucide.createIcons(),0);
}

function updateDiagnostics() {
  const mapboxEl = document.querySelector("#diagMapbox");
  const sourcesEl = document.querySelector("#diagSources");
  const layersEl = document.querySelector("#diagLayers");

  const icon = status =>
    status === "ok" ? "✓" :
    status === "error" ? "×" :
    status === "loading" || status === "initializing" ? "…" : "—";

  if (mapboxEl) mapboxEl.textContent = `${icon(state.diagnostics.mapbox)} Mapbox`;
  if (sourcesEl) sourcesEl.textContent =
    `${state.diagnostics.loaded} / ${state.diagnostics.total} sources`;
  if (layersEl) layersEl.textContent = `${icon(state.diagnostics.layers)} Layers`;

  const detail = document.querySelector("#diagDetail");
  if (detail) {
    const failed = [...state.sourceStatus.values()].filter(s => s.status === "error").length;
    detail.textContent = failed
      ? `${failed} source(s) en erreur`
      : `${state.records.length} services`;
  }
}

function showLoading(show, total = 0) {
  $("#loading").classList.toggle("hidden", !show);

  const progress = $("#loadingProgress");
  const list = $("#loadingSources");

  if (!show) {
    if (progress) progress.style.width = "100%";
    return;
  }

  if (progress) progress.style.width = "0%";
  if (list) {
    list.innerHTML = "";
    list.dataset.total = total;
  }

  $("#loadingText").textContent = `0 / ${total} sources Google Sheets`;
}

function updateLoadingProgress(index, total, meta, status, valid = 0, error = null, rawRows = null) {
  const pct = Math.round((index / total) * 100);
  const progress = $("#loadingProgress");
  if (progress) progress.style.width = `${pct}%`;

  const text = $("#loadingText");
  if (text) {
    if (status === "loading") {
      text.textContent = `${index} / ${total} · ${meta.name}`;
    } else if (status === "ok") {
      text.textContent = `${index} / ${total} · ${meta.name} · ${valid} service(s)`;
    } else {
      text.textContent = `${index} / ${total} · ${meta.name} · erreur`;
    }
  }

  const list = $("#loadingSources");
  if (!list) return;

  let row = list.querySelector(`[data-loading-source="${CSS.escape(meta.id)}"]`);
  if (!row) {
    row = document.createElement("div");
    row.dataset.loadingSource = meta.id;
    row.className = "loading-source";
    row.innerHTML = `
      <span class="loading-status"></span>
      <span class="loading-source-name"></span>
      <span class="loading-source-count"></span>
    `;
    list.appendChild(row);
  }

  row.querySelector(".loading-source-name").textContent = meta.name;
  row.querySelector(".loading-status").textContent =
    status === "loading" ? "…" : status === "ok" ? "✓" : "×";
  row.querySelector(".loading-source-count").textContent =
    status === "ok" ? String(valid) : status === "error" ? "ERR" : "";

  row.classList.remove("is-loading", "is-ok", "is-error");
  row.classList.add(
    status === "loading" ? "is-loading" :
    status === "ok" ? "is-ok" : "is-error"
  );

  if (error) row.title = error?.message || String(error);
}

function showToast(text) {
  const el = $("#toast");
  el.textContent = text;
  el.classList.remove("hidden");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(()=>el.classList.add("hidden"),3000);
}

function setupUI() {
  $("#zoomIn").onclick = () => state.map?.zoomIn();
  $("#zoomOut").onclick = () => state.map?.zoomOut();
  $("#resetView").onclick = () => state.map?.flyTo({center:mapbox.center,zoom:mapbox.zoom});
  $("#refreshBtn").onclick = () => loadAllData(true);

  $("#toggleFilters").onclick = () => $(".sidebar").classList.toggle("open");
  $("#collapseSidebar").onclick = () => $(".sidebar").classList.toggle("open");

  $("#toggleLegend").onclick = () => {
    const body = $("#legendBody");
    body.classList.toggle("hidden");
    $("#toggleLegend").innerHTML = body.classList.contains("hidden")
      ? '<i data-lucide="chevron-down"></i>'
      : '<i data-lucide="chevron-up"></i>';
    lucide.createIcons();
  };

  $("#searchInput").addEventListener("input", e => {
    state.search = e.target.value;
    $("#clearSearch").classList.toggle("hidden", !state.search);
    renderResults();
    renderSearchResults();
  });
  $("#clearSearch").onclick = () => {
    $("#searchInput").value = "";
    state.search = "";
    $("#clearSearch").classList.add("hidden");
    renderResults();
    renderSearchResults();
  };

  $("#allCategories").addEventListener("change", e => {
    const checked = e.target.checked;

    categories.forEach(cat => {
      state.categoryEnabled.set(cat.id, checked);

      cat.subcategories.forEach(sub => {
        state.subcategoryEnabled.set(sub.id, checked);

        const child = document.querySelector(
          `#categoryFilters [data-subcategory="${CSS.escape(sub.id)}"]`
        );
        if (child) child.checked = checked;
      });

      const parent = document.querySelector(
        `#categoryFilters [data-category="${CSS.escape(cat.id)}"]`
      );
      if (parent) {
        parent.checked = checked;
        parent.indeterminate = false;
      }
    });

    const allSub = $("#allSubcategories");
    if (allSub) {
      allSub.checked = checked;
      allSub.indeterminate = false;
    }

    updateSources();
    updateVisibility();
    renderStats();
    renderResults();
  });

  const allSubcategoriesInput = $("#allSubcategories");

  if (allSubcategoriesInput) {
    allSubcategoriesInput.addEventListener("change", e => {
      const checked = e.target.checked;

      categories.forEach(cat => {
        cat.subcategories.forEach(sub => {
          state.subcategoryEnabled.set(sub.id, checked);

          const child = document.querySelector(
            `#categoryFilters [data-subcategory="${CSS.escape(sub.id)}"]`
          );
          if (child) child.checked = checked;
        });

        state.categoryEnabled.set(cat.id, checked);

        const parent = document.querySelector(
          `#categoryFilters [data-category="${CSS.escape(cat.id)}"]`
        );
        if (parent) {
          parent.checked = checked;
          parent.indeterminate = false;
        }
      });

      const allCat = $("#allCategories");
      if (allCat) {
        allCat.checked = checked;
        allCat.indeterminate = false;
      }

      updateSources();
      updateVisibility();
      renderStats();
      renderResults();
    });
  }

  lucide.createIcons();
}

function renderSearchResults() {
  const box = $("#searchResults");
  const q = state.search.trim().toLowerCase();
  if (!q) { box.classList.add("hidden"); box.innerHTML=""; return; }

  const active = state.records.filter(r => state.subcategoryEnabled.get(r.subcategoryId));
  const results = active.filter(r => [r.name,r.address,r.city,r.subcategoryName,r.categoryName].join(" ").toLowerCase().includes(q)).slice(0,8);

  box.innerHTML = results.map(r=>`
    <div class="search-result" data-search-id="${escapeHtml(r.id)}">
      <div class="search-result-icon" style="background:${r.categoryColor}">${iconSvg(r.subcategoryIcon)}</div>
      <div class="search-result-text">
        <div class="search-result-name">${escapeHtml(r.name)}</div>
        <div class="search-result-meta">${escapeHtml(r.subcategoryName)} · ${escapeHtml(r.city)}</div>
      </div>
    </div>
  `).join("") || `<div class="search-result"><div class="search-result-text"><div class="search-result-name">Aucun résultat</div></div></div>`;
  box.classList.remove("hidden");

  box.querySelectorAll("[data-search-id]").forEach(el => {
    el.addEventListener("click",()=>{
      const r = state.records.find(x=>x.id===el.dataset.searchId);
      if (!r) return;
      $("#searchResults").classList.add("hidden");
      state.map.flyTo({center:[r.longitude,r.latitude],zoom:15,duration:800});
      showPopup(r,{lng:r.longitude,lat:r.latitude});
    });
  });
}

window.addEventListener("DOMContentLoaded", () => {
  setupUI();
  initMap();
});
