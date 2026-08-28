
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
  }
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

function makeSourceId(subId) { return `src-${subId}`; }
function makeClusterLayerId(subId) { return `cluster-${subId}`; }
function makeClusterCountLayerId(subId) { return `cluster-count-${subId}`; }
function makePointLayerId(subId) { return `point-${subId}`; }

function initMap() {
  // Keep Mapbox initialization isolated from data loading.
  // A layer/source error must never prevent the CSV diagnostic from running.
  try {
    state.map = new mapboxgl.Map({
      container: "map",
      style: mapbox.style,
      center: mapbox.center,
      zoom: mapbox.zoom,
      attributionControl: true,
      cooperativeGestures: false
    });

    state.map.on("load", () => {
      state.diagnostics.mapbox = "ok";
      updateDiagnostics();

      // Start data loading immediately. Layers are attempted independently.
      loadAllData();

      try {
        buildMapLayers();
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
    cat.subcategories.forEach(sub => {
      const sourceId = makeSourceId(sub.id);
      state.map.addSource(sourceId, {
        type: "geojson",
        data: {type:"FeatureCollection", features:[]},
        cluster: true,
        clusterMaxZoom: 13,
        clusterRadius: 48
      });

      state.map.addLayer({
        id: makeClusterLayerId(sub.id),
        type: "circle",
        source: sourceId,
        filter: ["has","point_count"],
        paint: {
          "circle-color": cat.color,
          "circle-radius": [
            "step", ["get","point_count"],
            19, 10, 22, 30, 26, 100, 31
          ],
          "circle-stroke-color": "#fff",
          "circle-stroke-width": 3,
          "circle-opacity": 0.96
        }
      });

      state.map.addLayer({
        id: makeClusterCountLayerId(sub.id),
        type: "symbol",
        source: sourceId,
        filter: ["has","point_count"],
        layout: {
          "text-field": "{point_count_abbreviated}",
          "text-font": ["Open Sans Bold"],
          "text-size": 11
        },
        paint: {"text-color":"#fff"}
      });

      // Individual points are deliberately a separate layer for EACH subcategory.
      // Therefore clusters can NEVER combine different subcategories.
      state.map.addLayer({
        id: makePointLayerId(sub.id),
        type: "circle",
        source: sourceId,
        filter: ["!", ["has","point_count"]],
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

async function fetchCsv(meta) {
  const baseUrl = meta.csv;
  let lastError = null;

  // A few published Google Sheets can occasionally fail one request.
  // Retry once before marking the source as failed.
  for (let attempt = 1; attempt <= 2; attempt++) {
    const url = `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}_=${Date.now()}_${attempt}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    try {
      const response = await fetch(url, {
        method: "GET",
        mode: "cors",
        cache: "no-store",
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} — ${response.statusText}`);
      }

      const csvText = await response.text();
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
    } catch (error) {
      lastError = error?.name === "AbortError"
        ? new Error("Timeout après 15 secondes")
        : error;

      if (attempt < 2) {
        await new Promise(resolve => setTimeout(resolve, 400));
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError || new Error("Erreur inconnue");
}

async function loadAllData() {
  if (state.loading) return;

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

  for (let i = 0; i < sources.length; i++) {
    const {category, meta} = sources[i];
    updateLoadingProgress(i, sources.length, meta, "loading");

    try {
      const rows = await fetchCsv(meta);
      const records = rows
        .map((row, index) => normalizeRow(row, meta, index))
        .filter(Boolean);

      state.bySubcategory.set(meta.id, records);
      state.records.push(...records);
      state.sourceStatus.set(meta.id, {
        status: "ok",
        rows: rows.length,
        valid: records.length,
        meta,
        category
      });

      updateLoadingProgress(i + 1, sources.length, meta, "ok", records.length, null, rows.length);
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

      updateLoadingProgress(i + 1, sources.length, meta, "error", 0, error);
    }

    state.diagnostics.loaded = i + 1;
    updateDiagnostics();
  }

  state.diagnostics.sources = "ok";

  // The map may not have loaded yet. Render UI regardless.
  renderFilters();
  renderLegend();
  renderStats();
  renderResults();

  if (state.map?.isStyleLoaded?.()) {
    try {
      updateSources();
      updateVisibility();
    } catch (error) {
      state.diagnostics.layers = "error";
      console.error("Erreur ao atualizar sources/layers:", error);
    }
  }

  updateDiagnostics();
  showLoading(false);

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

  categories.forEach(cat => cat.subcategories.forEach(sub => {
    const source = state.map.getSource(makeSourceId(sub.id));
    if (!source) return;

    const records = state.bySubcategory.get(sub.id) || [];
    source.setData({
      type: "FeatureCollection",
      features: records.map(recordToFeature)
    });
  }));
}

function renderFilters() {
  const categoryContainer = $("#categoryFilters");
  const subContainer = $("#subcategoryFilters");
  categoryContainer.innerHTML = "";
  subContainer.innerHTML = "";

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
      <button type="button" class="expand-btn" data-expand="${cat.id}">
        <i data-lucide="chevron-down"></i>
      </button>
    `;
    categoryContainer.appendChild(row);

    const categoryInput = row.querySelector("[data-category]");
    categoryInput.checked = allSubs;
    categoryInput.indeterminate = someSubs;

    const subList = document.createElement("div");
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

    subContainer.appendChild(subList);

    state.categoryEnabled.set(cat.id, enabledSubs.length > 0);
  });

  lucide.createIcons();
  wireFilterEvents();
}

function syncCategoryCheckbox(catId) {
  const cat = categories.find(c => c.id === catId);
  if (!cat) return;

  const inputs = cat.subcategories.map(sub =>
    document.querySelector(`#subcategoryFilters [data-subcategory="${CSS.escape(sub.id)}"]`)
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
  const subcategoryContainer = $("#subcategoryFilters");

  // Use delegated events and DO NOT rebuild the filter DOM after a
  // subcategory click. Rebuilding was the source of the "everything
  // disappears" behavior because the clicked control was being replaced
  // immediately.
  categoryContainer.onchange = event => {
    const input = event.target.closest("[data-category]");
    if (!input) return;

    const catId = input.dataset.category;
    const cat = categories.find(c => c.id === catId);
    if (!cat) return;

    cat.subcategories.forEach(sub => {
      state.subcategoryEnabled.set(sub.id, input.checked);

      const child = subcategoryContainer.querySelector(
        `[data-subcategory="${CSS.escape(sub.id)}"]`
      );
      if (child) child.checked = input.checked;
    });

    input.indeterminate = false;
    state.categoryEnabled.set(catId, input.checked);

    updateVisibility();
    renderStats();
    renderResults();
  };

  subcategoryContainer.onchange = event => {
    const input = event.target.closest("[data-subcategory]");
    if (!input) return;

    const subId = input.dataset.subcategory;
    const catId = input.dataset.category;
    if (!subId || !catId) return;

    // Change ONLY this subcategory.
    state.subcategoryEnabled.set(subId, input.checked);

    // Parent is derived UI state only.
    syncCategoryCheckbox(catId);

    updateVisibility();
    renderStats();
    renderResults();
  };

  categoryContainer.onclick = event => {
    const btn = event.target.closest("[data-expand]");
    if (!btn) return;

    event.preventDefault();
    const list = subcategoryContainer.querySelector(
      `[data-sub-list="${CSS.escape(btn.dataset.expand)}"]`
    );
    if (list) {
      list.style.display = list.style.display === "none" ? "block" : "none";
    }
  };
}

function updateVisibility() {
  categories.forEach(cat => cat.subcategories.forEach(sub => {
    // Subcategory state is the source of truth. The parent checkbox can be
    // indeterminate when only some children are selected.
    const visible = state.subcategoryEnabled.get(sub.id);
    [makeClusterLayerId(sub.id), makeClusterCountLayerId(sub.id), makePointLayerId(sub.id)].forEach(id => {
      if (state.map.getLayer(id)) {
        state.map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
      }
    });
  }));
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
  $("#refreshBtn").onclick = () => loadAllData();

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
          `#subcategoryFilters [data-subcategory="${CSS.escape(sub.id)}"]`
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

    updateVisibility();
    renderStats();
    renderResults();
  });

  $("#allSubcategories").addEventListener("change", e => {
    const checked = e.target.checked;

    categories.forEach(cat => {
      cat.subcategories.forEach(sub => {
        state.subcategoryEnabled.set(sub.id, checked);

        const child = document.querySelector(
          `#subcategoryFilters [data-subcategory="${CSS.escape(sub.id)}"]`
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

    updateVisibility();
    renderStats();
    renderResults();
  });

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
