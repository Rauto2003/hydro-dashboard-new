const API_BASE = (
  import.meta.env.VITE_API_URL ||
  "https://hydro-api-v30z.onrender.com"
).replace(/\/+$/, "");

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      ...(options.body
        ? { "Content-Type": "application/json" }
        : {}),
      ...options.headers,
    },
  });

  if (!response.ok) {
    const details = await response.text();

    throw new Error(
      `API ${options.method || "GET"} ${path} failed (${response.status}): ${details}`
    );
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

export const getSensors = () =>
  request("/api/sensors");

export const getNutrients = () =>
  request("/api/nutrients");

export const setNutrient = (name, value) =>
  request("/api/nutrients", {
    method: "POST",
    body: JSON.stringify({ name, value }),
  });

export const controlActuator = (name, state) =>
  request("/api/actuators", {
    method: "POST",
    body: JSON.stringify({ name, state }),
  });

export const getAutomation = () =>
  request("/api/automation");

export const saveAutomation = (settings) =>
  request("/api/automation", {
    method: "POST",
    body: JSON.stringify(settings),
  });