package org.example.weatherapp.audit;

import java.util.List;

/** Контрольные станции, прогнозные модели и сравниваемые параметры. */
final class AuditCatalog {

    record Station(String icao, String city, String continent) {}

    record Model(String id, String name, String origin) {}

    enum Variable {
        TEMPERATURE("temperature_2m", "Температура", "°C"),
        HUMIDITY("relative_humidity_2m", "Влажность", "%"),
        PRESSURE("pressure_msl", "Давление", "гПа"),
        WIND("wind_speed_10m", "Ветер", "м/с");

        final String apiName;
        final String label;
        final String unit;

        Variable(String apiName, String label, String unit) {
            this.apiName = apiName;
            this.label = label;
            this.unit = unit;
        }
    }

    /** Горизонт — за сколько суток до целевого часа был выпущен прогноз. */
    static final List<Integer> HORIZON_DAYS = List.of(1, 2, 3);

    static final String WORLD = "Весь мир";

    static final List<String> CONTINENTS = List.of(
            "Европа", "Азия", "Северная Америка", "Южная Америка", "Африка", "Океания");

    static final List<Station> STATIONS = List.of(
            new Station("UMMS", "Минск", "Европа"),
            new Station("EGLL", "Лондон", "Европа"),
            new Station("EDDF", "Франкфурт", "Европа"),
            new Station("RJTT", "Токио", "Азия"),
            new Station("VIDP", "Дели", "Азия"),
            new Station("WSSS", "Сингапур", "Азия"),
            new Station("KJFK", "Нью-Йорк", "Северная Америка"),
            new Station("KLAX", "Лос-Анджелес", "Северная Америка"),
            new Station("CYYZ", "Торонто", "Северная Америка"),
            new Station("SBGR", "Сан-Паулу", "Южная Америка"),
            new Station("SCEL", "Сантьяго", "Южная Америка"),
            new Station("SKBO", "Богота", "Южная Америка"),
            new Station("HECA", "Каир", "Африка"),
            new Station("FAOR", "Йоханнесбург", "Африка"),
            new Station("DNMM", "Лагос", "Африка"),
            new Station("YSSY", "Сидней", "Океания"),
            new Station("YMML", "Мельбурн", "Океания"),
            new Station("NZAA", "Окленд", "Океания"));

    static final List<Model> MODELS = List.of(
            new Model("ecmwf_ifs025", "ECMWF IFS", "Европейский центр"),
            new Model("gfs_seamless", "GFS", "NOAA, США"),
            new Model("icon_seamless", "ICON", "DWD, Германия"),
            new Model("gem_seamless", "GEM", "Метеослужба Канады"),
            new Model("jma_seamless", "JMA", "Метеослужба Японии"),
            new Model("meteofrance_seamless", "ARPEGE", "Météo-France"),
            new Model("ukmo_seamless", "UKMO", "Met Office, Великобритания"));

    private AuditCatalog() {}
}
