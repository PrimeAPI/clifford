import type { ToolDef } from '@clifford/sdk';
import { z } from 'zod';

const weatherGetArgs = z.object({
  region: z.string().optional(),
  location: z.string().optional(),
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
  config: {
    fields: [
      {
        key: 'default_region',
        label: 'Default Region',
        description: 'Used when the caller does not specify a region.',
        type: 'string',
      },
      {
        key: 'units',
        label: 'Units',
        description: 'Preferred units for weather data.',
        type: 'select',
        options: ['metric', 'imperial'],
      },
      {
        key: 'max_retries',
        label: 'Max Retries',
        description: 'Maximum retries when this tool fails.',
        type: 'number',
        min: 0,
        max: 5,
      },
      {
        key: 'expose_errors',
        label: 'Expose Errors',
        description: 'Include tool error details in user-facing messages.',
        type: 'boolean',
      },
    ],
    schema: z.object({
      default_region: z.string().optional(),
      units: z.enum(['metric', 'imperial']).optional(),
      max_retries: z.number().int().min(0).max(5).optional(),
      expose_errors: z.boolean().optional(),
    }),
  },
  commands: [
    {
      name: 'get',
      shortDescription: 'Retrieve weather data',
      longDescription: 'Returns weather for a region and timeframe defined by start and end dates.',
      usageExample:
        '{"name":"weather.get","args":{"location":"San Francisco, CA","start":"2026-02-03","end":"2026-02-05"}}',
      argsSchema: weatherGetArgs,
      classification: 'READ',
      handler: async (ctx, args) => {
        const { region, location, start, end } = weatherGetArgs.parse(args);
        const config = (ctx.toolConfig ?? {}) as { default_region?: string; units?: string };
        const targetRegion = region ?? location ?? config.default_region;
        if (!targetRegion) {
          return { success: false, error: 'Region is required', region: null };
        }
        const geocodedLocation = await geocode(targetRegion);
        if (!geocodedLocation) {
          return { success: false, error: 'Location not found', region: targetRegion };
        }
        const data = await fetchWeather(geocodedLocation, start, end);
        return {
          success: true,
          location: geocodedLocation,
          units: config.units ?? 'metric',
          data,
        };
      },
    },
  ],
};
