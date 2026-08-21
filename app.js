/* Waypoint — Field Guessing Log
   Cooperative local GeoGuessr-style game built on the Google Maps Platform. */

const CUSTOM_KEY = 'waypoint_custom_locations';
const STATS_KEY = 'waypoint_session_stats';
const MAX_STREETVIEW_ATTEMPTS = 6;

let map, guessMap, panorama;
let guessMarker = null;
let actualMarker = null;
let guessLine = null;
let mode = 'streetview';
let currentLocation = null;
let usedIndices = new Set();
let allLocations = [];
let hasGuessed = false;

let stats = loadStats();

function loadStats(){
  try{
    const raw = localStorage.getItem(STATS_KEY);
    if(raw) return JSON.parse(raw);
  }catch(e){}
  return { totalScore:0, rounds:0, best:0 };
}
function saveStats(){
  localStorage.setItem(STATS_KEY, JSON.stringify(stats));
}
function loadCustomLocations(){
  try{
    const raw = localStorage.getItem(CUSTOM_KEY);
    if(raw) return JSON.parse(raw);
  }catch(e){}
  return [];
}
function saveCustomLocations(list){
  localStorage.setItem(CUSTOM_KEY, JSON.stringify(list));
}

function buildLocationList(){
  const base = BASE_LOCATIONS.map(([name,country,lat,lng]) => ({name,country,lat,lng,custom:false}));
  const custom = loadCustomLocations().map(l => ({...l,custom:true}));
  allLocations = base.concat(custom);
}

function haversineKm(lat1,lng1,lat2,lng2){
  const R = 6371;
  const dLat = (lat2-lat1) * Math.PI/180;
  const dLng = (lng2-lng1) * Math.PI/180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
  const c = 2*Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R*c;
}

function scoreFromDistance(km){
  // GeoGuessr-style exponential decay, tuned for a worldwide pool
  const raw = 5000 * Math.exp(-km/2000);
  return Math.max(0, Math.round(raw));
}

/* ---------------- Google Maps callback ---------------- */
function initWaypoint(){
  buildLocationList();
  updateLocCountUI();

  guessMap = new google.maps.Map(document.getElementById('guessMap'), {
    center:{lat:20,lng:0}, zoom:1, minZoom:1,
    disableDefaultUI:true, zoomControl:true, streetViewControl:false,
    mapTypeControl:false, fullscreenControl:false,
    backgroundColor:'#0F1B2B',
    styles:mapDarkStyle()
  });
  guessMap.addListener('click', onGuessMapClick);

  wireUI();
}

function mapDarkStyle(){
  return [
    {elementType:'geometry',stylers:[{color:'#16273B'}]},
    {elementType:'labels.text.fill',stylers:[{color:'#8a94a3'}]},
    {elementType:'labels.text.stroke',stylers:[{color:'#0F1B2B'}]},
    {featureType:'administrative.country',elementType:'geometry.stroke',stylers:[{color:'#3a4a5c'}]},
    {featureType:'water',elementType:'geometry',stylers:[{color:'#0c1826'}]},
    {featureType:'landscape',elementType:'geometry',stylers:[{color:'#1b2e42'}]},
    {featureType:'poi',stylers:[{visibility:'off'}]},
    {featureType:'road',stylers:[{visibility:'off'}]},
    {featureType:'transit',stylers:[{visibility:'off'}]}
  ];
}

/* ---------------- Round flow ---------------- */
function pickNextIndex(){
  if(usedIndices.size >= allLocations.length) usedIndices.clear();
  let idx;
  do{ idx = Math.floor(Math.random()*allLocations.length); }
  while(usedIndices.has(idx));
  usedIndices.add(idx);
  return idx;
}

function startRound(){
  hasGuessed = false;
  clearGuessState();
  document.getElementById('stageLoading').style.display = 'flex';
  document.getElementById('roundChip').style.display = 'none';
  document.getElementById('guessPanel').style.display = 'none';
  document.getElementById('lockGuessBtn').classList.remove('visible');
  document.getElementById('lockGuessBtn').disabled = true;

  if(mode === 'streetview'){
    findStreetViewRound(0);
  } else {
    const idx = pickNextIndex();
    currentLocation = allLocations[idx];
    setupSatelliteStage(currentLocation);
    finishRoundSetup();
  }
}

function findStreetViewRound(attempt){
  if(attempt >= MAX_STREETVIEW_ATTEMPTS){
    // fall back to satellite for this round rather than stall
    const idx = pickNextIndex();
    currentLocation = allLocations[idx];
    setupSatelliteStage(currentLocation);
    finishRoundSetup();
    return;
  }
  const idx = pickNextIndex();
  const loc = allLocations[idx];
  const svService = new google.maps.StreetViewService();
  svService.getPanorama({location:{lat:loc.lat,lng:loc.lng}, radius:40000, source:google.maps.StreetViewSource.OUTDOOR}, (data,status)=>{
    if(status === google.maps.StreetViewStatus.OK){
      currentLocation = loc;
      // use the panorama's actual position as the "true" answer, so scoring matches what's shown
      currentLocation = {...loc, lat:data.location.latLng.lat(), lng:data.location.latLng.lng()};
      setupStreetViewStage(data.location.pano);
      finishRoundSetup();
    } else {
      findStreetViewRound(attempt+1);
    }
  });
}

function setupStreetViewStage(panoId){
  const stageEl = document.getElementById('stage');
  panorama = new google.maps.StreetViewPanorama(stageEl, {
    pano:panoId,
    addressControl:false,
    showRoadLabels:false,
    linksControl:true,
    panControl:true,
    zoomControl:true,
    fullscreenControl:false,
    motionTracking:false,
    motionTrackingControl:false,
    clickToGo:true
  });
}

function setupSatelliteStage(loc){
  const stageEl = document.getElementById('stage');
  stageEl.innerHTML = '';
  const zoom = 12 + Math.floor(Math.random()*3);
  map = new google.maps.Map(stageEl, {
    center:{lat:loc.lat,lng:loc.lng}, zoom,
    mapTypeId:'satellite', disableDefaultUI:true,
    draggable:false, zoomControl:false, gestureHandling:'none',
    keyboardShortcuts:false, tilt:0
  });
}

function finishRoundSetup(){
  document.getElementById('stageLoading').style.display = 'none';
  document.getElementById('roundChip').style.display = 'block';
  document.getElementById('roundNum').textContent = stats.rounds + 1;
  document.getElementById('guessPanel').style.display = 'block';
  google.maps.event.trigger(guessMap, 'resize');
  guessMap.setCenter({lat:20,lng:0});
  guessMap.setZoom(1);
}

function clearGuessState(){
  if(guessMarker){ guessMarker.setMap(null); guessMarker = null; }
  if(actualMarker){ actualMarker.setMap(null); actualMarker = null; }
  if(guessLine){ guessLine.setMap(null); guessLine = null; }
  document.getElementById('resultOverlay').classList.remove('visible');
  document.getElementById('guessPanel').classList.remove('expanded');
}

function onGuessMapClick(e){
  if(hasGuessed) return;
  if(guessMarker) guessMarker.setMap(null);
  guessMarker = new google.maps.Marker({
    position:e.latLng, map:guessMap,
    icon:{ path:google.maps.SymbolPath.CIRCLE, scale:8, fillColor:'#C9A15A', fillOpacity:1, strokeColor:'#0F1B2B', strokeWeight:2 }
  });
  const btn = document.getElementById('lockGuessBtn');
  btn.classList.add('visible');
  btn.disabled = false;
}

function lockGuess(){
  if(!guessMarker || hasGuessed) return;
  hasGuessed = true;
  const g = guessMarker.getPosition();
  const dist = haversineKm(g.lat(), g.lng(), currentLocation.lat, currentLocation.lng);
  const score = scoreFromDistance(dist);

  stats.totalScore += score;
  stats.rounds += 1;
  if(score > stats.best) stats.best = score;
  saveStats();
  updateHeaderStats();

  actualMarker = new google.maps.Marker({
    position:{lat:currentLocation.lat,lng:currentLocation.lng}, map:guessMap,
    icon:{ path:google.maps.SymbolPath.CIRCLE, scale:8, fillColor:'#3E6C45', fillOpacity:1, strokeColor:'#0F1B2B', strokeWeight:2 }
  });
  guessLine = new google.maps.Polyline({
    path:[g, {lat:currentLocation.lat,lng:currentLocation.lng}],
    geodesic:true, strokeColor:'#C0533B', strokeOpacity:0.9, strokeWeight:2,
    map:guessMap
  });
  const bounds = new google.maps.LatLngBounds();
  bounds.extend(g); bounds.extend(actualMarker.getPosition());
  document.getElementById('guessPanel').classList.add('expanded');
  google.maps.event.trigger(guessMap, 'resize');
  guessMap.fitBounds(bounds, 60);

  document.getElementById('resultCountry').textContent = `${currentLocation.name}, ${currentLocation.country}`;
  document.getElementById('resultDistanceCoords').textContent = `${currentLocation.lat.toFixed(3)}, ${currentLocation.lng.toFixed(3)}`;
  document.getElementById('resultScore').textContent = score;
  document.getElementById('resultDistance').textContent = dist < 1 ? `${Math.round(dist*1000)} m` : `${dist.toFixed(1)} km`;
  document.getElementById('resultBest').textContent = `${stats.best} pts`;
  document.getElementById('resultOverlay').classList.add('visible');

  document.getElementById('lockGuessBtn').classList.remove('visible');
}

/* ---------------- Header / drawer stats ---------------- */
const MAX_SCORE_PER_ROUND = 5000;

function updateHeaderStats(){
  const maxPossible = stats.rounds * MAX_SCORE_PER_ROUND;
  const pct = maxPossible ? Math.round((stats.totalScore/maxPossible)*100) : null;
  document.getElementById('sessionScore').textContent = `${stats.totalScore} / ${maxPossible}`;
  document.getElementById('sessionPct').textContent = pct === null ? '—' : `${pct}%`;
  document.getElementById('roundCount').textContent = stats.rounds;
  document.getElementById('avgScore').textContent = stats.rounds ? Math.round(stats.totalScore/stats.rounds) : '—';
  document.getElementById('bestScoreStat').textContent = stats.rounds ? `${stats.best} pts` : '—';
}

function updateLocCountUI(){
  document.getElementById('totalLocCount').textContent = allLocations.length;
  document.getElementById('locCountText').textContent = `${allLocations.length} waypoints in rotation across the globe.`;
}

function renderAddedList(){
  const custom = loadCustomLocations();
  const wrap = document.getElementById('addedList');
  wrap.innerHTML = '';
  custom.forEach((loc, i) => {
    const row = document.createElement('div');
    row.className = 'added-item';
    row.innerHTML = `<span>${loc.name}${loc.country ? ', '+loc.country : ''}</span>`;
    const btn = document.createElement('button');
    btn.textContent = '✕';
    btn.onclick = () => {
      const list = loadCustomLocations();
      list.splice(i,1);
      saveCustomLocations(list);
      buildLocationList();
      updateLocCountUI();
      renderAddedList();
    };
    row.appendChild(btn);
    wrap.appendChild(row);
  });
}

/* ---------------- UI wiring ---------------- */
function wireUI(){
  document.querySelectorAll('.tab').forEach(tab=>{
    tab.addEventListener('click', ()=>{
      if(tab.dataset.mode === mode) return;
      document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
      tab.classList.add('active');
      mode = tab.dataset.mode;
      startRound();
    });
  });

  document.getElementById('beginBtn').addEventListener('click', ()=>{
    document.getElementById('startOverlay').style.display = 'none';
    startRound();
  });

  document.getElementById('lockGuessBtn').addEventListener('click', lockGuess);
  document.getElementById('nextRoundBtn').addEventListener('click', ()=>{
    document.getElementById('resultOverlay').classList.remove('visible');
    startRound();
  });

  document.getElementById('expandGuessBtn').addEventListener('click', ()=>{
    document.getElementById('guessPanel').classList.toggle('expanded');
    setTimeout(()=>google.maps.event.trigger(guessMap,'resize'), 260);
  });

  document.getElementById('openDrawerBtn').addEventListener('click', openDrawer);
  document.getElementById('closeDrawerBtn').addEventListener('click', closeDrawer);
  document.getElementById('drawerBackdrop').addEventListener('click', closeDrawer);

  document.getElementById('addLocBtn').addEventListener('click', addCustomLocation);
  document.getElementById('resetSessionBtn').addEventListener('click', ()=>{
    stats = {totalScore:0, rounds:0, best:0};
    saveStats();
    updateHeaderStats();
  });

  wireLocationSearch();
  updateHeaderStats();
  renderAddedList();
}

function wireLocationSearch(){
  const input = document.getElementById('addSearch');
  if(!window.google || !google.maps.places) return;
  const autocomplete = new google.maps.places.Autocomplete(input, {
    fields:['name','geometry','address_components']
  });
  autocomplete.addListener('place_changed', ()=>{
    const place = autocomplete.getPlace();
    if(!place.geometry) return;
    const lat = place.geometry.location.lat();
    const lng = place.geometry.location.lng();
    let country = '';
    (place.address_components || []).forEach(comp=>{
      if(comp.types.includes('country')) country = comp.long_name;
    });
    document.getElementById('addName').value = place.name || '';
    document.getElementById('addCountry').value = country;
    document.getElementById('addLat').value = lat.toFixed(5);
    document.getElementById('addLng').value = lng.toFixed(5);
    input.value = '';
  });
}

function openDrawer(){
  document.getElementById('drawer').classList.add('open');
  document.getElementById('drawerBackdrop').classList.add('visible');
  updateHeaderStats();
  updateLocCountUI();
}
function closeDrawer(){
  document.getElementById('drawer').classList.remove('open');
  document.getElementById('drawerBackdrop').classList.remove('visible');
}

function addCustomLocation(){
  const name = document.getElementById('addName').value.trim();
  const country = document.getElementById('addCountry').value.trim();
  const lat = parseFloat(document.getElementById('addLat').value);
  const lng = parseFloat(document.getElementById('addLng').value);
  const msg = document.getElementById('addMsg');

  if(!name || isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180){
    msg.textContent = 'Enter a name and valid latitude/longitude.';
    msg.className = 'msg show err';
    return;
  }
  const list = loadCustomLocations();
  list.push({name, country, lat, lng});
  saveCustomLocations(list);
  buildLocationList();
  updateLocCountUI();
  renderAddedList();

  document.getElementById('addName').value = '';
  document.getElementById('addCountry').value = '';
  document.getElementById('addLat').value = '';
  document.getElementById('addLng').value = '';
  msg.textContent = `${name} added to the rotation.`;
  msg.className = 'msg show ok';
}
