package org.example.weatherapp.audit;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.net.URI;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.HashMap;
import java.util.Map;
import org.example.weatherapp.audit.AuditCatalog.Station;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClientException;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.util.UriComponentsBuilder;

/**
 * Фактические наблюдения наземных станций из сводок METAR.
 * Здесь же данные приводятся к единой системе единиц и проходят проверку
 * на физическую правдоподобность — до склейки с прогнозами.
 */
@Component
class ObservationClient {

    private static final String METAR_URL = "https://aviationweather.gov/api/data/metar";
    private static final double KNOT_TO_MS = 0.514444;
    /** Наблюдение дальше этого от начала часа не считаем наблюдением этого часа. */
    private static final long MAX_OFFSET_MINUTES = 20;

    record Observation(Double temperature, Double humidity, Double pressure, Double wind) {}

    record StationObservations(
            Station station,
            double latitude,
            double longitude,
            int elevation,
            Map<Instant, Observation> byHour,
            int rejectedValues) {}

    private final RestTemplate rest = new RestTemplate();
    private final ObjectMapper json = new ObjectMapper();

    /** Пустой результат означает, что станция сейчас не передаёт сводки. */
    StationObservations fetch(Station station, int hours) {
        URI uri = UriComponentsBuilder.fromUriString(METAR_URL)
                .queryParam("ids", station.icao())
                .queryParam("format", "json")
                .queryParam("hours", hours)
                .build()
                .toUri();

        JsonNode reports;
        try {
            byte[] body = rest.getForObject(uri, byte[].class);
            if (body == null || body.length == 0) {
                return null;
            }
            reports = json.readTree(body);
        } catch (RestClientException | IOException cause) {
            return null;
        }
        if (!reports.isArray() || reports.isEmpty()) {
            return null;
        }

        Map<Instant, Observation> nearest = new HashMap<>();
        Map<Instant, Long> offsets = new HashMap<>();
        double latitude = reports.get(0).path("lat").asDouble();
        double longitude = reports.get(0).path("lon").asDouble();
        int elevation = reports.get(0).path("elev").asInt();

        for (JsonNode report : reports) {
            if (!report.path("obsTime").isNumber()) {
                continue;
            }
            Instant observed = Instant.ofEpochSecond(report.get("obsTime").asLong());
            Instant hour = observed.plus(30, ChronoUnit.MINUTES).truncatedTo(ChronoUnit.HOURS);
            long offset = Math.abs(ChronoUnit.MINUTES.between(hour, observed));
            if (offset > MAX_OFFSET_MINUTES || offset >= offsets.getOrDefault(hour, Long.MAX_VALUE)) {
                continue;
            }

            Double temperature = number(report, "temp");
            Double dewPoint = number(report, "dewp");
            // Настоящее давление на уровне моря есть не везде; иначе берём QNH.
            Double pressure = number(report, "slp") != null ? number(report, "slp") : number(report, "altim");
            Double knots = number(report, "wspd");

            Double humidity = temperature != null && dewPoint != null
                    ? relativeHumidity(temperature, dewPoint)
                    : null;
            Double wind = knots != null ? knots * KNOT_TO_MS : null;

            offsets.put(hour, offset);
            nearest.put(hour, new Observation(temperature, humidity, pressure, wind));
        }

        // Правдоподобность проверяем только у наблюдений, попавших в итоговый ряд.
        Map<Instant, Observation> byHour = new HashMap<>();
        int rejected = 0;
        for (Map.Entry<Instant, Observation> entry : nearest.entrySet()) {
            Observation raw = entry.getValue();
            Observation clean = new Observation(
                    within(raw.temperature(), -80, 60),
                    within(raw.humidity(), 1, 100),
                    within(raw.pressure(), 870, 1085),
                    within(raw.wind(), 0, 75));
            rejected += countPresent(raw) - countPresent(clean);
            byHour.put(entry.getKey(), clean);
        }

        return new StationObservations(station, latitude, longitude, elevation, byHour, rejected);
    }

    /** Формула Магнуса: относительная влажность по температуре и точке росы. */
    private static double relativeHumidity(double temperature, double dewPoint) {
        double saturated = Math.exp(17.625 * temperature / (243.04 + temperature));
        double actual = Math.exp(17.625 * dewPoint / (243.04 + dewPoint));
        return Math.min(100, 100 * actual / saturated);
    }

    private static Double number(JsonNode node, String field) {
        JsonNode value = node.get(field);
        return value != null && value.isNumber() ? value.asDouble() : null;
    }

    private static Double within(Double value, double min, double max) {
        return value != null && value >= min && value <= max ? value : null;
    }

    private static int countPresent(Observation observation) {
        int count = 0;
        for (Double value : new Double[] {
                observation.temperature(), observation.humidity(), observation.pressure(), observation.wind()}) {
            if (value != null) {
                count++;
            }
        }
        return count;
    }
}
