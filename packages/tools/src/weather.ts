import type { ToolDef } from '@clifford/sdk';
import { z } from 'zod';

const weatherGetArgs = z.object({
  region: z.string(),
  start: z.string().optional(),
  end: z.string().optional(),
});

type WeatherLocation = {
  name: string;
  latitude: number;
  longitude: number;
  country?: string;
  timezone?: string;
};

async function geocode(region: string): Promise<WeatherLocation | null> {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(
    region
  )}&count=1&language=en&format=json`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Geocoding failed: ${response.status}`);
  }
  const data = (await response.json()) as {
    results?: Array<{ name: string; latitude: number; longitude: number; country?: string; timezone?: string }>;
  };
  const result = data.results?.[0];
  if (!result) return null;
  return {
    name: result.name,
    latitude: result.latitude,
    longitude: result.longitude,
    country: result.country,
    timezone: result.timezone,
  };
}

async function fetchWeather(location: WeatherLocation, start?: string, end?: string) {
  const params = new URLSearchParams({
    latitude: location.latitude.toString(),
    longitude: location.longitude.toString(),
    timezone: location.timezone || 'auto',
  });

  if (start || end) {
    params.set('daily', 'temperature_2m_max,temperature_2m_min,precipitation_sum');
    if (start) params.set('start_date', start);
    if (end) params.set('end_date', end);
  } else {
    params.set('current', 'temperature_2m,wind_speed_10m,precipitation,weather_code');
  }

  const url = `https://api.open-meteo.com/v1/forecast?${params.toString()}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Weather fetch failed: ${response.status}`);
  }
  return response.json();
}

export const weatherTool: ToolDef = {
  name: 'weather',
  shortDescription: 'Weather lookup by region and timeframe',
  longDescription:
    'Fetches weather information for a specific region and timeframe using Open-Meteo.',
  commands: [
    {
      name: 'get',
      shortDescription: 'Retrieve weather data',
      longDescription: 'Returns weather for a region and timeframe defined by start and end dates.',
      usageExample:
        '{"name":"weather.get","args":{"region":"San Francisco, CA","start":"2026-02-03","end":"2026-02-05"}}',
      argsSchema: weatherGetArgs,
      classification: 'READ',
      handler: async (_ctx, args) => {
        const { region, start, end } = weatherGetArgs.parse(args);
        const location = await geocode(region);
        if (!location) {
          return { success: false, error: 'Location not found', region };
        }
        const data = await fetchWeather(location, start, end);
        return {
          success: true,
          location,
          data,
        };
      },
    },
  ],
};
