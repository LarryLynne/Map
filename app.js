// === НАЛАШТУВАННЯ ===
// ВСТАВ СВІЙ НОВИЙ URL РОЗГОРТАННЯ APPS SCRIPT:
const DATA_URL = 'https://script.google.com/macros/s/AKfycbz6_xsIfzv5u0anuh96rbKxwJTzlZJ43exSsV_MwHkOWMFhEsiQQlZW6aQpsGxfUbWM/exec'; 

let globalData = { infrastructure: null, nodes: null };
let map = null;

// Стан маршруту
let startCoords = null;
let endCoords = null;
let waypoints = []; // Користувацькі точки об'їзду
let routeLineGeoJSON = null; // Поточна лінія маршруту
let userMarkers = []; // Візуальні маркери точок

// === ІНІЦІАЛІЗАЦІЯ ДАНИХ ===
async function fetchAllData() {
    try {
        const response = await fetch(DATA_URL);
        const data = await response.json();
        globalData = data;
        populateNodeSelectors();
    } catch (e) {
        alert("Помилка завантаження даних. Перевір посилання на скрипт.");
        console.error(e);
    }
}

// === ВИБІР ВУЗЛІВ КЛІКОМ ПО КАРТІ ===
window.setNodeFromMap = function(type, nodeName) {
    if (type === 'start') {
        document.getElementById('start-node').value = nodeName;
    } else {
        document.getElementById('end-node').value = nodeName;
    }
    
    const popups = document.getElementsByClassName('maplibregl-popup');
    if (popups.length) popups[0].remove();

    const startVal = document.getElementById('start-node').value;
    const endVal = document.getElementById('end-node').value;
    if (startVal && endVal) {
        calculateRoute();
    }
};

function populateNodeSelectors() {
    const startSelect = document.getElementById('start-node');
    const endSelect = document.getElementById('end-node');
    
    // Очищуємо перед заповненням
    startSelect.innerHTML = '<option value="">Оберіть старт...</option>';
    endSelect.innerHTML = '<option value="">Оберіть фініш...</option>';
    
    const features = globalData.nodes.features.sort((a,b) => a.properties.name.localeCompare(b.properties.name));
    
    features.forEach((f) => {
        const nodeName = f.properties.name;
        // Записуємо ім'я у value
        const opt = `<option value="${nodeName}">${f.properties.type}: ${nodeName}</option>`;
        startSelect.innerHTML += opt;
        endSelect.innerHTML += opt;
    });
}

// === ЛОГІКА МАРШРУТИЗАЦІЇ (OSRM) З ПІДРАХУНКОМ КМ ===
async function calculateRoute() {
    const startVal = document.getElementById('start-node').value;
    const endVal = document.getElementById('end-node').value;
    
    if (!startVal || !endVal) {
        alert("Оберіть початковий та кінцевий вузол!");
        return;
    }

    const startNode = globalData.nodes.features.find(f => f.properties.name === startVal);
    const endNode = globalData.nodes.features.find(f => f.properties.name === endVal);
    if (!startNode || !endNode) return;

    startCoords = startNode.geometry.coordinates;
    endCoords = endNode.geometry.coordinates;

    // 1. Отримуємо БАЗОВУ відстань (без об'їздів)
    let baseDistanceKm = 0;
    try {
        const baseUrl = `https://router.project-osrm.org/route/v1/driving/${startCoords[0]},${startCoords[1]};${endCoords[0]},${endCoords[1]}?overview=false`;
        const baseRes = await fetch(baseUrl);
        const baseData = await baseRes.json();
        if (baseData.code === 'Ok') {
            baseDistanceKm = (baseData.routes[0].distance / 1000).toFixed(1);
        }
    } catch(e) { console.warn("Помилка базового маршруту", e); }

    // 2. Отримуємо АКТУАЛЬНУ відстань (з waypoints)
    const allRoutePoints = [startCoords, ...waypoints, endCoords];
    const coordsString = allRoutePoints.map(p => `${p[0]},${p[1]}`).join(';');
    const url = `https://router.project-osrm.org/route/v1/driving/${coordsString}?overview=full&geometries=geojson`;

    try {
        const response = await fetch(url);
        const data = await response.json();
        if (data.code !== 'Ok') throw new Error("OSRM Error");

        // Витягуємо дистанцію актуального маршруту
        let actualDistanceKm = (data.routes[0].distance / 1000).toFixed(1);

        routeLineGeoJSON = {
            type: 'FeatureCollection',
            features: [{ type: 'Feature', geometry: data.routes[0].geometry }]
        };

        drawRouteOnMap();
        filterInfrastructureByRoute(); 
        
        // Оновлюємо UI кілометражу
        document.getElementById('route-stats').style.display = 'block';
        document.getElementById('dist-base').innerText = baseDistanceKm;
        document.getElementById('dist-actual').innerText = actualDistanceKm;
        
        const bbox = turf.bbox(routeLineGeoJSON);
        map.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]], { padding: 50 });

    } catch (e) {
        console.error("Помилка побудови маршруту:", e);
    }
}

window.clearRoute = function() {
    waypoints = [];
    routeLineGeoJSON = null;
    userMarkers.forEach(m => m.remove());
    userMarkers = [];
    document.getElementById('start-node').value = "";
    document.getElementById('end-node').value = "";
    
    if (map.getSource('route')) {
        map.getSource('route').setData({ type: 'FeatureCollection', features: [] });
    }
    document.getElementById('route-stats').style.display = 'none';
    // Повертаємо всю інфраструктуру на екран
    applyInfraFilters();
};

function updateTopRightStats(features) {
    let road = 0, rail = 0, cross = 0;
    
    features.forEach(f => {
        if (f.properties.type === 'road_bridge') road++;
        else if (f.properties.type === 'rail_bridge') rail++;
        else if (f.properties.type === 'auto_crossing') cross++;
    });

    document.getElementById('stat-total').innerText = features.length;
    document.getElementById('stat-road').innerText = road;
    document.getElementById('stat-rail').innerText = rail;
    document.getElementById('stat-cross').innerText = cross;
}

// === МАГІЯ TURF: ФІЛЬТРАЦІЯ ВЗДОВЖ МАРШРУТУ ===
function filterInfrastructureByRoute() {
    if (!routeLineGeoJSON) return;

    // Створюємо "коридор" шириною 2 км навколо лінії маршруту
    const routeBuffer = turf.buffer(routeLineGeoJSON.features[0], 2, { units: 'kilometers' });
    
    const typeValue = document.getElementById('type-select').value;
    let infraToCheck = globalData.infrastructure.features;

    // Спочатку фільтруємо за типом з дропдауну
    if (typeValue !== 'all') {
        infraToCheck = infraToCheck.filter(f => f.properties.type === typeValue);
    }

    // Залишаємо лише ті об'єкти, які потрапляють у коридор
    const filteredFeatures = infraToCheck.filter(pt => turf.booleanPointInPolygon(pt.geometry.coordinates, routeBuffer));

    const finalData = { type: 'FeatureCollection', features: filteredFeatures };
    
    map.getSource('infrastructure').setData(finalData);
    updateTopRightStats(filteredFeatures);
}

// Функція для звичайного фільтру (коли маршруту немає)
function applyInfraFilters() {
    if (routeLineGeoJSON) {
        filterInfrastructureByRoute();
        return;
    }

    const typeValue = document.getElementById('type-select').value;
    let filteredFeatures = globalData.infrastructure.features;

    if (typeValue !== 'all') {
        filteredFeatures = filteredFeatures.filter(f => f.properties.type === typeValue);
    }

    map.getSource('infrastructure').setData({ type: 'FeatureCollection', features: filteredFeatures });
    updateTopRightStats(filteredFeatures);
}

// === ВІДПРАВКА СТАТУСУ "ПРОБЛЕМНИЙ" НА СЕРВЕР ===
// === ВІДПРАВКА СТАТУСУ "ПРОБЛЕМНИЙ" НА СЕРВЕР ===
window.markProblematic = async function(id) {
    document.getElementById(`btn-${id}`).innerText = "Запис...";
    document.getElementById(`btn-${id}`).disabled = true;

    try {
        await fetch(DATA_URL, {
            method: 'POST',
            body: JSON.stringify({ id: id, action: 'add' }), // Додали action: 'add'
            redirect: 'follow' 
        });
        
        // Оновлюємо локальний стан
        const target = globalData.infrastructure.features.find(f => f.properties.id === id);
        if (target) target.properties.isProblematic = true;
        
        applyInfraFilters();
        closePopups();
    } catch(e) {
        alert("Помилка запису.");
    }
}

// === ВІДНОВЛЕННЯ ОБ'ЄКТУ ===
window.unmarkProblematic = async function(id) {
    document.getElementById(`btn-unmark-${id}`).innerText = "Відновлення...";
    document.getElementById(`btn-unmark-${id}`).disabled = true;

    try {
        await fetch(DATA_URL, {
            method: 'POST',
            body: JSON.stringify({ id: id, action: 'remove' }), // Передаємо action: 'remove'
            redirect: 'follow' 
        });
        
        // Оновлюємо локальний стан, знімаємо червоний прапорець
        const target = globalData.infrastructure.features.find(f => f.properties.id === id);
        if (target) target.properties.isProblematic = false;
        
        applyInfraFilters();
        closePopups();
    } catch(e) {
        alert("Помилка запису.");
    }
}

// Допоміжна функція для закриття попапів
function closePopups() {
    const popups = document.getElementsByClassName('maplibregl-popup');
    if (popups.length) popups[0].remove();
}

function drawRouteOnMap() {
    const routeSource = map.getSource('route');
    if (routeSource) {
        routeSource.setData(routeLineGeoJSON);
    } else {
        map.addSource('route', { type: 'geojson', data: routeLineGeoJSON });
        map.addLayer({
            'id': 'route-layer',
            'type': 'line',
            'source': 'route',
            'layout': { 'line-join': 'round', 'line-cap': 'round' },
            'paint': { 'line-color': '#0056b3', 'line-width': 5, 'line-opacity': 0.8 }
        }, 'infrastructure-layer'); // Малюємо ПІД інфраструктурою
    }
}

// === ІНІЦІАЛІЗАЦІЯ КАРТИ ===
async function initMap() {
    await fetchAllData();
    if (!globalData.infrastructure) return;

    document.getElementById('loader').style.display = 'none';
    updateTopRightStats(globalData.infrastructure.features);

    map = new maplibregl.Map({
        container: 'map',
        style: {
            'version': 8,
            'sources': {
                'raster-tiles': {
                    'type': 'raster',
                    'tiles': ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
                    'tileSize': 256,
                    'maxzoom': 19
                }
            },
            'layers': [{ 'id': 'simple-tiles', 'type': 'raster', 'source': 'raster-tiles' }]
        },
        center: [31.1656, 48.3794],
        zoom: 5
    });

    map.on('load', () => {
        
        // ДЖЕРЕЛА ДАНИХ
        map.addSource('nodes', { type: 'geojson', data: globalData.nodes });
        map.addSource('infrastructure', { type: 'geojson', data: globalData.infrastructure });

        map.addLayer({
            'id': 'infrastructure-layer',
            'type': 'circle',
            'source': 'infrastructure',
            // Якщо об'єкт у чорному списку - малюємо великим червоним, інакше за типами
            'paint': {
                'circle-color': [
                    'case',
                    ['==', ['get', 'isProblematic'], true], '#ff0000', // Проблемні - червоні
                    ['==', ['get', 'type'], 'road_bridge'], '#007cbf',
                    ['==', ['get', 'type'], 'rail_bridge'], '#a31545',
                    '#f28c28' // auto_crossing
                ],
                'circle-radius': [
                    'case',
                    ['==', ['get', 'isProblematic'], true], 8, // Проблемні - більші
                    ['==', ['get', 'type'], 'auto_crossing'], 5,
                    4
                ],
                'circle-stroke-width': ['case', ['==', ['get', 'isProblematic'], true], 2, 1],
                'circle-stroke-color': ['case', ['==', ['get', 'isProblematic'], true], '#000000', '#ffffff']
            }
        });
        // ВІЗУАЛІЗАЦІЯ ВУЗЛІВ (НП)
        map.addLayer({
            'id': 'nodes-terminals',
            'type': 'circle',
            'source': 'nodes',
            'filter': ['==', 'type', 'Terminal'],
            'paint': { 'circle-color': '#e32636', 'circle-radius': 8, 'circle-stroke-width': 2, 'circle-stroke-color': '#fff' }
        });

        map.addLayer({
            'id': 'nodes-depots',
            'type': 'circle',
            'source': 'nodes',
            'filter': ['==', 'type', 'Depot'],
            'paint': { 'circle-color': '#007cbf', 'circle-radius': 6, 'circle-stroke-width': 1, 'circle-stroke-color': '#fff' }
        });

        // ВІЗУАЛІЗАЦІЯ ІНФРАСТРУКТУРИ

        // ІНТЕРАКТИВНІСТЬ
        document.getElementById('type-select').addEventListener('change', applyInfraFilters);

        // Тумблер видимості інфраструктури
        document.getElementById('toggle-infra').addEventListener('change', (e) => {
            const visibility = e.target.checked ? 'visible' : 'none';
            if (map.getLayer('infrastructure-layer')) {
                map.setLayoutProperty('infrastructure-layer', 'visibility', visibility);
            }
        });
        // РЕДАКТИРОВАНИЕ МАРШРУТА (Добавление промежуточных точек правым кликом)
        map.on('contextmenu', (e) => {
            const coords = [e.lngLat.lng, e.lngLat.lat];
            waypoints.push(coords);
            
            // Создаем маркер и делаем его ПЕРЕТАСКИВАЕМЫМ (draggable: true)
            const marker = new maplibregl.Marker({ color: '#ffcc00', draggable: true })
                .setLngLat(coords)
                .addTo(map);
            
            userMarkers.push(marker);

            // ФИЧА 1: Перетаскивание точки мышкой
            marker.on('dragend', () => {
                const lngLat = marker.getLngLat();
                const index = userMarkers.indexOf(marker);
                if (index > -1) {
                    waypoints[index] = [lngLat.lng, lngLat.lat]; // Обновляем координаты
                    
                    if (document.getElementById('start-node').value && document.getElementById('end-node').value) {
                        calculateRoute(); // Перестраиваем маршрут на лету
                    }
                }
            });

            // ФИЧА 2: Удаление точки по левому клику на сам маркер
            marker.getElement().addEventListener('click', (event) => {
                event.stopPropagation(); // Чтобы карта не думала, что кликнули по ней
                
                const index = userMarkers.indexOf(marker);
                if (index > -1) {
                    waypoints.splice(index, 1); // Удаляем из памяти
                    userMarkers.splice(index, 1);
                    marker.remove(); // Удаляем с карты
                    
                    if (document.getElementById('start-node').value && document.getElementById('end-node').value) {
                        calculateRoute(); // Перестраиваем маршрут без этой точки
                    }
                }
            });
            
            // Якщо є старт і фініш - одразу перемальовуємо
            if (document.getElementById('start-node').value && document.getElementById('end-node').value) {
                calculateRoute();
            }
        });

        // Попапи для інфраструктури
        map.on('click', 'infrastructure-layer', (e) => {
            const props = e.features[0].properties;
            
            // Якщо об'єкт проблемний - показуємо статус і зелену кнопку відновлення
            let statusHTML = props.isProblematic ? 
                `<b style="color:red;">⚠️ ЗРУЙНОВАНО / БЛОКОВАНО</b><br>
                 <button id="btn-unmark-${props.id}" class="problem-btn" style="background: #28a745; margin-top: 10px;" onclick="unmarkProblematic('${props.id}')">🟢 Відновити об'єкт</button>` : 
                `<button id="btn-${props.id}" class="problem-btn" onclick="markProblematic('${props.id}')">🚨 Відмітити як проблемний</button>`;

            new maplibregl.Popup()
                .setLngLat(e.lngLat)
                .setHTML(`
                    <b>${props.name || 'Об\'єкт інфраструктури'}</b><br>
                    ID: ${props.id}<br><br>
                    ${statusHTML}
                `)
                .addTo(map);
        });

        // Попапи для вузлів НП
        // Попапи для вузлів НП
        map.on('click', (e) => {
            const features = map.queryRenderedFeatures(e.point, { layers: ['nodes-terminals', 'nodes-depots'] });
            if (!features.length) return;
            
            const props = features[0].properties;
            const nodeName = props.name; // БЕРЕМО ІМ'Я!

            new maplibregl.Popup()
                .setLngLat(e.lngLat)
                .setHTML(`
                    <div style="text-align: center; min-width: 150px;">
                        <b style="font-size: 14px;">${nodeName}</b><br>
                        <span style="color: #666; font-size: 12px;">Тип: ${props.type}</span><br><br>
                        <button onclick="setNodeFromMap('start', '${nodeName}')" 
                                style="margin-bottom: 5px; width: 100%; background: #28a745; color: white; border: none; padding: 6px; border-radius: 4px; cursor: pointer; font-weight: bold;">
                            🟢 Старт звідси
                        </button>
                        <button onclick="setNodeFromMap('end', '${nodeName}')" 
                                style="width: 100%; background: #007cbf; color: white; border: none; padding: 6px; border-radius: 4px; cursor: pointer; font-weight: bold;">
                            🔴 Фініш сюди
                        </button>
                    </div>
                `)
                .addTo(map);
        });

        map.on('mouseenter', 'infrastructure-layer', () => map.getCanvas().style.cursor = 'pointer');
        map.on('mouseleave', 'infrastructure-layer', () => map.getCanvas().style.cursor = '');
        map.on('mouseenter', 'nodes-terminals', () => map.getCanvas().style.cursor = 'pointer');
        map.on('mouseleave', 'nodes-terminals', () => map.getCanvas().style.cursor = '');
    });
}

initMap();