import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@ailoha/agent-core";

export interface WeatherReading {
	readonly location: string;
	readonly condition: string;
	readonly temperatureC: number;
	readonly humidityPercent?: number;
	readonly observedAt?: string;
}

export type WeatherProvider = (
	location: string,
	options: { readonly signal: AbortSignal },
) => WeatherReading | undefined | Promise<WeatherReading | undefined>;

export interface WeatherToolOptions {
	readonly provider?: WeatherProvider;
	readonly readings?: readonly WeatherReading[];
}

const DEFAULT_READINGS: readonly WeatherReading[] = [
	{ location: "Beijing", condition: "clear", temperatureC: 22, humidityPercent: 38 },
	{ location: "Shanghai", condition: "cloudy", temperatureC: 25, humidityPercent: 67 },
	{ location: "Shenzhen", condition: "light rain", temperatureC: 29, humidityPercent: 81 },
];

function normalizeLocation(value: string): string {
	return value.trim().toLocaleLowerCase();
}

export function createMockWeatherProvider(readings: readonly WeatherReading[] = DEFAULT_READINGS): WeatherProvider {
	const index = new Map(readings.map((reading) => [normalizeLocation(reading.location), reading]));
	return (location) => index.get(normalizeLocation(location));
}

export function createWeatherTool(options: WeatherToolOptions = {}): AgentTool {
	const provider = options.provider ?? createMockWeatherProvider(options.readings);
	return {
		name: "weather",
		description: "Get current weather for a location from the configured weather provider.",
		parameters: Type.Object(
			{
				location: Type.String({ minLength: 1 }),
				units: Type.Optional(Type.Union([Type.Literal("celsius"), Type.Literal("fahrenheit")])),
			},
			{ additionalProperties: false },
		),
		async execute(toolCall, context) {
			const location = String(toolCall.arguments.location).trim();
			const units = toolCall.arguments.units === "fahrenheit" ? "fahrenheit" : "celsius";
			const reading = await provider(location, { signal: context.signal });
			context.signal.throwIfAborted();
			if (!reading) return { content: `No weather data for: ${location}`, isError: true };
			const temperature = units === "fahrenheit" ? (reading.temperatureC * 9) / 5 + 32 : reading.temperatureC;
			return {
				content: JSON.stringify({
					location: reading.location,
					condition: reading.condition,
					temperature,
					unit: units === "fahrenheit" ? "F" : "C",
					humidityPercent: reading.humidityPercent,
					observedAt: reading.observedAt,
				}),
			};
		},
	};
}
