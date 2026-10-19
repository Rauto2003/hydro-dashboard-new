
const API_BASE = (
  import.meta.env.VITE_API_URL || "http://127.0.0.1:8000"
).replace(/\/+$/, "");

// TEMPORARY AUTHENTICATION BYPASS

export function getToken() {
  return null;
}

export function getUser() {
  return { username: "admin", role: "admin" };
}

export function saveSession() {}

export function clearSession() {}

export function isAdmin() {
  return true;
}

export async function login() {
  return { user: getUser() };
}

export async function getCurrentUser() {
  return { user: getUser() };
}

export function logout() {
  window.location.reload();
}

// BASE REQUEST — NO AUTHORIZATION HEADER

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      ...(options.body !== undefined
        ? { "Content-Type": "application/json" }
        : {}),
      ...options.headers,
    },
  });

  if (!response.ok) {
    const details = await response.text();
    let message = details;

    try {
      const parsed = JSON.parse(details);
      message = parsed.detail || details;
    } catch {
      // Keep original response text.
    }

    throw new Error(
      `API ${options.method || "GET"} ${path} failed (${response.status}): ${message}`
    );
  }

  if (response.status === 204) return null;

  const contentType = response.headers.get("content-type") || "";

  return contentType.includes("application/json")
    ? response.json()
    : response.text();
}

// SENSORS

export const getSensors = () => request("/api/sensors");

// SENSOR HISTORY

export async function getSensorHistory(params = {}) {
  const queryParams = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      queryParams.set(key, String(value));
    }
  }

  const query = queryParams.toString();

  return request(
    `/api/sensors/history${query ? `?${query}` : ""}`
  );
}

// NUTRIENTS

export async function getNutrients() {
  const result = await request("/api/nutrients");
  return result.nutrients ?? result;
}

export const setNutrient = (name, value) =>
  request("/api/nutrients", {
    method: "POST",
    body: JSON.stringify({ name, value }),
  });

// ACTUATORS

export async function getActuators() {
  const result = await request("/api/actuators");
  return result.actuators ?? result;
}

export const controlActuator = (name, state) =>
  request("/api/actuators", {
    method: "POST",
    body: JSON.stringify({ name, state }),
  });

// AUTOMATION

export async function getAutomation() {
  const result = await request("/api/automation");
  return result.settings ?? result;
}

export const saveAutomation = (settings) =>
  request("/api/automation", {
    method: "POST",
    body: JSON.stringify(settings),
  });

// CALIBRATION

export async function getCalibration() {
  const result = await request("/api/calibration");
  return result.calibration ?? result;
}

export const saveCalibration = (settings) =>
  request("/api/calibration", {
    method: "POST",
    body: JSON.stringify(settings),
  });

// API URL HELPER

export function getApiBaseUrl() {
  return API_BASE;
}
