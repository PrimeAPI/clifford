import type { ToolDef } from '@clifford/sdk';
import { z } from 'zod';

const weatherGetArgs = z
  .object({
    location: z
      .string()
      .max(200)
      .optional()
      .describe('Location name (city, region). Max 200 characters. Example: "Bremen, Germany"'),
    region: z
      .string()
      .max(200)
      .optional()
      .describe('Deprecated: use "location" instead. Max 200 characters.'),
    days: z
      .number()
      .int()
      .min(1)
      .max(14)
      .optional()
      .describe('Number of forecast days to return. Range: 1-14. Default: 3.'),
    startDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe('Start date for forecast in YYYY-MM-DD format. Default: today.'),
    timezone: z
      .string()
      .max(100)
      .optional()
      .describe('IANA timezone string (e.g., "America/New_York"). Default: auto-detected from location.'),
    units: z
      .enum(['metric', 'imperial'])
      .optional()
      .describe('Unit system: "metric" (Celsius, km/h) or "imperial" (Fahrenheit, mph). Default: metric.'),
    includeHourly: z
      .boolean()
      .optional()
      .describe('Include hourly forecast data in addition to daily. Default: false.'),
  })
  .refine((value) => value.location || value.region, {
    message: 'location is required',
    path: ['location'],
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
    results?: Array<{
      name: string;
      latitude: number;
      longitude: number;
      country?: string;
      timezone?: string;
    }>;
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

function formatDateInTimezone(timezone: string) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(new Date());
}

function addDays(isoDate: string, daysToAdd: number) {
  const parts = isoDate.split('-').map((value) => Number(value));
  const year = parts[0] ?? 0;
  const month = parts[1] ?? 0;
  const day = parts[2] ?? 0;
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + daysToAdd);
  return date.toISOString().slice(0, 10);
}

function summarizeWeatherCode(code: number) {
  const summaryMap: Record<number, string> = {
    0: 'Clear',
    1: 'Mostly clear',
    2: 'Partly cloudy',
    3: 'Overcast',
    45: 'Fog',
    48: 'Depositing rime fog',
    51: 'Light drizzle',
    53: 'Drizzle',
    55: 'Dense drizzle',
    56: 'Light freezing drizzle',
    57: 'Freezing drizzle',
    61: 'Slight rain',
    63: 'Rain',
    65: 'Heavy rain',
    66: 'Light freezing rain',
    67: 'Freezing rain',
    71: 'Slight snow fall',
    73: 'Snow fall',
    75: 'Heavy snow fall',
    77: 'Snow grains',
    80: 'Rain showers',
    81: 'Heavy rain showers',
    82: 'Violent rain showers',
    85: 'Snow showers',
    86: 'Heavy snow showers',
    95: 'Thunderstorm',
    96: 'Thunderstorm with hail',
    99: 'Thunderstorm with heavy hail',
  };
  return summaryMap[code] ?? 'Unknown';
}

async function fetchWeather({
  location,
  startDate,
  endDate,
  units,
  includeHourly,
}: {
  location: WeatherLocation;
  startDate: string;
  endDate: string;
  units: 'metric' | 'imperial';
  includeHourly: boolean;
}): Promise<{
  current?: {
    time?: string;
    temperature_2m?: number;
    wind_speed_10m?: number;
    precipitation?: number;
    weather_code?: number;
  };
  daily?: {
    time: string[];
    temperature_2m_max?: number[];
    temperature_2m_min?: number[];
    precipitation_sum?: number[];
    wind_speed_10m_max?: number[];
    weather_code?: number[];
  };
  hourly?: {
    time: string[];
    temperature_2m?: number[];
    wind_speed_10m?: number[];
    precipitation?: number[];
    weather_code?: number[];
  };
}> {
  const params = new URLSearchParams({
    latitude: location.latitude.toString(),
    longitude: location.longitude.toString(),
    timezone: location.timezone || 'auto',
  });

  params.set(
    'daily',
    'temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max,weather_code'
  );
  params.set('current', 'temperature_2m,wind_speed_10m,precipitation,weather_code');
  params.set('start_date', startDate);
  params.set('end_date', endDate);

  if (includeHourly) {
    params.set('hourly', 'temperature_2m,precipitation,wind_speed_10m,weather_code');
  }

  if (units === 'imperial') {
    params.set('temperature_unit', 'fahrenheit');
    params.set('wind_speed_unit', 'mph');
    params.set('precipitation_unit', 'inch');
  }

  const url = `https://api.open-meteo.com/v1/forecast?${params.toString()}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Weather fetch failed: ${response.status}`);
  }
  return (await response.json()) as {
    current?: {
      time?: string;
      temperature_2m?: number;
      wind_speed_10m?: number;
      precipitation?: number;
      weather_code?: number;
    };
    daily?: {
      time: string[];
      temperature_2m_max?: number[];
      temperature_2m_min?: number[];
      precipitation_sum?: number[];
      wind_speed_10m_max?: number[];
      weather_code?: number[];
    };
    hourly?: {
      time: string[];
      temperature_2m?: number[];
      wind_speed_10m?: number[];
      precipitation?: number[];
      weather_code?: number[];
    };
  };
}

export const weatherTool: ToolDef = {
  name: 'weather',
  shortDescription: 'Weather lookup with daily forecasts',
  longDescription:
    'Fetches current weather conditions and multi-day forecasts using Open-Meteo API (no API key required). Supports location search by city/region name with automatic geocoding. Returns current conditions plus daily forecast array. Use "days" parameter to control forecast horizon (1-14 days). Supports metric/imperial units, custom timezones, and optional hourly forecasts. Use for weather queries, travel planning, or contextual awareness.',
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
      shortDescription: 'Retrieve weather data and forecast',
      longDescription:
        'Returns current weather conditions plus daily forecast array for the specified location. Automatically geocodes location names (e.g., "Bremen, Germany"). Returns temperature, precipitation, wind speed, and weather codes with human-readable summaries. Use "days" (1-14) to control forecast length. Supports metric/imperial units and optional hourly data. Response includes location coordinates, timezone, and whether the forecast is partial. Example: weather.get({"location":"London","days":5}) returns 5-day forecast.',
      usageExample: '{"name":"weather.get","args":{"location":"Bremen, Germany","days":5,"units":"metric"}}',
      argsSchema: weatherGetArgs,
      classification: 'READ',
      handler: async (ctx, args) => {
        const parsed = weatherGetArgs.parse(args);
        const config = (ctx.toolConfig ?? {}) as { default_region?: string; units?: string };
        const targetRegion = parsed.location ?? parsed.region ?? config.default_region;
        if (!targetRegion) {
          return { success: false, error: 'location is required' };
        }
        const geocodedLocation = await geocode(targetRegion);
        if (!geocodedLocation) {
          return { success: false, error: 'location_not_found', details: targetRegion };
        }
        const units = (parsed.units ?? config.units ?? 'metric') as 'metric' | 'imperial';
        const timezone = parsed.timezone ?? geocodedLocation.timezone ?? 'Europe/Berlin';
        const startDate = parsed.startDate ?? formatDateInTimezone(timezone);
        const days = parsed.days ?? 3;
        const endDate = addDays(startDate, Math.max(0, days - 1));

        const data = await fetchWeather({
          location: { ...geocodedLocation, timezone },
          startDate,
          endDate,
          units,
          includeHourly: parsed.includeHourly ?? false,
        });

        if (!data?.daily || !Array.isArray(data.daily?.time)) {
          return {
            success: false,
            error: 'forecast_not_supported',
            details: 'Daily forecast data missing from provider response.',
          };
        }

        const daily = data.daily.time.map((date: string, index: number) => ({
          date,
          tempMin: data.daily?.temperature_2m_min?.[index] ?? null,
          tempMax: data.daily?.temperature_2m_max?.[index] ?? null,
          precipMm: data.daily?.precipitation_sum?.[index] ?? null,
          windKphMax: data.daily?.wind_speed_10m_max?.[index] ?? null,
          weatherCode: data.daily?.weather_code?.[index] ?? null,
          summary: summarizeWeatherCode(Number(data.daily?.weather_code?.[index] ?? -1)),
        }));

        const current = data.current
          ? {
              time: data.current.time ?? null,
              temp: data.current.temperature_2m ?? null,
              windKph: data.current.wind_speed_10m ?? null,
              precipMm: data.current.precipitation ?? null,
              weatherCode: data.current.weather_code ?? null,
              summary: summarizeWeatherCode(Number(data.current.weather_code ?? -1)),
            }
          : null;

        const hourly =
          parsed.includeHourly && data.hourly
            ? data.hourly.time.map((time: string, index: number) => ({
                time,
                temp: data.hourly?.temperature_2m?.[index] ?? null,
                windKph: data.hourly?.wind_speed_10m?.[index] ?? null,
                precipMm: data.hourly?.precipitation?.[index] ?? null,
                weatherCode: data.hourly?.weather_code?.[index] ?? null,
                summary: summarizeWeatherCode(Number(data.hourly?.weather_code?.[index] ?? -1)),
              }))
            : undefined;

        const returnedStart = daily[0]?.date ?? startDate;
        const returnedEnd = daily[daily.length - 1]?.date ?? endDate;
        const isPartial =
          returnedStart !== startDate || returnedEnd !== endDate || daily.length < days;
        return {
          location: {
            name: geocodedLocation.name,
            lat: geocodedLocation.latitude,
            lon: geocodedLocation.longitude,
            timezone,
          },
          requested_range: { start: startDate, end: endDate, days },
          returned_range: { start: returnedStart, end: returnedEnd, days: daily.length },
          is_partial: isPartial,
          reason: isPartial ? 'forecast_limit' : 'full_range',
          current,
          daily,
          ...(hourly ? { hourly } : {}),
        };
      },
    },
  ],
};
