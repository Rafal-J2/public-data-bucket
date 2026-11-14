const fs = require('fs');
const path = require('path');

// The data files live in the root of this repository, served by GitHub Pages
const publicDir = path.join(__dirname, '../..');
const esaHistoryShardsDir = path.join(publicDir, 'esa_history_shards');
const giosDetailsDir = path.join(publicDir, 'gios_details');
const metadataPath = path.join(publicDir, 'metadata.json');
const esaIdsPath = path.join(publicDir, 'esa_ids.json');
// Open data published by NASK on dane.gov.pl (dataset 2913, CC0 1.0)
const esaApiUrl = 'https://public-esa.ose.gov.pl/api/v1/smog';
const esaMinStations = 500;
const historyWindowMs = 24 * 60 * 60 * 1000;
const esaHistoryShardCount = 64;
const giosSensorsTtlMs = 24 * 60 * 60 * 1000;
// GIOŚ publishes hourly values. With a run every 15 minutes, 55 minutes
// refreshes them about once an hour (60 would often wait 75 minutes)
const giosMeasurementsTtlMs = 55 * 60 * 1000;
// getData answers HTTP 400 with this code for manual (24h gravimetric)
// sensors. Their results come weeks later, only from the archive API.
const giosManualSensorError = 'API-ERR-100003';
const userAgent = 'AntySmogApp/1.0 (+https://github.com/Rafal-J2/public-data-bucket)';

function ensureDirs() {
  fs.mkdirSync(esaHistoryShardsDir, { recursive: true });
  fs.mkdirSync(giosDetailsDir, { recursive: true });
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) {
      return fallback;
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    console.warn(`Cannot read ${filePath}: ${error.message}`);
    return fallback;
  }
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data));
}

function countJsonFiles(dirPath) {
  if (!fs.existsSync(dirPath)) {
    return 0;
  }
  return fs
    .readdirSync(dirPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .length;
}

function getFileSizeBytes(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch (_) {
    return 0;
  }
}

function getDirSizeBytes(dirPath) {
  if (!fs.existsSync(dirPath)) {
    return 0;
  }

  return fs.readdirSync(dirPath, { withFileTypes: true }).reduce((total, entry) => {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      return total + getDirSizeBytes(entryPath);
    }
    return total + getFileSizeBytes(entryPath);
  }, 0);
}

function addMsToIso(timestamp, ms) {
  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) {
    return null;
  }
  return new Date(parsed + ms).toISOString();
}

function getEsaHistoryShardId(schoolId) {
  const numericId = Number(schoolId);
  if (!Number.isFinite(numericId)) {
    return 0;
  }
  return Math.abs(Math.trunc(numericId)) % esaHistoryShardCount;
}

function readMetadata() {
  return readJson(metadataPath, {});
}

function writeMetadata(metadata) {
  const danePath = path.join(publicDir, 'dane.json');
  const giosStationsPath = path.join(publicDir, 'gios_stations.json');
  const esaStations = readJson(danePath, []);
  const giosStations = readJson(giosStationsPath, []);
  const nextGiosSensorsRefreshAt = metadata.giosStationSensorsUpdatedAt
    ? addMsToIso(metadata.giosStationSensorsUpdatedAt, giosSensorsTtlMs)
    : null;
  const nextGiosMeasurementsRefreshAt = metadata.giosMeasurementsUpdatedAt
    ? addMsToIso(metadata.giosMeasurementsUpdatedAt, giosMeasurementsTtlMs)
    : null;

  fs.writeFileSync(metadataPath, JSON.stringify({
    ...metadata,
    generatedAt: new Date().toISOString(),
    nextGiosSensorsRefreshAt,
    nextGiosMeasurementsRefreshAt,
    config: {
      esaHistoryWindowHours: historyWindowMs / 60 / 60 / 1000,
      esaHistoryShardCount,
      giosSensorsTtlHours: giosSensorsTtlMs / 60 / 60 / 1000,
      giosMeasurementsTtlMinutes: giosMeasurementsTtlMs / 60 / 1000,
    },
    stats: {
      esaStations: Array.isArray(esaStations) ? esaStations.length : 0,
      giosStations: Array.isArray(giosStations) ? giosStations.length : 0,
      esaHistoryShards: countJsonFiles(esaHistoryShardsDir),
      giosDetailsFiles: countJsonFiles(giosDetailsDir),
      sizeBytes: {
        dane: getFileSizeBytes(danePath),
        giosStations: getFileSizeBytes(giosStationsPath),
        esaHistoryShards: getDirSizeBytes(esaHistoryShardsDir),
        giosDetails: getDirSizeBytes(giosDetailsDir),
      },
    },
  }, null, 2));
}

function shouldRefresh(metadata, key, ttlMs) {
  const timestamp = metadata[key];
  if (!timestamp) {
    return true;
  }
  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) {
    return true;
  }
  return Date.now() - parsed >= ttlMs;
}

function extractList(payload, key) {
  if (Array.isArray(payload)) {
    return payload;
  }
  return payload?.[key] ?? payload?.['hydra:member'] ?? payload?.values ?? [];
}

function trimHistory(history, now = new Date()) {
  const minTime = now.getTime() - historyWindowMs;
  const deduped = new Map();

  for (const point of history) {
    const time = Date.parse(point.dateTime);
    const value = Number(point.value);
    if (
      Number.isNaN(time) ||
      Number.isNaN(value) ||
      value === 0 ||
      time < minTime
    ) {
      continue;
    }
    deduped.set(new Date(time).toISOString(), {
      dateTime: new Date(time).toISOString(),
      value,
    });
  }

  return [...deduped.values()].sort(
    (a, b) => Date.parse(a.dateTime) - Date.parse(b.dateTime),
  );
}

function appendHistoryPoint(history, value, timestamp = new Date()) {
  const numericValue = Number(value);
  if (Number.isNaN(numericValue)) {
    return trimHistory(history, timestamp);
  }

  return trimHistory([
    ...history,
    {
      dateTime: timestamp.toISOString(),
      value: numericValue,
    },
  ], timestamp);
}

// ESA sends values like 12.011111111111111. One decimal is what the app shows
// and keeps the history files small
function roundMeasurement(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const numericValue = Number(value);
  return Number.isNaN(numericValue) ? null : Math.round(numericValue * 10) / 10;
}

function normalizeMeasurementPair(pm25, pm10) {
  const pm25Value = Number(pm25);
  const pm10Value = Number(pm10);
  if (pm25Value === 0 && pm10Value === 0) {
    return { pm25: null, pm10: null };
  }
  return {
    pm25: Number.isNaN(pm25Value) ? null : pm25Value,
    pm10: Number.isNaN(pm10Value) ? null : pm10Value,
  };
}

function parseGiosHistory(values) {
  return values
    .map((item) => ({
      dateTime: item.date ?? item.Data,
      value: item.value ?? item.Wartość,
    }))
    .filter((item) => {
      const value = Number(item.value);
      return item.dateTime &&
        item.value !== null &&
        item.value !== undefined &&
        !Number.isNaN(value) &&
        value > 0;
    });
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      'User-Agent': userAgent,
      ...(options.headers ?? {}),
    },
  });
  if (!response.ok) {
    const error = new Error(`${url} failed: ${response.status} ${response.statusText}`);
    error.status = response.status;
    error.body = await response.text().catch(() => '');
    throw error;
  }
  return response.json();
}

async function fetchPagedGiosList(url, listKey) {
  const first = await fetchJson(`${url}?page=0&size=500`);
  const totalPages = first.totalPages ?? 1;
  const data = [...extractList(first, listKey)];

  for (let page = 1; page < totalPages; page += 1) {
    const payload = await fetchJson(`${url}?page=${page}&size=500`);
    data.push(...extractList(payload, listKey));
  }

  return data;
}

async function runWithConcurrency(items, limit, worker) {
  const queue = [...items];
  const workers = Array.from({ length: limit }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      await worker(item);
    }
  });
  await Promise.all(workers);
}

// ESA timestamps are Polish local time without an offset ("2026-10-26 12:33:08")
function warsawLocalTimeToIso(text) {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(text ?? '');
  if (!match) {
    return null;
  }
  const [, year, month, day, hour, minute, second] = match.map(Number);
  const localAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'Europe/Warsaw',
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(new Date(localAsUtc))
      .map((part) => [part.type, Number(part.value)]),
  );
  const warsawOffsetMs = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  ) - localAsUtc;
  return new Date(localAsUtc - warsawOffsetMs).toISOString();
}

function esaStationKey(name, latitude, longitude) {
  const normalizedName = (name ?? '').replace(/\s+/g, ' ').trim().toUpperCase();
  return `${Number(latitude).toFixed(5)}|${Number(longitude).toFixed(5)}|${normalizedName}`;
}

// The official API has no station ids, but favorites, the widget, notifications
// and history use them. esa_ids.json keeps a stable id per station (name +
// coordinates). The first run fills it from the previous dane.json, which came
// from the old esa.nask.pl API and has the original ids.
function loadEsaIds() {
  const saved = readJson(esaIdsPath, null);
  if (saved) {
    return saved;
  }

  const ids = {};
  const counts = new Map();
  for (const station of readJson(path.join(publicDir, 'dane.json'), [])) {
    if (station?.id == null) {
      continue;
    }
    const key = esaStationKey(station.name, station.latitude, station.longitude);
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    ids[count === 1 ? key : `${key}#${count}`] = station.id;
  }
  console.log(`Seeded ESA ids from previous dane.json: ${Object.keys(ids).length}.`);
  return ids;
}

async function fetchEsaData() {
  console.log('Fetching ESA stations from the official API...');
  const payload = await fetchJson(esaApiUrl);
  const records = payload?.smog_data;
  if (!Array.isArray(records)) {
    throw new Error('Invalid ESA data format.');
  }
  // An almost empty response is an API problem, not hundreds of stations
  // going offline, so keep the previous data instead
  if (records.length < esaMinStations) {
    throw new Error(`ESA returned only ${records.length} stations.`);
  }
  if (payload.it_has_next_page) {
    console.log('::warning::ESA API reports more pages, only the first one is used.');
  }

  const ids = loadEsaIds();
  let nextId = Math.max(0, ...Object.values(ids).map(Number).filter(Number.isFinite)) + 1;
  let newIds = 0;
  const counts = new Map();
  const stations = records.map((record) => {
    const school = record.school ?? {};
    const key = esaStationKey(school.name, school.latitude, school.longitude);
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    const idKey = count === 1 ? key : `${key}#${count}`;
    if (ids[idKey] == null) {
      ids[idKey] = nextId;
      nextId += 1;
      newIds += 1;
    }

    return {
      id: ids[idKey],
      name: school.name ?? '',
      city: school.city ?? '',
      latitude: school.latitude,
      longitude: school.longitude,
      outside: {
        pm25: roundMeasurement(record.data?.pm25_avg),
        pm10: roundMeasurement(record.data?.pm10_avg),
      },
      measuredAt: warsawLocalTimeToIso(record.timestamp),
    };
  });

  writeJson(esaIdsPath, ids);
  fs.writeFileSync(path.join(publicDir, 'dane.json'), JSON.stringify(stations));
  console.log(`Saved dane.json with ${stations.length} ESA stations (${newIds} new ids).`);
  console.log('Updating ESA rolling 24h history from current measurements...');

  const now = new Date();
  const historyShards = new Map();
  for (const station of stations) {
    const schoolId = station.id;
    const measuredAt = station.measuredAt ? new Date(station.measuredAt) : now;

    const shardId = getEsaHistoryShardId(schoolId);
    const shardPath = path.join(esaHistoryShardsDir, `${shardId}.json`);
    if (!historyShards.has(shardId)) {
      historyShards.set(shardId, readJson(shardPath, {}));
    }

    const shard = historyShards.get(shardId);
    const previous = shard[String(schoolId)] ?? { schoolId, pm25: [], pm10: [] };
    const measurements = normalizeMeasurementPair(
      station.outside?.pm25,
      station.outside?.pm10,
    );

    shard[String(schoolId)] = {
      schoolId,
      pm25: appendHistoryPoint(previous.pm25 ?? [], measurements.pm25, measuredAt),
      pm10: appendHistoryPoint(previous.pm10 ?? [], measurements.pm10, measuredAt),
    };
  }

  for (const [shardId, shard] of historyShards.entries()) {
    writeJson(path.join(esaHistoryShardsDir, `${shardId}.json`), shard);
  }
}

// Sensor ids for getData come from /station/sensors ("Identyfikator stanowiska").
// The "Nr" field in /metadata/sensors is a different number and gives HTTP 400.
async function fetchGiosStationSensorIds(stationId) {
  const payload = await fetchJson(
    `https://api.gios.gov.pl/pjp-api/v1/rest/station/sensors/${stationId}`,
  );
  const sensors = extractList(payload, 'Lista stanowisk pomiarowych dla podanej stacji');
  const sensorIds = { pm25SensorIds: [], pm10SensorIds: [] };

  for (const sensor of sensors) {
    const code = (sensor?.['Wskaźnik - kod'] ?? '').toString().toUpperCase();
    const sensorId = sensor?.['Identyfikator stanowiska'];
    if (!sensorId) {
      continue;
    }
    if (code === 'PM2.5') {
      sensorIds.pm25SensorIds.push(sensorId);
    } else if (code === 'PM10') {
      sensorIds.pm10SensorIds.push(sensorId);
    }
  }

  return sensorIds;
}

async function buildGiosStationDetails(
  stationId,
  previousDetails,
  sensorIds,
  refreshMeasurements,
) {
  const pm25SensorIds = sensorIds?.pm25SensorIds ?? previousDetails?.pm25SensorIds ?? [];
  const pm10SensorIds = sensorIds?.pm10SensorIds ?? previousDetails?.pm10SensorIds ?? [];
  // Known manual sensors are skipped. The daily sensors refresh checks them
  // again, in case GIOŚ switches a sensor to automatic.
  const manualSensorIds = new Set(sensorIds ? [] : previousDetails?.manualSensorIds ?? []);
  let pm25History = (previousDetails?.pm25History ?? []).filter(
    (point) => Number(point?.value) > 0,
  );
  let pm10History = (previousDetails?.pm10History ?? []).filter(
    (point) => Number(point?.value) > 0,
  );

  if (refreshMeasurements) {
    const latestPm25History = await fetchFirstAvailableGiosHistory(pm25SensorIds, manualSensorIds);
    const latestPm10History = await fetchFirstAvailableGiosHistory(pm10SensorIds, manualSensorIds);
    pm25History = [...latestPm25History].reverse();
    pm10History = [...latestPm10History].reverse();
  }

  return {
    stationId,
    pm25SensorIds,
    pm10SensorIds,
    manualSensorIds: [...manualSensorIds],
    pm25Latest: pm25History.length > 0 ? pm25History[pm25History.length - 1].value : null,
    pm10Latest: pm10History.length > 0 ? pm10History[pm10History.length - 1].value : null,
    hasPm25Sensor: pm25SensorIds.length > 0,
    hasPm10Sensor: pm10SensorIds.length > 0,
    pm25History,
    pm10History,
  };
}

async function fetchFirstAvailableGiosHistory(sensorIds, manualSensorIds) {
  for (const sensorId of sensorIds) {
    if (manualSensorIds.has(sensorId)) {
      continue;
    }
    try {
      const payload = await fetchJson(
        `https://api.gios.gov.pl/pjp-api/v1/rest/data/getData/${sensorId}?page=0&size=500`,
      );
      const values = extractList(payload, 'Lista danych pomiarowych');
      const history = parseGiosHistory(values);
      if (history.length > 0) {
        return history;
      }
    } catch (error) {
      if (error.status === 400 && error.body?.includes(giosManualSensorError)) {
        manualSensorIds.add(sensorId);
        continue;
      }
      console.warn(`Skipping GIOŚ sensor ${sensorId}: ${error.message}`);
    }
  }
  return [];
}

// A station without an automatic PM sensor never has current values, so it
// would only show as "no data" on the map. An outage does not hide a station:
// only sensors GIOŚ reports as manual count.
function hasAutomaticPmSensor(details) {
  const manualSensorIds = new Set(details.manualSensorIds ?? []);
  return [...(details.pm25SensorIds ?? []), ...(details.pm10SensorIds ?? [])]
    .some((sensorId) => !manualSensorIds.has(sensorId));
}

// Returns false when GIOŚ was not due for a refresh and nothing was fetched.
async function fetchGiosData(metadata) {
  const refreshSensors = shouldRefresh(
    metadata,
    'giosStationSensorsUpdatedAt',
    giosSensorsTtlMs,
  );
  const refreshMeasurements = shouldRefresh(
    metadata,
    'giosMeasurementsUpdatedAt',
    giosMeasurementsTtlMs,
  );
  // The station list rarely changes, so it is fetched together with the
  // hourly measurements instead of on every run
  if (
    !refreshSensors &&
    !refreshMeasurements &&
    fs.existsSync(path.join(publicDir, 'gios_stations.json'))
  ) {
    console.log('GIOŚ is not due for a refresh, keeping previous data.');
    return false;
  }

  console.log('Fetching GIOŚ station list...');
  const stations = await fetchPagedGiosList(
    'https://api.gios.gov.pl/pjp-api/v1/rest/station/findAll',
    'Lista stacji pomiarowych',
  );
  console.log(
    `Fetched ${stations.length} GIOŚ stations. Sensors refresh: ${refreshSensors ? 'yes' : 'no'}. Measurements refresh: ${refreshMeasurements ? 'yes' : 'no'}.`,
  );

  const detailsByStation = new Map();

  if (refreshSensors || refreshMeasurements) {
    await runWithConcurrency(stations, 2, async (station) => {
      const stationId = station.id ?? station['Identyfikator stacji'];
      if (!stationId) {
        return;
      }

      const detailsPath = path.join(giosDetailsDir, `${stationId}.json`);
      const previousDetails = readJson(detailsPath, null);
      let sensorIds = null;

      if (refreshSensors) {
        try {
          sensorIds = await fetchGiosStationSensorIds(stationId);
        } catch (error) {
          // Keep the previously saved sensor ids
          console.warn(`Cannot fetch sensors for GIOŚ station ${stationId}: ${error.message}`);
        }
      }

      const details = await buildGiosStationDetails(
        stationId,
        previousDetails,
        sensorIds,
        refreshMeasurements || refreshSensors || !previousDetails,
      );
      if (details) {
        writeJson(detailsPath, details);
        detailsByStation.set(String(details.stationId), details);
      }
    });
    if (refreshSensors) {
      metadata.giosStationSensorsUpdatedAt = new Date().toISOString();
    }
    if (refreshMeasurements) {
      metadata.giosMeasurementsUpdatedAt = new Date().toISOString();
    }
  } else {
    for (const station of stations) {
      const stationId = station.id ?? station['Identyfikator stacji'];
      if (!stationId) {
        continue;
      }
      const details = readJson(
        path.join(giosDetailsDir, `${stationId}.json`),
        null,
      );
      if (details) {
        detailsByStation.set(String(stationId), details);
      }
    }
  }

  const enrichedStations = stations
    .filter((station) => {
      const stationId = station.id ?? station['Identyfikator stacji'];
      const details = detailsByStation.get(String(stationId));
      return !details || hasAutomaticPmSensor(details);
    })
    .map((station) => {
      const stationId = station.id ?? station['Identyfikator stacji'];
      const details = detailsByStation.get(String(stationId));
      return {
        ...station,
        pm25Latest: details?.pm25Latest ?? null,
        pm10Latest: details?.pm10Latest ?? null,
      };
    });

  fs.writeFileSync(
    path.join(publicDir, 'gios_stations.json'),
    JSON.stringify(enrichedStations),
  );
  console.log(
    `Saved gios_stations.json with ${enrichedStations.length} stations (${stations.length - enrichedStations.length} without automatic PM sensors left out).`,
  );
  return true;
}

// Each source is updated independently, so an ESA outage does not stop
// GIOŚ updates (and vice versa). The previous files stay in place for a
// source that failed. The run fails only when both sources fail.
async function run() {
  ensureDirs();
  const metadata = readMetadata();
  const failures = [];

  try {
    await fetchEsaData();
    metadata.esaUpdatedAt = new Date().toISOString();
  } catch (error) {
    failures.push('ESA');
    console.log(`::warning::ESA update failed, keeping previous data: ${error.message}`);
  }

  try {
    if (await fetchGiosData(metadata)) {
      metadata.giosStationsUpdatedAt = new Date().toISOString();
    }
  } catch (error) {
    failures.push('GIOŚ');
    console.log(`::warning::GIOŚ update failed, keeping previous data: ${error.message}`);
  }

  writeMetadata(metadata);
  if (failures.length === 2) {
    throw new Error('Both ESA and GIOŚ updates failed.');
  }
}

run().catch((error) => {
  console.error('Error in fetch script:', error);
  process.exit(1);
});
