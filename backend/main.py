
import os
from copy import deepcopy
from contextlib import asynccontextmanager
from datetime import date, datetime, time, timedelta, timezone

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pymongo import DESCENDING, MongoClient
from pymongo.errors import PyMongoError


# =========================================================
# CONFIGURATION
# =========================================================

load_dotenv()

MONGODB_URI = os.getenv(
    "MONGODB_URI",
    "mongodb://localhost:27017/",
)
MONGODB_DATABASE = os.getenv(
    "MONGODB_DATABASE",
    "hydroponics",
)

client = MongoClient(
    MONGODB_URI,
    serverSelectionTimeoutMS=3000,
    connectTimeoutMS=3000,
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
    "nutrient_ph": None,
    "ph": None,
    "electrical_conductivity": None,
    "nutrient_ec": None,
    "ec": None,
    "water_level": None,
}

DEFAULT_STATES = {
    "nutrients": {"A": 0, "B": 0, "C": 0},
    "actuators": {},
    "automation_settings": {},
    "calibration": {
        "ph_offset": 0.0,
        "ec_offset": 0.0,
        "temperature_offset": 0.0,
    },
}


# =========================================================
# MONGODB HELPERS
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


# =========================================================
# SENSOR NORMALIZATION
# =========================================================

def flatten_dashboard_payload(data):
    """Accept flat JSON and dashboard-style nested readings."""
    result = dict(data)

    for section_name in (
        "tank_parameters",
        "growing_environment",
    ):
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
    data = flatten_dashboard_payload(data)
    merged = dict(previous)
    merged.update(data)

    # Growing environment
    shades = deepcopy(previous.get("shades") or {})
    incoming_shades = data.get("shades")

    if isinstance(incoming_shades, dict):
        for name, values in incoming_shades.items():
            if isinstance(values, dict):
                existing = dict(shades.get(name) or {})
                existing.update(values)
                shades[name] = existing
            else:
                shades[name] = values

    shade_1 = dict(shades.get("shade_1") or {})

    if "shed_temperature" in data:
        shed_temperature = data["shed_temperature"]
    elif "temperature" in data:
        shed_temperature = data["temperature"]
    else:
        shed_temperature = shade_1.get(
            "temperature",
            previous.get("temperature"),
        )

    if "humidity" in data:
        humidity = data["humidity"]
    else:
        humidity = shade_1.get(
            "humidity",
            previous.get("humidity"),
        )

    if shed_temperature is not None:
        shade_1["temperature"] = shed_temperature

    if humidity is not None:
        shade_1["humidity"] = humidity

    if "light_intensity" in data:
        shade_1["light_intensity"] = data["light_intensity"]

    if shade_1:
        shades["shade_1"] = shade_1

    # Nutrient tank
    tank = deepcopy(
        previous.get("nutrient_tank") or DEFAULT_TANK
    )

    for key, value in DEFAULT_TANK.items():
        tank.setdefault(key, value)

    aliases = {
        "water_temperature": "tank_temperature",
        "tank_temperature": "tank_temperature",
        "temperature": "tank_temperature",
        "ph_level": "nutrient_ph",
        "nutrient_ph": "nutrient_ph",
        "ph": "nutrient_ph",
        "pH": "nutrient_ph",
        "electrical_conductivity": "nutrient_ec",
        "nutrient_ec": "nutrient_ec",
        "ec": "nutrient_ec",
        "EC": "nutrient_ec",
        "water_level": "water_level",
    }

    incoming_tank = data.get("nutrient_tank")

    if isinstance(incoming_tank, dict):
        for key, value in incoming_tank.items():
            normalized_key = aliases.get(key, key)

            if normalized_key in DEFAULT_TANK:
                tank[normalized_key] = value

    for incoming_key, tank_key in aliases.items():
        if incoming_key in data:
            tank[tank_key] = data[incoming_key]

    # Do not let a tank temperature overwrite the shed temperature.
    if "temperature" not in data and "shed_temperature" not in data:
        merged["temperature"] = previous.get("temperature")

    merged["temperature"] = shed_temperature
    merged["shed_temperature"] = shed_temperature
    merged["humidity"] = humidity
    merged["shades"] = shades
    merged["nutrient_tank"] = tank

    # Frontend-compatible aliases
    merged["water_temperature"] = tank["tank_temperature"]
    merged["ph_level"] = tank["nutrient_ph"]
    merged["nutrient_ph"] = tank["nutrient_ph"]
    merged["ph"] = tank["nutrient_ph"]
    merged["electrical_conductivity"] = tank["nutrient_ec"]
    merged["nutrient_ec"] = tank["nutrient_ec"]
    merged["ec"] = tank["nutrient_ec"]
    merged["water_level"] = tank["water_level"]

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

    timestamp = row.get("timestamp")
    temperature = row.get("temperature")
    humidity = row.get("humidity")

    result.update({
        "temperature": temperature,
        "shed_temperature": temperature,
        "humidity": humidity,
        "timestamp": timestamp.isoformat() if timestamp else None,
        "shades": row.get("shades") or {},
        "nutrient_tank": tank,
        "water_temperature": tank["tank_temperature"],
        "ph_level": tank["nutrient_ph"],
        "nutrient_ph": tank["nutrient_ph"],
        "ph": tank["nutrient_ph"],
        "electrical_conductivity": tank["nutrient_ec"],
        "nutrient_ec": tank["nutrient_ec"],
        "ec": tank["nutrient_ec"],
        "water_level": tank["water_level"],
    })

    return result


# =========================================================
# APPLICATION LIFESPAN
# =========================================================

@asynccontextmanager
async def lifespan(app: FastAPI):
    try:
        # MongoDB being unavailable will not prevent /docs from opening.
        try:
            client.admin.command("ping")
            readings.create_index([("timestamp", DESCENDING)])

            for key, value in DEFAULT_STATES.items():
                app_state.update_one(
                    {"_id": key},
                    {"$setOnInsert": {"value": value}},
                    upsert=True,
                )

            print("MongoDB connected successfully.")

        except PyMongoError as exc:
            print(f"MongoDB is not available yet: {exc}")
            print("FastAPI will start, but database operations may fail.")

        yield

    finally:
        client.close()


app = FastAPI(
    title="Hydroponics Controller API",
    version="5.0.0",
    lifespan=lifespan,
)

cors_origins = [
    origin.strip()
    for origin in os.getenv(
        "API_CORS_ORIGINS",
        "http://localhost:5173,http://127.0.0.1:5173",
    ).split(",")
    if origin.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
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

    except PyMongoError as exc:
        raise HTTPException(
            status_code=503,
            detail=f"MongoDB connection failed: {exc}",
        )


# =========================================================
# SENSOR READINGS
# =========================================================

@app.get("/api/sensors")
def get_sensor_data():
    try:
        return latest_sensor_data()

    except PyMongoError as exc:
        raise HTTPException(
            status_code=503,
            detail=f"Could not retrieve sensor readings: {exc}",
        )


@app.post("/api/sensors")
def receive_sensor_data(data: dict):
    """
    Receive sensor JSON without login during local testing.
    Saves readings in MongoDB.
    """
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
            "message": "Sensor readings saved to MongoDB.",
            "id": str(result.inserted_id),
            "received": merged,
        }

    except PyMongoError as exc:
        raise HTTPException(
            status_code=503,
            detail=f"Could not save sensor reading to MongoDB: {exc}",
        )


# =========================================================
# SENSOR HISTORY
# =========================================================

@app.get("/api/sensors/history")
def get_sensor_history(
    from_date: date | None = Query(default=None),
    to_date: date | None = Query(default=None),
    from_time: time | None = Query(default=None),
    to_time: time | None = Query(default=None),
    limit: int = Query(default=100, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
):
    if from_date and to_date and from_date > to_date:
        raise HTTPException(
            status_code=400,
            detail="from_date must not be after to_date.",
        )

    if from_time and to_time and from_time > to_time:
        raise HTTPException(
            status_code=400,
            detail="from_time must not be after to_time.",
        )

    filters = {}
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

    if from_time or to_time:
        clock_expression = {
            "$dateToString": {
                "format": "%H:%M:%S",
                "date": "$timestamp",
                "timezone": "UTC",
            }
        }

        conditions = []

        if from_time:
            conditions.append({
                "$gte": [
                    clock_expression,
                    from_time.strftime("%H:%M:%S"),
                ]
            })

        if to_time:
            conditions.append({
                "$lte": [
                    clock_expression,
                    to_time.strftime("%H:%M:%S"),
                ]
            })

        filters["$expr"] = (
            conditions[0]
            if len(conditions) == 1
            else {"$and": conditions}
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
                "time": timestamp.isoformat() if timestamp else None,
                "timestamp": timestamp.isoformat() if timestamp else None,
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

    except PyMongoError as exc:
        raise HTTPException(
            status_code=503,
            detail=f"Could not retrieve sensor history: {exc}",
        )


# =========================================================
# NUTRIENTS
# =========================================================

@app.get("/api/nutrients")
def get_nutrients():
    try:
        return {"nutrients": get_state("nutrients")}

    except PyMongoError as exc:
        raise HTTPException(
            status_code=503,
            detail=f"Could not retrieve nutrients: {exc}",
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
            detail="Invalid nutrient value.",
        )

    if not 0 <= value <= 100000:
        raise HTTPException(
            status_code=400,
            detail="Nutrient value must be between 0 and 100000.",
        )

    try:
        values = dict(get_state("nutrients"))
        values[name] = value
        save_state("nutrients", values)

        return {"success": True, "nutrients": values}

    except PyMongoError as exc:
        raise HTTPException(
            status_code=503,
            detail=f"Could not save nutrients: {exc}",
        )


# =========================================================
# ACTUATORS
# =========================================================

@app.get("/api/actuators")
def get_actuators():
    try:
        return {"actuators": get_state("actuators")}

    except PyMongoError as exc:
        raise HTTPException(
            status_code=503,
            detail=f"Could not retrieve actuators: {exc}",
        )


@app.post("/api/actuators")
def control_actuator(data: dict):
    name = str(data.get("name", "")).strip()
    state = str(data.get("state", "")).strip().upper()

    if not name:
        raise HTTPException(
            status_code=400,
            detail="Missing actuator name.",
        )

    if state not in ("ON", "OFF"):
        raise HTTPException(
            status_code=400,
            detail="State must be ON or OFF.",
        )

    if len(name) > 100:
        raise HTTPException(
            status_code=400,
            detail="Actuator name is too long.",
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
                "Command stored in MongoDB. Physical hardware control "
                "requires controller integration."
            ),
        }

    except PyMongoError as exc:
        raise HTTPException(
            status_code=503,
            detail=f"Could not save actuator state: {exc}",
        )


# =========================================================
# AUTOMATION
# =========================================================

@app.get("/api/automation")
def get_automation():
    try:
        return {"settings": get_state("automation_settings")}

    except PyMongoError as exc:
        raise HTTPException(
            status_code=503,
            detail=f"Could not retrieve automation settings: {exc}",
        )


@app.post("/api/automation")
def save_automation(data: dict):
    if not data:
        raise HTTPException(
            status_code=400,
            detail="Provide at least one automation setting.",
        )

    if len(data) > 100:
        raise HTTPException(
            status_code=400,
            detail="Too many automation settings.",
        )

    try:
        settings = dict(get_state("automation_settings"))
        settings.update(data)
        save_state("automation_settings", settings)

        return {"success": True, "settings": settings}

    except PyMongoError as exc:
        raise HTTPException(
            status_code=503,
            detail=f"Could not save automation settings: {exc}",
        )


# =========================================================
# SENSOR CALIBRATION
# =========================================================

@app.get("/api/calibration")
def get_calibration():
    try:
        calibration = deepcopy(DEFAULT_STATES["calibration"])
        calibration.update(get_state("calibration"))

        return {"calibration": calibration}

    except PyMongoError as exc:
        raise HTTPException(
            status_code=503,
            detail=f"Could not retrieve calibration: {exc}",
        )


@app.post("/api/calibration")
def save_calibration(data: dict):
    allowed_fields = {
        "ph_offset",
        "ec_offset",
        "temperature_offset",
    }

    try:
        calibration = deepcopy(DEFAULT_STATES["calibration"])
        calibration.update(get_state("calibration"))

        for name, value in data.items():
            if name not in allowed_fields:
                raise HTTPException(
                    status_code=400,
                    detail=f"Unsupported calibration field: {name}",
                )

            try:
                number = float(value)
            except (TypeError, ValueError):
                raise HTTPException(
                    status_code=400,
                    detail=f"Calibration value for {name} must be numeric.",
                )

            if not -100000 <= number <= 100000:
                raise HTTPException(
                    status_code=400,
                    detail=f"Calibration value for {name} is out of range.",
                )

            calibration[name] = number

        save_state("calibration", calibration)

        return {"success": True, "calibration": calibration}

    except PyMongoError as exc:
        raise HTTPException(
            status_code=503,
            detail=f"Could not save calibration: {exc}",
        )
