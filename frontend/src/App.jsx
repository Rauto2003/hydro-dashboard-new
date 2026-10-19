
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  getSensors,
  getNutrients,
  setNutrient,
  getActuators,
  controlActuator,
  getAutomation,
  saveAutomation,
  getCalibration,
  saveCalibration,
  getSensorHistory,
  login,
  getCurrentUser,
  logout,
  getUser,
  isAdmin,
} from "./services/api";

import {
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Tooltip,
  Legend,
} from "recharts";

import "./App.css";

// ============================================================
// CONFIGURATION
// ============================================================

const SENSOR_GROUPS = {
  tank: [
    {
      key: "temperature",
      aliases: [
        "temperature",
        "tank_temperature",
        "water_temperature",
        "water_temp",
      ],
      nestedAliases: [
        "tank_temperature",
        "water_temperature",
        "temperature",
      ],
      label: "Water Temperature",
      unit: "°C",
      icon: "🌡️",
    },
    {
      key: "ph",
      aliases: ["ph", "pH", "ph_level", "water_ph", "nutrient_ph"],
      nestedAliases: ["nutrient_ph", "ph_level", "ph", "pH"],
      label: "pH Level",
      unit: "pH",
      icon: "🧪",
    },
    {
      key: "ec",
      aliases: [
        "ec",
        "EC",
        "ec_level",
        "electrical_conductivity",
        "nutrient_ec",
      ],
      nestedAliases: [
        "nutrient_ec",
        "electrical_conductivity",
        "ec_level",
        "ec",
        "EC",
      ],
      label: "Electrical Conductivity",
      unit: "mS/cm",
      icon: "⚡",
    },
    {
      key: "water_level",
      aliases: ["water_level", "waterLevel", "tank_level"],
      nestedAliases: ["water_level", "waterLevel", "tank_level"],
      label: "Water Level",
      unit: "%",
      icon: "💧",
    },
  ],

  shed: [
    {
      key: "air_temperature",
      aliases: [
        "air_temperature",
        "shed_temperature",
        "air_temp",
        "temperature",
      ],
      nestedAliases: ["air_temperature", "shed_temperature", "air_temp"],
      label: "Shed Temperature",
      unit: "°C",
      icon: "🌤️",
    },
    {
      key: "humidity",
      aliases: ["humidity", "air_humidity"],
      nestedAliases: ["humidity", "air_humidity"],
      label: "Humidity",
      unit: "%",
      icon: "💨",
    },
  ],
};

const ALL_SENSORS = [
  ...SENSOR_GROUPS.tank,
  ...SENSOR_GROUPS.shed,
];

const ACTUATORS = [
  {
    key: "cooling",
    label: "Cooling System",
    icon: "❄️",
    group: "environment",
  },
  {
    key: "fan",
    label: "Exhaust Fan",
    icon: "🌀",
    group: "environment",
  },
  {
    key: "fogger",
    label: "Fogger",
    icon: "🌫️",
    group: "environment",
  },
  {
    key: "pump",
    label: "Water Pump",
    icon: "🚿",
    group: "tank",
  },
];

const DEFAULT_AUTOMATION = {
  cooling_off: 25,
  cooling_on: 28,
  fan_off: 27,
  fan_on: 30,
  fogger_off: 75,
  fogger_on: 65,
};

const DEFAULT_CALIBRATION = {
  ph_offset: 0,
  ec_offset: 0,
  temperature_offset: 0,
};

const DEFAULT_NUTRIENTS = {
  A: 0,
  B: 0,
  C: 0,
};

const HISTORY_COLORS = [
  "#16a34a",
  "#0ea5e9",
  "#f59e0b",
  "#8b5cf6",
  "#ef4444",
  "#64748b",
];

const NAV_ITEMS = [
  { key: "dashboard", label: "Dashboard", icon: "▦" },
  { key: "control", label: "Control", icon: "⚙" },
  { key: "calibration", label: "Calibration", icon: "⌁" },
  { key: "history", label: "History", icon: "◷" },
];

// ============================================================
// HELPER FUNCTIONS
// ============================================================

function unwrapObject(response, preferredKeys = []) {
  if (!response || typeof response !== "object") return {};

  for (const key of preferredKeys) {
    if (
      response[key] &&
      typeof response[key] === "object" &&
      !Array.isArray(response[key])
    ) {
      return response[key];
    }
  }

  return response;
}

function getLatestSensorRecord(response) {
  if (Array.isArray(response)) {
    return response[response.length - 1] || {};
  }

  if (!response || typeof response !== "object") {
    return {};
  }

  if (Array.isArray(response.data)) {
    return response.data[response.data.length - 1] || {};
  }

  if (response.data && typeof response.data === "object") {
    return response.data;
  }

  if (response.latest && typeof response.latest === "object") {
    return response.latest;
  }

  return response;
}

function readAliases(source, aliases) {
  if (!source || typeof source !== "object") {
    return undefined;
  }

  for (const alias of aliases) {
    const value = source[alias];

    if (
      value !== undefined &&
      value !== null &&
      value !== ""
    ) {
      return value;
    }
  }

  return undefined;
}

function getSensorValue(record, sensor) {
  if (!record || typeof record !== "object") {
    return undefined;
  }

  const directValue = readAliases(record, sensor.aliases);

  if (directValue !== undefined) {
    return directValue;
  }

  const nestedSources = [
    record.nutrient_tank,
    record.tank,
    record.sensors,
    record.data,
    record.environment,
  ];

  for (const nested of nestedSources) {
    const value = readAliases(
      nested,
      sensor.nestedAliases || sensor.aliases
    );

    if (value !== undefined) {
      return value;
    }
  }

  return undefined;
}

function displayValue(value, unit = "") {
  if (value === undefined || value === null || value === "") {
    return "—";
  }

  const number = Number(value);

  const formatted = Number.isFinite(number)
    ? number.toLocaleString("en-IN", {
        maximumFractionDigits: 2,
      })
    : String(value);

  return `${formatted}${unit ? ` ${unit}` : ""}`;
}

function formatLabel(value) {
  return String(value)
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function formatTimestamp(record) {
  const value =
    record?.timestamp ??
    record?.created_at ??
    record?.time ??
    record?.date;

  if (!value) return "—";

  const date = new Date(value);

  return Number.isNaN(date.getTime())
    ? String(value)
    : date.toLocaleString("en-IN");
}

function isActuatorOn(value) {
  if (value === true || value === 1) return true;

  if (typeof value === "string") {
    return ["on", "true", "1", "active", "running"].includes(
      value.toLowerCase()
    );
  }

  return false;
}

// ============================================================
// REUSABLE COMPONENTS
// ============================================================

function SectionHeading({ eyebrow, title, description }) {
  return (
    <div className="section-heading">
      <div>
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h2>{title}</h2>

        {description && (
          <p className="section-description">{description}</p>
        )}
      </div>
    </div>
  );
}

function SensorCard({ sensor, value }) {
  const missing =
    value === undefined || value === null || value === "";

  return (
    <article className="sensor-card" key={sensor.key}>
      <div className="sensor-card-top">
        <span className="sensor-icon">{sensor.icon}</span>

        <span
          className={`sensor-live-dot ${
            missing ? "sensor-dot-muted" : ""
          }`}
          title={
            missing
              ? "No reading available"
              : "Reading available"
          }
        />
      </div>

      <p className="sensor-label">{sensor.label}</p>

      <h3 className="sensor-value">
        {displayValue(value, sensor.unit)}
      </h3>

      <p className="sensor-caption">
        {missing ? "Waiting for sensor data" : "Latest reading"}
      </p>
    </article>
  );
}

function LoginScreen({ onLogin, busy, error }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  async function submit(event) {
    event.preventDefault();

    if (!username.trim() || !password) return;

    await onLogin(username.trim(), password);
  }

  return (
    <div className="login-screen">
      <div className="login-card">
        <div className="login-brand-icon">🌱</div>

        <p className="eyebrow">SMART AGRICULTURE</p>

        <h1>Welcome to HYDRO</h1>

        <p className="login-description">
          Monitor your hydroponics system and manage your
          greenhouse from one dashboard.
        </p>

        {error && (
          <div className="alert alert-error" role="alert">
            {error}
          </div>
        )}

        <form
          className="settings-form login-form"
          onSubmit={submit}
        >
          <label className="field">
            <span>Username</span>

            <input
              autoComplete="username"
              value={username}
              onChange={(event) =>
                setUsername(event.target.value)
              }
              placeholder="Enter username"
              required
            />
          </label>

          <label className="field">
            <span>Password</span>

            <div className="password-input-wrap">
              <input
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                value={password}
                onChange={(event) =>
                  setPassword(event.target.value)
                }
                placeholder="Enter password"
                required
              />

              <button
                className="password-toggle"
                type="button"
                onClick={() =>
                  setShowPassword((current) => !current)
                }
              >
                {showPassword ? "Hide" : "Show"}
              </button>
            </div>
          </label>

          <button
            className="button button-primary login-submit"
            type="submit"
            disabled={busy}
          >
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <p className="login-footnote">
          Local testing account
        </p>
      </div>
    </div>
  );
}

// ============================================================
// MAIN APPLICATION
// ============================================================

function App() {
  const [user, setUser] = useState(() => getUser());

  const [authChecking, setAuthChecking] = useState(
    Boolean(getUser())
  );

  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState("");

  const [page, setPage] = useState("dashboard");
  const [controlExpanded, setControlExpanded] = useState(false);
  const [controlPage, setControlPage] = useState("environment");

  const [sensors, setSensors] = useState({});
  const [nutrients, setNutrients] = useState(DEFAULT_NUTRIENTS);

  const [automation, setAutomation] = useState(
    DEFAULT_AUTOMATION
  );

  const [actuatorStates, setActuatorStates] = useState({});

  const [calibration, setCalibration] = useState(
    DEFAULT_CALIBRATION
  );

  const [history, setHistory] = useState([]);

  const [historyFilters, setHistoryFilters] = useState({
    from_date: "",
    to_date: "",
    from_time: "",
    to_time: "",
  });

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [lastUpdated, setLastUpdated] = useState(null);

  const admin = Boolean(
    user &&
      (user.role === "admin" || isAdmin())
  );

  const showNotice = useCallback((message) => {
    setNotice(message);

    window.setTimeout(() => {
      setNotice("");
    }, 3500);
  }, []);

  // ----------------------------------------------------------
  // LOGIN
  // ----------------------------------------------------------

  useEffect(() => {
    let active = true;

    async function verifySession() {
      if (!getUser()) {
        if (active) setAuthChecking(false);
        return;
      }

      try {
        const result = await getCurrentUser();

        if (active && result) {
          setUser(result.user ?? result);
        }
      } catch {
        if (active) {
          logout();
          setUser(null);
        }
      } finally {
        if (active) {
          setAuthChecking(false);
        }
      }
    }

    verifySession();

    return () => {
      active = false;
    };
  }, []);

  const handleLogin = async (username, password) => {
    setLoginBusy(true);
    setLoginError("");

    try {
      // Temporary local credentials:
      // username: admin
      // password: admin123
      if (
        username !== "admin" ||
        password !== "admin123"
      ) {
        throw new Error("Invalid username or password.");
      }

      const result = await login(username, password);
      const loggedInUser = result?.user ?? getUser();

      if (!loggedInUser) {
        throw new Error("Could not load user details.");
      }

      setUser({
        ...loggedInUser,
        username: loggedInUser.username || "admin",
        role: "admin",
      });

      setPage("dashboard");
      setError("");
      setNotice("Welcome to HYDRO!");
    } catch (err) {
      setLoginError(
        err?.message || "Unable to sign in."
      );
    } finally {
      setLoginBusy(false);
    }
  };

  const handleLogout = () => {
    logout();

    setUser(null);
    setPage("dashboard");
    setSensors({});
    setNutrients(DEFAULT_NUTRIENTS);
    setHistory([]);
    setActuatorStates({});
    setError("");
    setNotice("");
  };

  // ----------------------------------------------------------
  // LOAD DASHBOARD DATA
  // ----------------------------------------------------------

  const loadDashboard = useCallback(
    async (showLoading = false) => {
      if (!user) return;

      if (showLoading) {
        setLoading(true);
      }

      try {
        const results = await Promise.allSettled([
          getSensors(),
          getNutrients(),
          getAutomation(),
          getActuators(),
        ]);

        if (results[0].status === "fulfilled") {
          setSensors(
            getLatestSensorRecord(results[0].value)
          );

          setLastUpdated(new Date());
        } else {
          throw results[0].reason;
        }

        if (results[1].status === "fulfilled") {
          const values = unwrapObject(
            results[1].value,
            ["nutrients", "data"]
          );

          setNutrients((current) => ({
            ...current,
            ...values,
          }));
        }

        if (results[2].status === "fulfilled") {
          const settings = unwrapObject(
            results[2].value,
            ["settings", "automation", "data"]
          );

          setAutomation((current) => ({
            ...current,
            ...settings,
          }));
        }

        if (results[3].status === "fulfilled") {
          const states = unwrapObject(
            results[3].value,
            ["actuators", "states", "data"]
          );

          setActuatorStates((current) => ({
            ...current,
            ...states,
          }));
        }

        setError("");
      } catch (err) {
        setError(
          `Unable to load dashboard data. Check your backend connection. ${
            err?.message || ""
          }`
        );
      } finally {
        setLoading(false);
      }
    },
    [user]
  );

  useEffect(() => {
    if (!user) {
      setLoading(false);
      return undefined;
    }

    loadDashboard(true);

    const interval = window.setInterval(() => {
      loadDashboard(false);
    }, 5000);

    return () => {
      window.clearInterval(interval);
    };
  }, [user, loadDashboard]);

  // ----------------------------------------------------------
  // NAVIGATION
  // ----------------------------------------------------------

  const navigate = (nextPage) => {
    setPage(nextPage);
    setError("");
    setNotice("");

    if (nextPage === "control") {
      setControlExpanded(true);
    }
  };

  const openControl = (tab) => {
    setPage("control");
    setControlExpanded(true);
    setControlPage(tab);
    setError("");
    setNotice("");
  };

  // ----------------------------------------------------------
  // ACTUATOR CONTROL
  // ----------------------------------------------------------

  const handleActuator = async (name, nextState) => {
    setBusy(name);
    setError("");

    try {
      await controlActuator(name, nextState);

      setActuatorStates((current) => ({
        ...current,
        [name]: nextState,
      }));

      showNotice(
        `${formatLabel(name)} command sent.`
      );

      // Refresh actual actuator states from backend.
      try {
        const result = await getActuators();

        setActuatorStates(
          unwrapObject(result, [
            "actuators",
            "states",
            "data",
          ])
        );
      } catch {
        // Keep the locally updated state if refresh fails.
      }
    } catch (err) {
      setError(
        `Could not control ${name}: ${err.message}`
      );
    } finally {
      setBusy("");
    }
  };

  // ----------------------------------------------------------
  // NUTRIENT CONTROL
  // ----------------------------------------------------------

  const handleNutrient = async (name, value) => {
    const number = Number(value);

    if (!Number.isFinite(number)) {
      setError("Enter a valid nutrient value.");
      return;
    }

    setBusy(`nutrient-${name}`);
    setError("");

    try {
      await setNutrient(name, number);

      setNutrients((current) => ({
        ...current,
        [name]: number,
      }));

      showNotice(
        `${formatLabel(name)} updated successfully.`
      );
    } catch (err) {
      setError(
        `Could not update nutrient: ${err.message}`
      );
    } finally {
      setBusy("");
    }
  };

  // ----------------------------------------------------------
  // AUTOMATION
  // ----------------------------------------------------------

  const handleAutomationSave = async (event) => {
    event.preventDefault();

    if (!admin) {
      setError(
        "Only an Admin can update automation settings."
      );
      return;
    }

    const numericSettings = {};

    for (const [key, value] of Object.entries(automation)) {
      const number = Number(value);

      if (value === "" || !Number.isFinite(number)) {
        setError(
          `Enter a valid value for ${formatLabel(key)}.`
        );
        return;
      }

      numericSettings[key] = number;
    }

    setBusy("automation");
    setError("");

    try {
      await saveAutomation(numericSettings);

      setAutomation(numericSettings);

      showNotice("Automation settings saved.");
    } catch (err) {
      setError(
        `Could not save automation settings: ${err.message}`
      );
    } finally {
      setBusy("");
    }
  };

  // ----------------------------------------------------------
  // CALIBRATION
  // ----------------------------------------------------------

  const loadCalibration = async () => {
    setBusy("calibration-load");
    setError("");

    try {
      const result = await getCalibration();

      const values = unwrapObject(result, [
        "calibration",
        "data",
      ]);

      setCalibration({
        ...DEFAULT_CALIBRATION,
        ...values,
      });

      showNotice("Calibration values loaded.");
    } catch (err) {
      setError(
        `Could not load calibration: ${err.message}`
      );
    } finally {
      setBusy("");
    }
  };

  const handleCalibrationSave = async (event) => {
    event.preventDefault();

    if (!admin) {
      setError(
        "Only an Admin can update calibration settings."
      );
      return;
    }

    const payload = {};

    for (const key of Object.keys(DEFAULT_CALIBRATION)) {
      const value = calibration[key] ?? 0;
      const number = Number(value);

      if (!Number.isFinite(number)) {
        setError(
          `Enter a valid value for ${formatLabel(key)}.`
        );
        return;
      }

      payload[key] = number;
    }

    setBusy("calibration-save");
    setError("");

    try {
      await saveCalibration(payload);

      setCalibration(payload);

      showNotice("Calibration settings saved.");
    } catch (err) {
      setError(
        `Could not save calibration: ${err.message}`
      );
    } finally {
      setBusy("");
    }
  };

  // ----------------------------------------------------------
  // SENSOR HISTORY
  // ----------------------------------------------------------

  const loadHistory = async (event) => {
    event?.preventDefault();

    setBusy("history");
    setError("");

    try {
      const params = Object.fromEntries(
        Object.entries(historyFilters).filter(
          ([, value]) => Boolean(value)
        )
      );

      const result = await getSensorHistory(params);

      const records = Array.isArray(result)
        ? result
        : result?.history ??
          result?.data ??
          result?.records ??
          [];

      setHistory(
        Array.isArray(records) ? records : []
      );

      showNotice(
        `Loaded ${
          Array.isArray(records) ? records.length : 0
        } history records.`
      );
    } catch (err) {
      setError(
        `Could not load sensor history: ${err.message}`
      );
    } finally {
      setBusy("");
    }
  };

  const historySummary = useMemo(() => {
    return ALL_SENSORS.map((sensor) => {
      const count = history.filter((record) => {
        const value = getSensorValue(record, sensor);

        return (
          value !== undefined &&
          value !== null &&
          value !== ""
        );
      }).length;

      return {
        name: sensor.label,
        value: count,
      };
    }).filter((item) => item.value > 0);
  }, [history]);

  // ----------------------------------------------------------
  // ACTUATOR CARDS
  // ----------------------------------------------------------

  const renderActuators = (group) => (
    <div className="actuator-grid">
      {ACTUATORS.filter(
        (actuator) => actuator.group === group
      ).map((actuator) => {
        const isOn = isActuatorOn(
          actuatorStates[actuator.key]
        );

        return (
          <article
            className="actuator-card"
            key={actuator.key}
          >
            <span className="actuator-icon">
              {actuator.icon}
            </span>

            <div className="actuator-info">
              <strong>{actuator.label}</strong>

              <span
                className={
                  isOn ? "state-on" : "state-off"
                }
              >
                {isOn ? "ON" : "OFF"}
              </span>
            </div>

            <button
              className={`button ${
                isOn
                  ? "button-danger"
                  : "button-primary"
              }`}
              type="button"
              onClick={() =>
                handleActuator(
                  actuator.key,
                  isOn ? "OFF" : "ON"
                )
              }
              disabled={busy === actuator.key}
            >
              {busy === actuator.key
                ? "Sending…"
                : isOn
                  ? "Turn off"
                  : "Turn on"}
            </button>
          </article>
        );
      })}
    </div>
  );

  // ----------------------------------------------------------
  // DASHBOARD PAGE
  // ----------------------------------------------------------

  const renderDashboard = () => (
    <>
      <div className="welcome-row">
        <div>
          <p className="eyebrow">
            HYDROPONICS MONITORING
          </p>

          <h1>Greenhouse Dashboard</h1>

          <p className="welcome-description">
            Monitor your nutrient tank, greenhouse environment,
            and hydroponics system.
          </p>
        </div>

        <button
          className="button button-secondary"
          type="button"
          onClick={() => loadDashboard(true)}
          disabled={loading}
        >
          ↻ {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      <section className="panel">
        <SectionHeading
          eyebrow="WATER SYSTEM"
          title="Tank Parameters"
          description="Latest readings from your nutrient tank."
        />

        <div className="sensor-grid tank-sensor-grid">
          {SENSOR_GROUPS.tank.map((sensor) => (
            <SensorCard
              key={sensor.key}
              sensor={sensor}
              value={getSensorValue(sensors, sensor)}
            />
          ))}
        </div>

        <div className="shed-heading">
          <SectionHeading
            eyebrow="GROWING ENVIRONMENT"
            title="Shed Parameters"
            description="Latest readings from your growing shed."
          />
        </div>

        <div className="sensor-grid shed-sensor-grid">
          {SENSOR_GROUPS.shed.map((sensor) => (
            <SensorCard
              key={sensor.key}
              sensor={sensor}
              value={getSensorValue(sensors, sensor)}
            />
          ))}
        </div>

        <div className="sensor-footer">
          <span>
            <span className="status-dot" />
            Live sensor polling
          </span>

          <span>
            Last updated:{" "}
            {lastUpdated
              ? lastUpdated.toLocaleTimeString("en-IN")
              : "—"}
          </span>
        </div>

        {loading && (
          <p className="muted-text">
            Loading sensor readings…
          </p>
        )}
      </section>

      {/* NUTRIENT VALUES */}

      <section className="panel">
        <SectionHeading
          eyebrow="NUTRIENT MANAGEMENT"
          title="Nutrient Values"
          description="Nutrient values received from your backend."
        />

        <div className="nutrient-grid">
          {Object.entries(nutrients).map(([name, value]) => (
            <article className="nutrient-card" key={name}>
              <span className="nutrient-name">
                {formatLabel(name)}
              </span>

              <strong>
                {value !== null &&
                typeof value === "object"
                  ? JSON.stringify(value)
                  : String(value ?? "—")}
              </strong>
            </article>
          ))}
        </div>

        <p className="muted-text">
          Values shown here come from the backend. The initial
          A, B, and C values are placeholders until actual
          nutrient values are returned.
        </p>
      </section>

      {/* QUICK ACCESS */}

      <section className="panel">
        <SectionHeading
          eyebrow="SYSTEM MANAGEMENT"
          title="Quick Access"
          description="Open controls for your greenhouse or nutrient tank."
        />

        <div className="quick-link-grid">
          <button
            className="quick-link-card"
            type="button"
            onClick={() => openControl("environment")}
          >
            <span className="quick-link-icon">🌿</span>

            <span className="quick-link-copy">
              <strong>Environment Control</strong>
              <small>
                Cooling, fan, fogger and automation
              </small>
            </span>

            <span className="quick-link-arrow">→</span>
          </button>

          <button
            className="quick-link-card"
            type="button"
            onClick={() => openControl("tank")}
          >
            <span className="quick-link-icon">💧</span>

            <span className="quick-link-copy">
              <strong>Tank Control</strong>
              <small>Water pump and nutrient dosing</small>
            </span>

            <span className="quick-link-arrow">→</span>
          </button>
        </div>
      </section>
    </>
  );

  // ----------------------------------------------------------
  // ENVIRONMENT CONTROL PAGE
  // ----------------------------------------------------------

  const renderEnvironmentControl = () => (
    <>
      <SectionHeading
        eyebrow="CONTROL / ENVIRONMENT"
        title="Environment Control"
        description="Manage greenhouse actuators and automatic thresholds."
      />

      <section className="panel">
        <h3 className="panel-title">
          Manual Environment Control
        </h3>

        <p className="muted-text">
          Send ON or OFF commands to your environment actuators.
        </p>

        {renderActuators("environment")}
      </section>

      <section className="panel">
        <h3 className="panel-title">
          Automation Settings
        </h3>

        <p className="muted-text">
          Configure automatic control thresholds.
        </p>

        <form
          className="settings-form"
          onSubmit={handleAutomationSave}
        >
          {Object.entries(automation).map(([key, value]) => (
            <label className="field" key={key}>
              <span>{formatLabel(key)}</span>

              <input
                type="number"
                step="0.1"
                value={value ?? ""}
                onChange={(event) =>
                  setAutomation((current) => ({
                    ...current,
                    [key]:
                      event.target.value === ""
                        ? ""
                        : Number(event.target.value),
                  }))
                }
              />
            </label>
          ))}

          <button
            className="button button-primary"
            type="submit"
            disabled={busy === "automation"}
          >
            {busy === "automation"
              ? "Saving…"
              : "Save automation settings"}
          </button>
        </form>
      </section>
    </>
  );

  // ----------------------------------------------------------
  // TANK CONTROL PAGE
  // ----------------------------------------------------------

  const renderTankControl = () => (
    <>
      <SectionHeading
        eyebrow="CONTROL / TANK"
        title="Tank Control"
        description="Control the water pump and update nutrient values."
      />

      <section className="panel">
        <h3 className="panel-title">Water Pump</h3>

        <p className="muted-text">
          Send commands to your configured water pump.
        </p>

        {renderActuators("tank")}
      </section>

      <section className="panel">
        <h3 className="panel-title">
          Nutrient Dosing
        </h3>

        <p className="muted-text">
          Edit the nutrient values supported by your backend.
        </p>

        <div className="nutrient-edit-grid">
          {Object.entries(nutrients)
            .filter(
              ([, value]) =>
                value === null ||
                ["string", "number"].includes(typeof value)
            )
            .map(([name, value]) => (
              <form
                className="nutrient-edit-card"
                key={name}
                onSubmit={(event) => {
                  event.preventDefault();

                  const formData = new FormData(
                    event.currentTarget
                  );

                  handleNutrient(
                    name,
                    formData.get("value")
                  );
                }}
              >
                <label className="field">
                  <span>{formatLabel(name)}</span>

                  <input
                    name="value"
                    type="number"
                    step="any"
                    defaultValue={value ?? ""}
                    required
                  />
                </label>

                <button
                  className="button button-primary"
                  type="submit"
                  disabled={busy === `nutrient-${name}`}
                >
                  {busy === `nutrient-${name}`
                    ? "Saving…"
                    : "Update"}
                </button>
              </form>
            ))}
        </div>
      </section>
    </>
  );

  const renderControl = () => (
    <>
      <SectionHeading
        eyebrow="SYSTEM MANAGEMENT"
        title="Control Center"
        description="Choose which part of your hydroponics system to manage."
      />

      <div className="control-tabs">
        <button
          type="button"
          className={`control-tab ${
            controlPage === "environment" ? "active" : ""
          }`}
          onClick={() => setControlPage("environment")}
        >
          🌿 Environment Control
        </button>

        <button
          type="button"
          className={`control-tab ${
            controlPage === "tank" ? "active" : ""
          }`}
          onClick={() => setControlPage("tank")}
        >
          💧 Tank Control
        </button>
      </div>

      {controlPage === "environment"
        ? renderEnvironmentControl()
        : renderTankControl()}
    </>
  );

  // ----------------------------------------------------------
  // CALIBRATION PAGE
  // ----------------------------------------------------------

  const renderCalibration = () => (
    <>
      <SectionHeading
        eyebrow="SENSOR MAINTENANCE"
        title="Sensor Calibration"
        description="Manage pH, EC and water temperature correction offsets."
      />

      <section className="panel">
        <div className="inline-actions">
          <h3 className="panel-title">
            Calibration Values
          </h3>

          <button
            className="button button-secondary"
            type="button"
            onClick={loadCalibration}
            disabled={busy === "calibration-load"}
          >
            {busy === "calibration-load"
              ? "Loading…"
              : "Load values"}
          </button>
        </div>

        <p className="muted-text">
          Calibration values are stored in your backend.
          Your backend or sensor device must apply these offsets
          for them to change measured readings.
        </p>

        <form
          className="settings-form"
          onSubmit={handleCalibrationSave}
        >
          {[
            {
              key: "ph_offset",
              label: "pH Offset",
              description:
                "Correction added to measured pH.",
            },
            {
              key: "ec_offset",
              label: "EC Offset",
              description:
                "Correction added to conductivity.",
            },
            {
              key: "temperature_offset",
              label: "Temperature Offset",
              description:
                "Correction added to measured temperature.",
            },
          ].map((item) => (
            <label className="field" key={item.key}>
              <span>{item.label}</span>

              <input
                type="number"
                step="any"
                value={calibration[item.key] ?? 0}
                onChange={(event) =>
                  setCalibration((current) => ({
                    ...current,
                    [item.key]:
                      event.target.value === ""
                        ? ""
                        : Number(event.target.value),
                  }))
                }
              />

              <small>{item.description}</small>
            </label>
          ))}

          <button
            className="button button-primary"
            type="submit"
            disabled={busy === "calibration-save"}
          >
            {busy === "calibration-save"
              ? "Saving…"
              : "Save calibration"}
          </button>
        </form>
      </section>
    </>
  );

  // ----------------------------------------------------------
  // HISTORY PAGE
  // ----------------------------------------------------------

  const renderHistory = () => (
    <>
      <SectionHeading
        eyebrow="STORED READINGS"
        title="Sensor History"
        description="Filter historical readings and review sensor data."
      />

      <section className="panel">
        <form
          className="history-filters"
          onSubmit={loadHistory}
        >
          {[
            ["from_date", "Start date", "date"],
            ["to_date", "End date", "date"],
            ["from_time", "Start time", "time"],
            ["to_time", "End time", "time"],
          ].map(([key, label, type]) => (
            <label className="field" key={key}>
              <span>{label}</span>

              <input
                type={type}
                value={historyFilters[key]}
                onChange={(event) =>
                  setHistoryFilters((current) => ({
                    ...current,
                    [key]: event.target.value,
                  }))
                }
              />
            </label>
          ))}

          <button
            className="button button-primary"
            type="submit"
            disabled={busy === "history"}
          >
            {busy === "history"
              ? "Loading…"
              : "Apply filters"}
          </button>
        </form>
      </section>

      <section className="panel">
        <SectionHeading
          eyebrow="DATA OVERVIEW"
          title="Sensor Reading Distribution"
          description="Historical record counts for each sensor."
        />

        {historySummary.length > 0 ? (
          <div className="history-chart">
            <ResponsiveContainer width="100%" height={320}>
              <PieChart>
                <Pie
                  data={historySummary}
                  dataKey="value"
                  nameKey="name"
                  cx="50%"
                  cy="48%"
                  outerRadius={105}
                  innerRadius={48}
                  paddingAngle={3}
                  label={({ name, value }) =>
                    `${name}: ${value}`
                  }
                >
                  {historySummary.map((entry, index) => (
                    <Cell
                      key={entry.name}
                      fill={
                        HISTORY_COLORS[
                          index % HISTORY_COLORS.length
                        ]
                      }
                    />
                  ))}
                </Pie>

                <Tooltip />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <p className="muted-text">
            Load sensor history to display the chart.
          </p>
        )}
      </section>

      <section className="panel">
        <SectionHeading
          eyebrow="READING LOG"
          title={`Historical Records (${history.length})`}
          description="Readings returned by your backend."
        />

        <div className="table-wrap">
          <table className="history-table">
            <thead>
              <tr>
                <th>Timestamp</th>

                {ALL_SENSORS.map((sensor) => (
                  <th key={sensor.key}>
                    {sensor.label}
                  </th>
                ))}
              </tr>
            </thead>

            <tbody>
              {history.map((record, index) => (
                <tr
                  key={record._id || record.id || index}
                >
                  <td>{formatTimestamp(record)}</td>

                  {ALL_SENSORS.map((sensor) => (
                    <td key={sensor.key}>
                      {displayValue(
                        getSensorValue(record, sensor),
                        sensor.unit
                      )}
                    </td>
                  ))}
                </tr>
              ))}

              {!history.length && (
                <tr>
                  <td colSpan={ALL_SENSORS.length + 1}>
                    No records loaded. Select a date/time range
                    and apply the filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );

  // ----------------------------------------------------------
  // AUTHENTICATION CHECK
  // ----------------------------------------------------------

  if (authChecking) {
    return (
      <div className="login-screen">
        <div className="login-card">
          <div className="login-brand-icon">🌱</div>
          <h2>Checking your session…</h2>
          <p className="muted-text">Please wait.</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <LoginScreen
        onLogin={handleLogin}
        busy={loginBusy}
        error={loginError}
      />
    );
  }

  // ----------------------------------------------------------
  // MAIN LAYOUT
  // ----------------------------------------------------------

  const pageTitles = {
    dashboard: "Dashboard",
    control:
      controlPage === "tank"
        ? "Tank Control"
        : "Environment Control",
    calibration: "Calibration",
    history: "History",
  };

  return (
    <div className="app-shell">
      {/* TOP HEADER AND COMPANY LOGOS */}

      <header className="topbar">
        <div className="brand-side">
          <img
            className="brand-logo"
            src="/logo1.png"
            alt="Company logo"
            onError={(event) => {
              event.currentTarget.style.visibility = "hidden";
            }}
          />

          <div className="brand-copy">
            <span className="brand-name">HYDRO</span>
            <span className="brand-subtitle">
              Hydroponics Control Center
            </span>
          </div>
        </div>

        <div className="topbar-right">
          <span className="connection-pill">
            <span className="status-dot" />
            Live monitoring
          </span>

          <span
            className={`role-pill ${
              admin ? "role-admin" : "role-operator"
            }`}
          >
            {admin ? "Admin" : "Operator"}
          </span>

          <div className="user-menu">
            <span className="user-name">
              {user.username || user.name || "Admin"}
            </span>

            <button
              className="button button-secondary logout-button"
              type="button"
              onClick={handleLogout}
            >
              Log out
            </button>
          </div>

          <img
            className="brand-logo brand-logo-right"
            src="/logo2.png"
            alt="Project or institute logo"
            onError={(event) => {
              event.currentTarget.style.visibility = "hidden";
            }}
          />
        </div>
      </header>

      <div className="app-layout">
        {/* SIDEBAR */}

        <aside className="sidebar">
          <p className="sidebar-label">WORKSPACE</p>

          <nav
            className="sidebar-nav"
            aria-label="Main navigation"
          >
            {NAV_ITEMS.map((item) => (
              <div className="nav-group" key={item.key}>
                <button
                  type="button"
                  className={`nav-item ${
                    page === item.key ? "active" : ""
                  }`}
                  onClick={() => {
                    if (item.key === "control") {
                      setControlExpanded((current) => !current);
                      setPage("control");
                      setError("");
                      setNotice("");
                    } else {
                      navigate(item.key);
                    }
                  }}
                >
                  <span className="nav-icon">
                    {item.icon}
                  </span>

                  <span className="nav-label">
                    {item.label}
                  </span>

                  {item.key === "control" && (
                    <span className="nav-chevron">
                      {controlExpanded ? "⌄" : "›"}
                    </span>
                  )}
                </button>

                {item.key === "control" &&
                  controlExpanded && (
                    <div className="subnav">
                      <button
                        type="button"
                        className={`subnav-item ${
                          page === "control" &&
                          controlPage === "environment"
                            ? "active"
                            : ""
                        }`}
                        onClick={() =>
                          openControl("environment")
                        }
                      >
                        <span>🌿</span>
                        Environment Control
                      </button>

                      <button
                        type="button"
                        className={`subnav-item ${
                          page === "control" &&
                          controlPage === "tank"
                            ? "active"
                            : ""
                        }`}
                        onClick={() => openControl("tank")}
                      >
                        <span>💧</span>
                        Tank Control
                      </button>
                    </div>
                  )}
              </div>
            ))}
          </nav>

          <div className="sidebar-bottom">
            <div className="sidebar-status">
              <span className="status-dot" />

              <div>
                <strong>HydroControl</strong>
                <small>Refreshes every 5 seconds</small>
              </div>
            </div>
          </div>
        </aside>

        {/* MAIN CONTENT */}

        <main className="main-content">
          <div className="page-topline">
            <span>
              Workspace / {pageTitles[page]}
            </span>

            <span className="date-label">
              {new Date().toLocaleDateString("en-IN", {
                day: "2-digit",
                month: "short",
                year: "numeric",
              })}
            </span>
          </div>

          {error && (
            <div className="alert alert-error" role="alert">
              <span>{error}</span>

              <button
                type="button"
                onClick={() => setError("")}
                aria-label="Dismiss error"
              >
                ×
              </button>
            </div>
          )}

          {notice && (
            <div
              className="alert alert-success"
              role="status"
            >
              <span>{notice}</span>

              <button
                type="button"
                onClick={() => setNotice("")}
                aria-label="Dismiss message"
              >
                ×
              </button>
            </div>
          )}

          {page === "dashboard" && renderDashboard()}
          {page === "control" && renderControl()}
          {page === "calibration" && renderCalibration()}
          {page === "history" && renderHistory()}

          <footer className="app-footer">
            <span>
              HYDRO · Hydroponics Monitoring System
            </span>

            <span>
              Monitoring and control dashboard
            </span>
          </footer>
        </main>
      </div>
    </div>
  );
}

export default App;
