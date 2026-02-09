/**
 * Integration tests for weather tool
 * These tests make REAL API calls to Open-Meteo
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { weatherTool } from '../../src/weather.js';
import { createMockContext } from '../test-utils.js';
import type { ToolContext } from '@clifford/sdk';

describe('weather tool [integration]', () => {
  let ctx: ToolContext;

  beforeEach(() => {
    ctx = createMockContext();
  });

  describe('weather.get - Open-Meteo API', () => {
    const getCommand = weatherTool.commands.find((c) => c.name === 'get');

    it('should work with different locations', async () => {
      const locations = ['New York', 'Tokyo', 'Berlin', 'Sydney'];

      for (const location of locations) {
        const result = await getCommand!.handler(ctx, {
          location,
          days: 1,
        });

        expect(result).toHaveProperty('location');
        expect(result).toHaveProperty('daily');

        const loc = (result as any).location;
        console.log(`✓ Weather works for ${loc.name} (${loc.lat}, ${loc.lon})`);
      }
    }, 60000);

    it('should support metric and imperial units', async () => {
      // Metric
      const metricResult = await getCommand!.handler(ctx, {
        location: 'Paris',
        days: 1,
        units: 'metric',
      });

      expect(metricResult).toHaveProperty('daily');
      const metricTemp = (metricResult as any).daily[0]?.tempMax;
      expect(typeof metricTemp).toBe('number');

      // Imperial
      const imperialResult = await getCommand!.handler(ctx, {
        location: 'Paris',
        days: 1,
        units: 'imperial',
      });

      expect(imperialResult).toHaveProperty('daily');
      const imperialTemp = (imperialResult as any).daily[0]?.tempMax;
      expect(typeof imperialTemp).toBe('number');

      console.log(`✓ Metric: ${metricTemp}°C, Imperial: ${imperialTemp}°F`);
    }, 30000);

    it('should include hourly forecast when requested', async () => {
      const result = await getCommand!.handler(ctx, {
        location: 'Berlin',
        days: 2,
        includeHourly: true,
      });

      expect(result).toHaveProperty('hourly');
      
      const hourly = (result as any).hourly;
      expect(Array.isArray(hourly)).toBe(true);
      expect(hourly.length).toBeGreaterThan(0);

      const firstHour = hourly[0];
      expect(firstHour).toHaveProperty('time');
      expect(firstHour).toHaveProperty('temp');
      expect(firstHour).toHaveProperty('summary');

      console.log(`✓ Hourly forecast: ${hourly.length} hours`);
    }, 30000);

    it('should handle forecast limit (max 14 days)', async () => {
      const result = await getCommand!.handler(ctx, {
        location: 'Madrid',
        days: 14,
      });

      expect(result).toHaveProperty('daily');
      const daily = (result as any).daily;
      expect(daily.length).toBeLessThanOrEqual(14);

      console.log(`✓ Max forecast: ${daily.length} days`);
    }, 30000);

    it('should handle unknown location gracefully', async () => {
      const result = await getCommand!.handler(ctx, {
        location: 'ThisCityDefinitelyDoesNotExist123456',
        days: 1,
      });

      expect(result).toHaveProperty('success', false);
      expect(result).toHaveProperty('error', 'location_not_found');

      console.log(`✓ Unknown location handled correctly`);
    }, 30000);

    it('should support custom date ranges', async () => {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const startDate = tomorrow.toISOString().slice(0, 10);

      const result = await getCommand!.handler(ctx, {
        location: 'Rome',
        startDate,
        days: 3,
      });

      expect(result).toHaveProperty('requested_range');
      expect((result as any).requested_range.start).toBe(startDate);

      console.log(`✓ Custom date range works`);
    }, 30000);

    it('should include weather codes and summaries', async () => {
      const result = await getCommand!.handler(ctx, {
        location: 'Amsterdam',
        days: 1,
      });

      const daily = (result as any).daily;
      const firstDay = daily[0];

      expect(firstDay).toHaveProperty('weatherCode');
      expect(firstDay).toHaveProperty('summary');
      expect(typeof firstDay.summary).toBe('string');
      expect(firstDay.summary.length).toBeGreaterThan(0);

      console.log(`✓ Weather: ${firstDay.summary} (code: ${firstDay.weatherCode})`);
    }, 30000);
  });

  describe('Open-Meteo API reliability', () => {
    const getCommand = weatherTool.commands.find((c) => c.name === 'get');

    it('should verify API response structure has not changed', async () => {
      const result = await getCommand!.handler(ctx, {
        location: 'London',
        days: 2,
        includeHourly: true,
      });

      // Verify the expected structure matches our expectations
      expect(result).toMatchObject({
        location: expect.objectContaining({
          name: expect.any(String),
          lat: expect.any(Number),
          lon: expect.any(Number),
          timezone: expect.any(String),
        }),
        current: expect.objectContaining({
          temp: expect.any(Number),
          summary: expect.any(String),
        }),
        daily: expect.arrayContaining([
          expect.objectContaining({
            date: expect.any(String),
            tempMin: expect.any(Number),
            tempMax: expect.any(Number),
            summary: expect.any(String),
          }),
        ]),
        hourly: expect.arrayContaining([
          expect.objectContaining({
            time: expect.any(String),
            temp: expect.any(Number),
            summary: expect.any(String),
          }),
        ]),
        requested_range: expect.any(Object),
        returned_range: expect.any(Object),
      });

      console.log(`✓ API structure matches expectations`);
    }, 30000);
  });
});
