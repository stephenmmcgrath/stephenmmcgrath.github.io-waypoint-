/* Waypoint — Field Guessing Log
   Cooperative local GeoGuessr-style game built on the Google Maps Platform. */

const SUPABASE_URL = 'https://rkfoehpnleolzoffcjou.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_MQmKVyjXRRZka-HVh6BAow_0J8dTJ8b';
let supa = null;

const CUSTOM_KEY = 'waypoint_custom_locations';
const STATS_KEY = 'waypoint_session_stats';
const MAPS_KEY_STORAGE = 'waypoint_maps_api_key';
const MAX_STREETVIEW_ATTEMPTS = 6;

/* ---------------- Maps API key bootstrap ---------------- */
function bootstrapMaps(){
  const savedKey = localStorage.getItem(MAPS_KEY_STORAGE);
  if(savedKey){
    loadMapsScript(savedKey);
  } else {
    document.getElementById('keyOverlay').style.display = 'flex';
  }
  document.getElementById('saveKeyBtn').addEventListener('click', ()=>{
    const key = document.getElementById('keyInput').value.trim();
    const msg = document.getElementById('keyMsg');
    if(!key.startsWith('AIza') || key.length < 30){
      msg.textContent = 'That doesn\'t look like a valid Google Maps API key.';
      msg.className = 'msg show err';
      return;
    }
    localStorage.setItem(MAPS_KEY_STORAGE, key);
    document.getElementById('keyOverlay').style.display = 'none';
    loadMapsScript(key);
  });
}

function loadMapsScript(key){
  const script = document.createElement('script');
  script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&libraries=places&callback=initWaypoint&v=weekly`;
  script.async = true;
  script.onerror = () => {
    localStorage.removeItem(MAPS_KEY_STORAGE);
    document.getElementById('keyOverlay').style.display = 'flex';
    document.getElementById('keyMsg').textContent = 'Couldn\'t load Google Maps with that key — check it and try again.';
    document.getElementById('keyMsg').className = 'msg show err';
  };
  document.head.appendChild(script);
}

document.addEventListener('DOMContentLoaded', bootstrapMaps);

let map, guessMap, panorama;
let guessMarker = null;
let actualMarker = null;
let guessLine = null;
let mode = 'streetview';
let currentGame = 'world';
let currentLocation = null;
let allLocations = [];
let hasGuessed = false;
let deckByGame = {};

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

function initSupabase(){
  try{
    if(window.supabase){
      supa = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    }
  }catch(e){ console.warn('Supabase init failed, running local-only', e); }
}

async function loadCloudState(){
  if(!supa) return null;
  try{
    const { data, error } = await supa.from('waypoint_state').select('*').eq('id','shared').single();
    if(error) throw error;
    return data;
  }catch(e){ console.warn('Cloud state load failed, using local stats', e); return null; }
}

async function saveCloudState(){
  if(!supa) return;
  try{
    await supa.from('waypoint_state').update({
      total_score: stats.totalScore, rounds: stats.rounds, best: stats.best, updated_at: new Date().toISOString()
    }).eq('id','shared');
  }catch(e){ console.warn('Cloud state save failed', e); }
}

async function loadCloudCustomLocations(){
  if(!supa) return null;
  try{
    const { data, error } = await supa.from('waypoint_custom_locations').select('*').order('created_at',{ascending:true});
    if(error) throw error;
    return data.map(d => ({name:d.name, country:d.country, lat:d.lat, lng:d.lng, cloudId:d.id}));
  }catch(e){ console.warn('Cloud locations load failed, using local list', e); return null; }
}

async function saveCloudCustomLocation(loc){
  if(!supa) return null;
  try{
    const { data, error } = await supa.from('waypoint_custom_locations')
      .insert({name:loc.name, country:loc.country, lat:loc.lat, lng:loc.lng}).select().single();
    if(error) throw error;
    return data.id;
  }catch(e){ console.warn('Cloud location save failed', e); return null; }
}

async function deleteCloudCustomLocation(cloudId){
  if(!supa || !cloudId) return;
  try{ await supa.from('waypoint_custom_locations').delete().eq('id', cloudId); }
  catch(e){ console.warn('Cloud location delete failed', e); }
}

function buildLocationList(){
  const base = BASE_LOCATIONS.map(([name,country,lat,lng]) => ({name,country,lat,lng,custom:false}));
  const custom = loadCustomLocations().map(l => ({...l,custom:true}));
  allLocations = base.concat(custom);
}

function getPool(game){
  if(game === 'amazingRace'){
    return (typeof AMAZING_RACE_LOCATIONS !== 'undefined' ? AMAZING_RACE_LOCATIONS : [])
      .map(([name,country,lat,lng]) => ({name,country,lat,lng}));
  }
  if(game === 'familyFun'){
    return (typeof FAMILY_FUN_LOCATIONS !== 'undefined' ? FAMILY_FUN_LOCATIONS : [])
      .map(([name,country,lat,lng]) => ({name,country,lat,lng}));
  }
  return allLocations;
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
async function initWaypoint(){
  initSupabase();

  const cloudState = await loadCloudState();
  if(cloudState){
    stats = { totalScore:cloudState.total_score, rounds:cloudState.rounds, best:cloudState.best };
    saveStats();
  }

  buildLocationList();

  const cloudLocs = await loadCloudCustomLocations();
  if(cloudLocs){
    saveCustomLocations(cloudLocs);
    buildLocationList();
  }

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
    {elementType:'labels.text.fill',stylers:[{color:'#a9b4c2'}]},
    {elementType:'labels.text.stroke',stylers:[{color:'#0F1B2B'}]},
    {featureType:'administrative.country',elementType:'geometry.stroke',stylers:[{color:'#C9A15A'}, {weight:0.6}]},
    {featureType:'administrative.province',elementType:'geometry.stroke',stylers:[{color:'#3a4a5c'}]},
    {featureType:'water',elementType:'geometry',stylers:[{color:'#0c1826'}]},
    {featureType:'landscape',elementType:'geometry',stylers:[{color:'#1b2e42'}]},
    {featureType:'poi',elementType:'labels',stylers:[{visibility:'off'}]},
    {featureType:'road',elementType:'geometry',stylers:[{color:'#2a3f56'}]},
    {featureType:'road',elementType:'labels',stylers:[{visibility:'simplified'}]},
    {featureType:'transit',stylers:[{visibility:'off'}]}
  ];
}

/* ---------------- Round flow ---------------- */
function shuffle(arr){
  const a = arr.slice();
  for(let i = a.length - 1; i > 0; i--){
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function drawNextLocation(){
  const pool = getPool(currentGame);
  if(!deckByGame[currentGame] || deckByGame[currentGame].length === 0){
    deckByGame[currentGame] = shuffle(pool.map((_, i) => i));
  }
  const idx = deckByGame[currentGame].pop();
  return pool[idx];
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
    currentLocation = drawNextLocation();
    setupSatelliteStage(currentLocation);
    finishRoundSetup();
  }
}

function findStreetViewRound(attempt){
  if(attempt >= MAX_STREETVIEW_ATTEMPTS){
    // fall back to satellite for this round rather than stall
    currentLocation = drawNextLocation();
    setupSatelliteStage(currentLocation);
    finishRoundSetup();
    return;
  }
  const loc = drawNextLocation();
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
  const zoom = 13 + Math.floor(Math.random()*2);
  map = new google.maps.Map(stageEl, {
    center:{lat:loc.lat,lng:loc.lng}, zoom,
    mapTypeId:'satellite', disableDefaultUI:true,
    draggable:false, scrollwheel:false, disableDoubleClickZoom:true,
    zoomControl:true, gestureHandling:'none',
    keyboardShortcuts:false, tilt:0
  });
  // zoom buttons can still shift the reported center in some browsers — snap back to the true point
  map.addListener('center_changed', ()=>{
    const c = map.getCenter();
    if(c.lat().toFixed(4) != loc.lat.toFixed(4) || c.lng().toFixed(4) != loc.lng.toFixed(4)){
      map.setCenter({lat:loc.lat,lng:loc.lng});
    }
  });
}

function finishRoundSetup(){
  document.getElementById('stageLoading').style.display = 'none';
  document.getElementById('roundChip').style.display = 'block';
  document.getElementById('roundNum').textContent = stats.rounds + 1;
  document.getElementById('guessPanel').style.display = 'block';
  document.getElementById('guessPanel').classList.add('expanded');
  google.maps.event.trigger(guessMap, 'resize');
  guessMap.setCenter({lat:20,lng:0});
  guessMap.setZoom(2);
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
  saveCloudState();

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
  const count = getPool(currentGame).length;
  document.getElementById('totalLocCount').textContent = currentGame === 'world' ? allLocations.length : count;
  const label = currentGame === 'world' ? 'across the globe' : (currentGame === 'amazingRace' ? "from Our Amazing Race" : "from Family Fun");
  document.getElementById('locCountText').textContent = `${count} waypoints ${label}.`;
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
      const [removed] = list.splice(i,1);
      saveCustomLocations(list);
      if(removed && removed.cloudId) deleteCloudCustomLocation(removed.cloudId);
      buildLocationList();
      deckByGame.world = null;
      updateLocCountUI();
      renderAddedList();
    };
    row.appendChild(btn);
    wrap.appendChild(row);
  });
}

/* ---------------- UI wiring ---------------- */
function wireUI(){
  document.querySelectorAll('#gameTabs .tab').forEach(tab=>{
    tab.addEventListener('click', ()=>{
      if(tab.dataset.game === currentGame) return;
      document.querySelectorAll('#gameTabs .tab').forEach(t=>t.classList.remove('active'));
      tab.classList.add('active');
      currentGame = tab.dataset.game;
      updateLocCountUI();
      startRound();
    });
  });

  document.querySelectorAll('.tabs:not(#gameTabs) .tab').forEach(tab=>{
    tab.addEventListener('click', ()=>{
      if(tab.dataset.mode === mode) return;
      document.querySelectorAll('.tabs:not(#gameTabs) .tab').forEach(t=>t.classList.remove('active'));
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
    saveCloudState();
  });

  document.getElementById('changeKeyBtn').addEventListener('click', ()=>{
    if(confirm('Clear the saved Maps API key and re-enter it?')){
      localStorage.removeItem(MAPS_KEY_STORAGE);
      location.reload();
    }
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

async function addCustomLocation(){
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
  const newLoc = {name, country, lat, lng};
  const cloudId = await saveCloudCustomLocation(newLoc);
  if(cloudId) newLoc.cloudId = cloudId;

  const list = loadCustomLocations();
  list.push(newLoc);
  saveCustomLocations(list);
  buildLocationList();
  deckByGame.world = null;
  updateLocCountUI();
  renderAddedList();

  document.getElementById('addName').value = '';
  document.getElementById('addCountry').value = '';
  document.getElementById('addLat').value = '';
  document.getElementById('addLng').value = '';
  msg.textContent = cloudId ? `${name} added and synced to the cloud.` : `${name} added to the rotation.`;
  msg.className = 'msg show ok';
}
