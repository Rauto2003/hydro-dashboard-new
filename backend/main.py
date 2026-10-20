
import os
from copy import deepcopy
from contextlib import asynccontextmanager
from datetime import date, datetime, time, timedelta, timezone
from typing import Optional

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pymongo import DESCENDING, MongoClient
from pymongo.errors import PyMongoError


# =========================================================
# CONFIGURATION
# =========================================================

load_dotenv()

MONGODB_URI = os.getenv("MONGODB_URI")
MONGODB_DATABASE = os.getenv("MONGODB_DATABASE", "hydroponics")

if not MONGODB_URI:
    raise RuntimeError(
        "MONGODB_URI is missing from backend/.env"
    )

client = MongoClient(
    MONGODB_URI,
    serverSelectionTimeoutMS=10000,
    tz_aware=True,
)

db = client[MONGODB_DATABASE]

readings = db["sensor_readings"]
app_state = db["app_state"]


# =========================================================
# DEFAULT DATA
# =========================================================

DEFAULT_TANK = {
    "tank_temperature": None,
    "nutrient_ph": None,
    "nutrient_ec": None,
    "water_level": None,
}

DEFAULT_SENSOR_DATA = {
    "temperature": None,
    "shed_temperature": None,
    "humidity": None,
    "timestamp": None,
    "shades": {},
    "nutrient_tank": deepcopy(DEFAULT_TANK),
    "water_temperature": None,
    "ph_level": None,
    "electrical_conductivity": None,
    "water_level": None,
}

DEFAULT_STATES = {
    "nutrients": {
        "A": 0,
        "B": 0,
        "C": 0,
    },
    "actuators": {},
    "automation_settings": {},
    "calibration": {},
}


# =========================================================
# HELPERS
# =========================================================

def utc_now():
    return datetime.now(timezone.utc)


def get_state(key):
    record = app_state.find_one({"_id": key})

    if record is None:
        return deepcopy(DEFAULT_STATES[key])

    return record.get(
        "value",
        deepcopy(DEFAULT_STATES[key]),
    )


def save_state(key, value):
    app_state.update_one(
        {"_id": key},
        {"$set": {"value": value}},
        upsert=True,
    )


def flatten_dashboard_payload(data):
    """
    Accept the dashboard JSON structure:

    {
      "tank_parameters": {
        "readings": [
          {"key": "water_temperature", "value": 25.5}
        ]
      },
      "growing_environment": {
        "readings": [
          {"key": "humidity", "value": 68}
        ]
      }
    }

    Also accepts a normal flat sensor payload.
    """
    result = dict(data)

    sections = (
        "tank_parameters",
        "growing_environment",
    )

    for section_name in sections:
        section = result.get(section_name)

        if not isinstance(section, dict):
            continue

        section_readings = section.get("readings", [])

        if not isinstance(section_readings, list):
            continue

        for reading in section_readings:
            if not isinstance(reading, dict):
                continue

            key = reading.get("key")

            if key and "value" in reading:
                result[key] = reading["value"]

    return result


def normalize_sensor_payload(data, previous):
    """
    Normalize dashboard and hardware payloads to one schema.

    Canonical fields:
      shades.shade_1.temperature
      shades.shade_1.humidity
      nutrient_tank.tank_temperature
      nutrient_tank.nutrient_ph
      nutrient_tank.nutrient_ec
      nutrient_tank.water_level

    Unsent values are preserved from the previous reading.
    Explicitly supplied null values remain null.
    """

    data = flatten_dashboard_payload(data)
    merged = dict(previous)
    merged.update(data)

    # -----------------------------------------------------
    # GROWING SHED / SHADES
    # -----------------------------------------------------

    shades = deepcopy(previous.get("shades") or {})
    incoming_shades = data.get("shades")

    if isinstance(incoming_shades, dict):
        for shade_name, shade_values in incoming_shades.items():
            if isinstance(shade_values, dict):
                existing = dict(shades.get(shade_name) or {})
                existing.update(shade_values)
                shades[shade_name] = existing
            else:
                shades[shade_name] = shade_values

    shade_1 = dict(shades.get("shade_1") or {})

    # Accept both shed_temperature and temperature.
    if "shed_temperature" in data:
        shed_temperature = data["shed_temperature"]
        shade_1["temperature"] = shed_temperature
    elif "temperature" in data:
        shed_temperature = data["temperature"]
        shade_1["temperature"] = shed_temperature
    else:
        shed_temperature = shade_1.get(
            "temperature",
            previous.get("temperature"),
        )

    if "humidity" in data:
        humidity = data["humidity"]
        shade_1["humidity"] = humidity
    else:
        humidity = shade_1.get(
            "humidity",
            previous.get("humidity"),
        )

    if "light_intensity" in data:
        shade_1["light_intensity"] = data["light_intensity"]

    if shade_1:
        shades["shade_1"] = shade_1

    # -----------------------------------------------------
    # NUTRIENT TANK
    # -----------------------------------------------------

    tank = deepcopy(
        previous.get("nutrient_tank") or DEFAULT_TANK
    )

    # Ensure all expected tank keys exist.
    for key, value in DEFAULT_TANK.items():
        tank.setdefault(key, value)

    incoming_tank = data.get("nutrient_tank")

    if isinstance(incoming_tank, dict):
        nested_aliases = {
            "water_temperature": "tank_temperature",
            "ph_level": "nutrient_ph",
            "electrical_conductivity": "nutrient_ec",
        }

        for key, value in incoming_tank.items():
            normalized_key = nested_aliases.get(key, key)
            tank[normalized_key] = value

    # Flat dashboard fields and flat hardware fields.
    flat_aliases = {
        "water_temperature": "tank_temperature",
        "tank_temperature": "tank_temperature",
        "ph_level": "nutrient_ph",
        "nutrient_ph": "nutrient_ph",
        "electrical_conductivity": "nutrient_ec",
        "nutrient_ec": "nutrient_ec",
        "water_level": "water_level",
    }

    for incoming_key, tank_key in flat_aliases.items():
        if incoming_key in data:
            tank[tank_key] = data[incoming_key]

    # -----------------------------------------------------
    # CONSISTENT RESPONSE
    # -----------------------------------------------------

    merged["temperature"] = shed_temperature
    merged["shed_temperature"] = shed_temperature
    merged["humidity"] = humidity
    merged["shades"] = shades
    merged["nutrient_tank"] = tank

    # Dashboard-friendly aliases.
    merged["water_temperature"] = tank.get("tank_temperature")
    merged["ph_level"] = tank.get("nutrient_ph")
    merged["electrical_conductivity"] = tank.get("nutrient_ec")
    merged["water_level"] = tank.get("water_level")

    return merged


def latest_sensor_data():
    row = readings.find_one(
        {},
        sort=[
            ("timestamp", DESCENDING),
            ("_id", DESCENDING),
        ],
    )

    if row is None:
        return deepcopy(DEFAULT_SENSOR_DATA)

    result = dict(row.get("raw_payload") or {})
    tank = deepcopy(DEFAULT_TANK)
    tank.update(row.get("nutrient_tank") or {})

    temperature = row.get("temperature")
    humidity = row.get("humidity")
    timestamp = row.get("timestamp")

    result.update({
        "temperature": temperature,
        "shed_temperature": temperature,
        "humidity": humidity,
        "timestamp": (
            timestamp.isoformat() if timestamp else None
        ),
        "shades": row.get("shades") or {},
        "nutrient_tank": tank,
        "water_temperature": tank.get("tank_temperature"),
        "ph_level": tank.get("nutrient_ph"),
        "electrical_conductivity": tank.get("nutrient_ec"),
        "water_level": tank.get("water_level"),
    })

    return result


# =========================================================
# APPLICATION LIFESPAN
# =========================================================

@asynccontextmanager
async def lifespan(app: FastAPI):
    try:
        client.admin.command("ping")

        readings.create_index([
            ("timestamp", DESCENDING),
        ])

        for key, value in DEFAULT_STATES.items():
            app_state.update_one(
                {"_id": key},
                {"$setOnInsert": {"value": value}},
                upsert=True,
            )

        yield

    finally:
        client.close()


app = FastAPI(
    title="Hydroponics Controller API",
    version="3.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


# =========================================================
# HOME AND DATABASE HEALTH
# =========================================================

@app.get("/")
def home():
    return {
        "status": "online",
        "message": "Hydroponics API",
        "storage": "MongoDB",
        "database": MONGODB_DATABASE,
    }


@app.get("/health/db")
def database_health():
    try:
        client.admin.command("ping")

        return {
            "status": "connected",
            "database": MONGODB_DATABASE,
        }

    except PyMongoError:
        raise HTTPException(
            status_code=503,
            detail="MongoDB connection failed",
        )


# =========================================================
# SENSOR READINGS
# =========================================================

@app.get("/api/sensors")
def get_sensor_data():
    try:
        return latest_sensor_data()

    except PyMongoError:
        raise HTTPException(
            status_code=500,
            detail="Could not retrieve sensor readings",
        )


@app.post("/api/sensors")
def receive_sensor_data(data: dict):
    try:
        previous = latest_sensor_data()
        merged = normalize_sensor_payload(data, previous)

        timestamp = utc_now()
        merged["timestamp"] = timestamp.isoformat()

        record = {
            "timestamp": timestamp,
            "temperature": merged.get("temperature"),
            "humidity": merged.get("humidity"),
            "shades": merged.get("shades") or {},
            "nutrient_tank": merged.get("nutrient_tank") or {},
            "raw_payload": merged,
        }

        result = readings.insert_one(record)

        return {
            "success": True,
            "message": "Sensor readings saved to MongoDB",
            "id": str(result.inserted_id),
            "received": merged,
        }

    except PyMongoError:
        raise HTTPException(
            status_code=500,
            detail="Could not save sensor reading to MongoDB",
        )


# =========================================================
# SENSOR HISTORY
# =========================================================

@app.get("/api/sensors/history")
def get_sensor_history(
    from_date: Optional[date] = Query(default=None),
    to_date: Optional[date] = Query(default=None),
    from_time: Optional[time] = Query(default=None),
    to_time: Optional[time] = Query(default=None),
    limit: int = Query(default=100, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
):
    if from_date and to_date and from_date > to_date:
        raise HTTPException(
            status_code=400,
            detail="from_date must not be after to_date",
        )

    if from_time and to_time and from_time > to_time:
        raise HTTPException(
            status_code=400,
            detail="from_time must not be after to_time",
        )

    filters = {}

    # Date filtering uses UTC calendar days.
    timestamp_filter = {}

    if from_date:
        timestamp_filter["$gte"] = datetime.combine(
            from_date,
            time.min,
            tzinfo=timezone.utc,
        )

    if to_date:
        timestamp_filter["$lt"] = datetime.combine(
            to_date + timedelta(days=1),
            time.min,
            tzinfo=timezone.utc,
        )

    if timestamp_filter:
        filters["timestamp"] = timestamp_filter

    # Filter by UTC clock time in MongoDB before pagination.
    if from_time or to_time:
        clock_expression = {
            "$dateToString": {
                "format": "%H:%M:%S",
                "date": "$timestamp",
                "timezone": "UTC",
            }
        }

        clock_conditions = []

        if from_time:
            clock_conditions.append({
                "$gte": [
                    clock_expression,
                    from_time.strftime("%H:%M:%S"),
                ]
            })

        if to_time:
            clock_conditions.append({
                "$lte": [
                    clock_expression,
                    to_time.strftime("%H:%M:%S"),
                ]
            })

        filters["$expr"] = (
            clock_conditions[0]
            if len(clock_conditions) == 1
            else {"$and": clock_conditions}
        )

    try:
        total = readings.count_documents(filters)

        rows = list(
            readings.find(filters)
            .sort([
                ("timestamp", DESCENDING),
                ("_id", DESCENDING),
            ])
            .skip(offset)
            .limit(limit)
        )

        history = []

        for row in rows:
            timestamp = row.get("timestamp")
            tank = deepcopy(DEFAULT_TANK)
            tank.update(row.get("nutrient_tank") or {})

            history.append({
                "id": str(row["_id"]),
                "time": (
                    timestamp.isoformat() if timestamp else None
                ),
                "timestamp": (
                    timestamp.isoformat() if timestamp else None
                ),
                "temperature": row.get("temperature"),
                "shed_temperature": row.get("temperature"),
                "humidity": row.get("humidity"),
                "shades": row.get("shades") or {},
                "nutrient_tank": tank,
                "data": row.get("raw_payload") or {},
            })

        return {
            "total": total,
            "limit": limit,
            "offset": offset,
            "history": history,
        }

    except PyMongoError:
        raise HTTPException(
            status_code=500,
            detail="Could not retrieve sensor history",
        )


# =========================================================
# NUTRIENTS
# =========================================================

@app.get("/api/nutrients")
def get_nutrients():
    try:
        return {
            "nutrients": get_state("nutrients"),
        }

    except PyMongoError:
        raise HTTPException(
            status_code=500,
            detail="Could not retrieve nutrients",
        )


@app.post("/api/nutrients")
def set_nutrient(data: dict):
    name = str(data.get("name", "")).strip().upper()

    if name not in ("A", "B", "C"):
        raise HTTPException(
            status_code=400,
            detail="Unknown nutrient. Use A, B, or C.",
        )

    try:
        value = float(data.get("value"))
    except (TypeError, ValueError):
        raise HTTPException(
            status_code=400,
            detail="Invalid nutrient value",
        )

    if value < 0:
        raise HTTPException(
            status_code=400,
            detail="Value cannot be negative",
        )

    try:
        values = dict(get_state("nutrients"))
        values[name] = value
        save_state("nutrients", values)

        return {
            "success": True,
            "nutrients": values,
        }

    except PyMongoError:
        raise HTTPException(
            status_code=500,
            detail="Could not save nutrients",
        )


# =========================================================
# ACTUATORS
# =========================================================

@app.get("/api/actuators")
def get_actuators():
    try:
        return {
            "actuators": get_state("actuators"),
        }

    except PyMongoError:
        raise HTTPException(
            status_code=500,
            detail="Could not retrieve actuators",
        )


@app.post("/api/actuators")
def control_actuator(data: dict):
    name = str(data.get("name", "")).strip()
    state = str(data.get("state", "")).strip().upper()

    if not name:
        raise HTTPException(
            status_code=400,
            detail="Missing actuator name",
        )

    if state not in ("ON", "OFF"):
        raise HTTPException(
            status_code=400,
            detail="State must be ON or OFF",
        )

    try:
        actuators = dict(get_state("actuators"))
        actuators[name] = state
        save_state("actuators", actuators)

        return {
            "success": True,
            "name": name,
            "state": state,
            "message": (
                "Command stored in MongoDB. Physical hardware "
                "control requires controller integration."
            ),
        }

    except PyMongoError:
        raise HTTPException(
            status_code=500,
            detail="Could not save actuator state",
        )


# =========================================================
# AUTOMATION
# =========================================================

@app.get("/api/automation")
def get_automation():
    try:
        return {
            "settings": get_state("automation_settings"),
        }

    except PyMongoError:
        raise HTTPException(
            status_code=500,
            detail="Could not retrieve automation settings",
        )


@app.post("/api/automation")
def save_automation(data: dict):
    try:
        settings = dict(get_state("automation_settings"))
        settings.update(data)
        save_state("automation_settings", settings)

        return {
            "success": True,
            "settings": settings,
        }

    except PyMongoError:
        raise HTTPException(
            status_code=500,
            detail="Could not save automation settings",
        )


# =========================================================
# SENSOR CALIBRATION
# =========================================================

@app.get("/api/calibration")
def get_calibration():
    try:
        return {
            "calibration": get_state("calibration"),
        }

    except PyMongoError:
        raise HTTPException(
            status_code=500,
            detail="Could not retrieve calibration settings",
        )


@app.post("/api/calibration")
def save_calibration(data: dict):
    calibration = dict(get_state("calibration"))

    for name, value in data.items():
        try:
            number = float(value)
        except (TypeError, ValueError):
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Calibration value for {name} "
                    "must be numeric"
                ),
            )

        if not name.strip():
            raise HTTPException(
                status_code=400,
                detail="Calibration field name cannot be empty",
            )

        calibration[name] = number

    try:
        save_state("calibration", calibration)

        return {
            "success": True,
            "calibration": calibration,
        }

    except PyMongoError:
        raise HTTPException(
            status_code=500,
            detail="Could not save calibration settings",
        )
