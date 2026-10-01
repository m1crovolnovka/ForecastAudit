package org.example.weatherapp.audit;

import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.example.weatherapp.audit.AuditCatalog.Model;
import org.example.weatherapp.audit.AuditCatalog.Station;
import org.example.weatherapp.audit.AuditCatalog.Variable;
import org.example.weatherapp.audit.ForecastClient.ForecastGrid;
import org.example.weatherapp.audit.ForecastClient.SeriesKey;
import org.example.weatherapp.audit.ObservationClient.Observation;
import org.example.weatherapp.audit.ObservationClient.StationObservations;
import org.springframework.stereotype.Service;

/**
 * Пайплайн аудита в миниатюре: извлечение наблюдений и прогнозов,
 * склейка по станции и часу, агрегация ошибок в витрину.
 */
@Service
public class AuditService {

    private static final int WINDOW_HOURS = 96;
    /**
     * Выше этой высоты станция сообщает QNH, приведённое к уровню моря по стандартной
     * атмосфере, и оно расходится с давлением на уровне моря у моделей на единицы гПа.
     * Это ошибка метода, а не прогноза, поэтому давление на таких станциях не сверяем.
     */
    static final int PRESSURE_MAX_ELEVATION = 500;
    /** Прогнозы и сводки обновляются раз в час — чаще пересчитывать незачем. */
    private static final Duration CACHE_TTL = Duration.ofMinutes(60);

    private final ObservationClient observationClient;
    private final ForecastClient forecastClient;
    private final ExecutorService pool = Executors.newFixedThreadPool(6, task -> {
        Thread thread = new Thread(task, "metar-fetch");
        thread.setDaemon(true);
        return thread;
    });

    private AuditReport cached;
    private Instant cachedAt;

    public AuditService(ObservationClient observationClient, ForecastClient forecastClient) {
        this.observationClient = observationClient;
        this.forecastClient = forecastClient;
    }

    public synchronized AuditReport report() {
        if (cached == null || cachedAt.plus(CACHE_TTL).isBefore(Instant.now())) {
            cached = compute();
            cachedAt = Instant.now();
        }
        return cached;
    }

    private AuditReport compute() {
        List<CompletableFuture<StationObservations>> requests = AuditCatalog.STATIONS.stream()
                .map(station -> CompletableFuture.supplyAsync(
                        () -> observationClient.fetch(station, WINDOW_HOURS), pool))
                .toList();

        List<StationObservations> active = new ArrayList<>();
        List<AuditReport.StationStatus> statuses = new ArrayList<>();
        for (int i = 0; i < requests.size(); i++) {
            Station station = AuditCatalog.STATIONS.get(i);
            StationObservations result = requests.get(i).join();
            boolean reporting = result != null && !result.byHour().isEmpty();
            if (reporting) {
                active.add(result);
            }
            statuses.add(new AuditReport.StationStatus(
                    station.icao(), station.city(), station.continent(),
                    reporting ? result.elevation() : 0,
                    reporting ? result.byHour().size() : 0,
                    reporting && result.elevation() <= PRESSURE_MAX_ELEVATION));
        }
        if (active.isEmpty()) {
            throw new IllegalStateException("Ни одна станция не передала сводки METAR");
        }

        List<ForecastGrid> grids = forecastClient.fetch(active, WINDOW_HOURS / 24 + 1);

        Map<CellKey, Accumulator> errors = new HashMap<>();
        int observations = 0;
        int pairs = 0;
        int rejected = 0;

        for (int i = 0; i < active.size(); i++) {
            StationObservations station = active.get(i);
            ForecastGrid grid = grids.get(i);
            String continent = station.station().continent();
            boolean comparablePressure = station.elevation() <= PRESSURE_MAX_ELEVATION;
            rejected += station.rejectedValues();

            for (Map.Entry<Instant, Observation> entry : station.byHour().entrySet()) {
                observations++;
                Integer index = grid.hourIndex().get(entry.getKey());
                if (index == null) {
                    continue;
                }
                for (Model model : AuditCatalog.MODELS) {
                    for (Variable variable : Variable.values()) {
                        Double actual = actual(entry.getValue(), variable);
                        if (actual == null || (variable == Variable.PRESSURE && !comparablePressure)) {
                            continue;
                        }
                        for (int days : AuditCatalog.HORIZON_DAYS) {
                            double[] series = grid.series().get(new SeriesKey(model.id(), variable, days));
                            if (series == null || index >= series.length || Double.isNaN(series[index])) {
                                continue;
                            }
                            double error = series[index] - actual;
                            errors.computeIfAbsent(new CellKey(continent, model.id(), variable, days),
                                    key -> new Accumulator()).add(error);
                            errors.computeIfAbsent(new CellKey(AuditCatalog.WORLD, model.id(), variable, days),
                                    key -> new Accumulator()).add(error);
                            pairs++;
                        }
                    }
                }
            }
        }

        List<AuditReport.Cell> cells = errors.entrySet().stream()
                .map(entry -> entry.getValue().toCell(entry.getKey()))
                .toList();

        List<String> regions = new ArrayList<>(AuditCatalog.CONTINENTS);
        regions.add(AuditCatalog.WORLD);

        return new AuditReport(
                Instant.now().truncatedTo(ChronoUnit.SECONDS).toString(),
                WINDOW_HOURS,
                PRESSURE_MAX_ELEVATION,
                AuditCatalog.MODELS.stream()
                        .map(model -> new AuditReport.ModelInfo(model.id(), model.name(), model.origin()))
                        .toList(),
                List.of(Variable.values()).stream()
                        .map(variable -> new AuditReport.VariableInfo(
                                variable.name().toLowerCase(Locale.ROOT), variable.label, variable.unit))
                        .toList(),
                AuditCatalog.HORIZON_DAYS.stream().map(days -> days * 24).toList(),
                regions,
                cells,
                new AuditReport.Totals(active.size(), AuditCatalog.STATIONS.size(), observations, pairs, rejected),
                statuses);
    }

    private static Double actual(Observation observation, Variable variable) {
        return switch (variable) {
            case TEMPERATURE -> observation.temperature();
            case HUMIDITY -> observation.humidity();
            case PRESSURE -> observation.pressure();
            case WIND -> observation.wind();
        };
    }

    private record CellKey(String region, String model, Variable variable, int horizonDays) {}

    private static final class Accumulator {
        private double absolute;
        private double squared;
        private double signed;
        private int count;

        void add(double error) {
            absolute += Math.abs(error);
            squared += error * error;
            signed += error;
            count++;
        }

        AuditReport.Cell toCell(CellKey key) {
            return new AuditReport.Cell(
                    key.region(),
                    key.model(),
                    key.variable().name().toLowerCase(Locale.ROOT),
                    key.horizonDays() * 24,
                    absolute / count,
                    Math.sqrt(squared / count),
                    signed / count,
                    count);
        }
    }
}
