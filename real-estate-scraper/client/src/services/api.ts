import type {
  ApiResponse,
  FilterCriteria,
  ListingsPayload,
  PropertiesPayload,
  SavedFilter,
} from "./types";

const API_BASE_URL = "/api/v1";

async function fetchJson<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    headers: {
      "Content-Type": "application/json",
    },
    ...init,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API request failed: ${response.status} ${response.statusText} - ${errorText}`);
  }

  return response.json();
}

function buildUrl(path: string, query?: Record<string, string | number | null | undefined>) {
  const url = new URL(`${API_BASE_URL}${path}`, window.location.origin);

  if (query) {
    Object.entries(query).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    });
  }

  return url.toString();
}

export async function getAllListings(limit = 1000): Promise<ListingsPayload> {
  const url = buildUrl("/listings", { limit });
  const response = await fetchJson<ApiResponse<ListingsPayload>>(url);
  return response.data;
}

export async function getAllProperties(limit = 1000): Promise<PropertiesPayload> {
  const url = buildUrl("/properties", { limit });
  const response = await fetchJson<ApiResponse<PropertiesPayload>>(url);
  return response.data;
}

export async function getFilter(): Promise<SavedFilter | null> {
  const url = buildUrl("/filters");
  const response = await fetchJson<ApiResponse<SavedFilter | null>>(url);
  return response.data;
}

export async function updateFilter(filter: FilterCriteria): Promise<SavedFilter> {
  const url = buildUrl("/filters");
  const response = await fetchJson<ApiResponse<SavedFilter>>(url, {
    method: "PUT",
    body: JSON.stringify(filter),
  });
  return response.data;
}

export async function triggerScraper(source: string = "all"): Promise<any> {
  const url = buildUrl("/scrape/trigger");
  const response = await fetchJson<any>(url, {
    method: "POST",
    body: JSON.stringify({ source }),
  });
  return response;
}
