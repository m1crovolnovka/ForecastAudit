// Последовательная шкала одного оттенка: на тёмном фоне малая ошибка
// уходит в фон, большая светлеет.
const RAMP = [
  '#0d366b', '#104281', '#184f95', '#1c5cab', '#256abf',
  '#2a78d6', '#3987e5', '#5598e7', '#6da7ec', '#86b6ef',
]

const PRECISION = { temperature: 2, humidity: 1, pressure: 2, wind: 2 }

const root = document.getElementById('audit')
const tip = document.getElementById('tip')

let report = null
let variable = 'temperature'
let horizon = 24
// Подсказки собираются из этого списка по индексу, а не из HTML-атрибутов.
let tips = []

function escape(value) {
  return String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  )
}

function format(value, digits) {
  return value.toFixed(digits)
}

function signed(value, digits) {
  if (Math.abs(value) < 0.5 * 10 ** -digits) return `±${(0).toFixed(digits)}`
  return `${value > 0 ? '+' : '−'}${Math.abs(value).toFixed(digits)}`
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function rampColor(t) {
  const x = Math.min(1, Math.max(0, t)) * (RAMP.length - 1)
  const i = Math.min(RAMP.length - 2, Math.floor(x))
  const f = x - i
  const a = hexToRgb(RAMP[i])
  const b = hexToRgb(RAMP[i + 1])
  return `rgb(${a.map((v, k) => Math.round(v + (b[k] - v) * f)).join(',')})`
}

/** Тёмные чернила на светлых ячейках, светлые — на тёмных. */
function inkFor(rgb) {
  const [r, g, b] = rgb.match(/\d+/g).map((v) => {
    const c = Number(v) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b
  return luminance > 0.28 ? '#020617' : '#f8fafc'
}

function cellFor(region, model) {
  return report.cells.find(
    (cell) =>
      cell.region === region &&
      cell.model === model &&
      cell.variable === variable &&
      cell.horizon === horizon,
  )
}

function variableInfo() {
  return report.variables.find((item) => item.id === variable)
}

function numberRu(value) {
  return value.toLocaleString('ru-RU')
}

function renderSkeleton() {
  root.innerHTML = `
    <div class="audit-loading">
      <i data-lucide="refresh-cw" class="icon spin" aria-hidden="true"></i>
      Собираем сводки 18 станций и архив прогнозов 7 моделей — первый расчёт занимает до 20 секунд.
    </div>
    <div class="skeleton audit-skeleton" aria-hidden="true">
      <div class="skeleton__pair skeleton__pair--four">
        <div class="skeleton__bar skeleton__bar--tile"></div>
        <div class="skeleton__bar skeleton__bar--tile"></div>
        <div class="skeleton__bar skeleton__bar--tile"></div>
        <div class="skeleton__bar skeleton__bar--tile"></div>
      </div>
      <div class="skeleton__bar skeleton__bar--block"></div>
    </div>`
  lucide.createIcons()
}

function statsMarkup() {
  const t = report.totals
  const items = [
    ['Станций в работе', `${t.stationsActive} из ${t.stationsTotal}`, 'наземные станции METAR'],
    ['Наблюдений', numberRu(t.observations), `станция·час за ${report.windowHours} ч`],
    ['Пар прогноз–факт', numberRu(t.pairs), '7 моделей × 4 параметра × 3 горизонта'],
    ['Отброшено значений', numberRu(t.rejectedValues), 'не прошли проверку правдоподобности'],
  ]
  return `
    <dl class="stats">
      ${items
        .map(
          ([label, value, note]) => `
        <div class="stats__item">
          <dt class="stats__label">${escape(label)}</dt>
          <dd class="stats__value tabular">${escape(value)}</dd>
          <dd class="stats__note">${escape(note)}</dd>
        </div>`,
        )
        .join('')}
    </dl>`
}

function controlsMarkup() {
  const variables = report.variables
    .map(
      (item) => `
      <button type="button" class="segmented__btn${item.id === variable ? ' segmented__btn--active' : ''}"
        data-variable="${escape(item.id)}" aria-pressed="${item.id === variable}">${escape(item.label)}</button>`,
    )
    .join('')
  const horizons = report.horizons
    .map(
      (hours) => `
      <button type="button" class="segmented__btn${hours === horizon ? ' segmented__btn--active' : ''}"
        data-horizon="${hours}" aria-pressed="${hours === horizon}">${hours} ч</button>`,
    )
    .join('')

  return `
    <div class="controls">
      <div class="controls__group">
        <span class="controls__label" id="variable-label">Параметр</span>
        <div class="segmented" role="group" aria-labelledby="variable-label">${variables}</div>
      </div>
      <div class="controls__group">
        <span class="controls__label" id="horizon-label">Прогноз выпущен за</span>
        <div class="segmented" role="group" aria-labelledby="horizon-label">${horizons}</div>
      </div>
    </div>`
}

function heatmapMarkup() {
  const info = variableInfo()
  const digits = PRECISION[variable]
  const world = report.regions[report.regions.length - 1]

  // Строки упорядочены по средней ошибке в мире: сверху самая точная модель.
  const models = [...report.models].sort((a, b) => {
    const ca = cellFor(world, a.id)
    const cb = cellFor(world, b.id)
    return (ca?.mae ?? Infinity) - (cb?.mae ?? Infinity)
  })

  const values = report.cells
    .filter((cell) => cell.variable === variable && cell.horizon === horizon)
    .map((cell) => cell.mae)
  const min = Math.min(...values)
  const max = Math.max(...values)

  const best = {}
  for (const region of report.regions) {
    let leader = null
    for (const model of report.models) {
      const cell = cellFor(region, model.id)
      if (cell && (!leader || cell.mae < leader.mae)) leader = cell
    }
    best[region] = leader?.model
  }

  const head = report.regions
    .map(
      (region) =>
        `<th scope="col" class="heat__col${region === world ? ' heat__col--world' : ''}">${escape(region)}</th>`,
    )
    .join('')

  const rows = models
    .map((model) => {
      const cells = report.regions
        .map((region) => {
          const cell = cellFor(region, model.id)
          const worldClass = region === world ? ' heat__cell--world' : ''
          if (!cell) {
            return `<td class="heat__cell heat__cell--empty${worldClass}">нет данных</td>`
          }
          const background = rampColor(max === min ? 0.5 : (cell.mae - min) / (max - min))
          const leader = best[region] === model.id
          const index = tips.push({ model, region, cell, info, digits }) - 1
          return `
            <td class="heat__cell${leader ? ' heat__cell--best' : ''}${worldClass}"
                style="background:${background};color:${inkFor(background)}"
                data-tip="${index}" tabindex="0">
              <span class="heat__value tabular">${format(cell.mae, digits)}</span>
              ${leader ? '<span class="heat__badge">лучшая</span>' : ''}
            </td>`
        })
        .join('')
      return `
        <tr>
          <th scope="row" class="heat__model">
            <span class="heat__model-name">${escape(model.name)}</span>
            <span class="heat__model-origin">${escape(model.origin)}</span>
          </th>
          ${cells}
        </tr>`
    })
    .join('')

  const pressureNote =
    variable === 'pressure'
      ? (() => {
          const skipped = report.stations.filter((s) => s.observations > 0 && !s.pressureCompared)
          return skipped.length
            ? `<p class="section__note">Давление не сверяем на станциях выше ${report.pressureMaxElevation} м
               (${skipped.map((s) => `${escape(s.city)}, ${s.elevation} м`).join('; ')}): там METAR сообщает QNH,
               приведённое по стандартной атмосфере, и оно расходится с давлением моделей независимо от качества прогноза.</p>`
            : ''
        })()
      : ''

  return `
    <section class="section">
      <h2 class="section__title">
        <i data-lucide="grid-3x3" class="icon" aria-hidden="true"></i>
        Средняя абсолютная ошибка (MAE), ${escape(info.unit)}
      </h2>
      <p class="section__note">Чем ярче ячейка, тем сильнее модель ошибается. Строки отсортированы по точности в мире.</p>
      ${pressureNote}
      <div class="heat-wrap">
        <table class="heat">
          <caption class="sr-only">
            MAE по параметру «${escape(info.label)}» для прогнозов, выпущенных за ${horizon} ч до целевого часа
          </caption>
          <thead><tr><th scope="col" class="heat__corner">Модель</th>${head}</tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div class="scale" aria-hidden="true">
        <span class="scale__label tabular">${format(min, digits)} ${escape(info.unit)}</span>
        <span class="scale__bar" style="background:linear-gradient(90deg, ${RAMP.join(', ')})"></span>
        <span class="scale__label tabular">${format(max, digits)} ${escape(info.unit)}</span>
      </div>
    </section>`
}

function rankingMarkup() {
  const info = variableInfo()
  const digits = PRECISION[variable]
  const world = report.regions[report.regions.length - 1]
  const ranked = report.models
    .map((model) => ({ model, cell: cellFor(world, model.id) }))
    .filter((item) => item.cell)
    .sort((a, b) => a.cell.mae - b.cell.mae)
  const max = Math.max(...ranked.map((item) => item.cell.mae))

  const rows = ranked
    .map(({ model, cell }, position) => {
      const index = tips.push({ model, region: world, cell, info, digits }) - 1
      return `
        <li class="bars__row" data-tip="${index}" tabindex="0">
          <span class="bars__rank tabular">${position + 1}</span>
          <span class="bars__name">${escape(model.name)}</span>
          <span class="bars__track">
            <span class="bars__fill" style="width:${((cell.mae / max) * 100).toFixed(1)}%"></span>
          </span>
          <span class="bars__value tabular">${format(cell.mae, digits)} ${escape(info.unit)}</span>
        </li>`
    })
    .join('')

  const leader = ranked[0]
  const runnerUp = ranked[1]
  const margin = runnerUp ? ((runnerUp.cell.mae - leader.cell.mae) / runnerUp.cell.mae) * 100 : 0

  return `
    <section class="section">
      <h2 class="section__title">
        <i data-lucide="trophy" class="icon" aria-hidden="true"></i>
        Рейтинг моделей по миру
      </h2>
      <p class="section__note">
        ${escape(leader.model.name)} ошибается в среднем на ${format(leader.cell.mae, digits)} ${escape(info.unit)}
        ${runnerUp ? `— на ${margin.toFixed(0)}% меньше, чем ${escape(runnerUp.model.name)} на втором месте.` : ''}
      </p>
      <ol class="bars">${rows}</ol>
    </section>`
}

function stationsMarkup() {
  const byContinent = {}
  for (const station of report.stations) {
    ;(byContinent[station.continent] ??= []).push(station)
  }
  const groups = Object.entries(byContinent)
    .map(
      ([continent, stations]) => `
      <div class="stations__group">
        <h3 class="stations__continent">${escape(continent)}</h3>
        <ul class="stations__list">
          ${stations
            .map(
              (s) => `
            <li class="stations__item${s.observations === 0 ? ' stations__item--off' : ''}">
              <span><span class="stations__city">${escape(s.city)}</span>
              <span class="stations__icao">${escape(s.icao)}</span></span>
              <span class="stations__meta tabular">${
                s.observations === 0 ? 'нет сводок' : `${s.elevation} м · ${s.observations} ч`
              }</span>
            </li>`,
            )
            .join('')}
        </ul>
      </div>`,
    )
    .join('')

  return `
    <section class="section">
      <h2 class="section__title">
        <i data-lucide="radio-tower" class="icon" aria-hidden="true"></i>
        Контрольные станции
      </h2>
      <div class="stations">${groups}</div>
    </section>`
}

function methodMarkup() {
  const generated = new Date(report.generatedAt).toLocaleString('ru-RU', {
    day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
  })
  return `
    <section class="section method">
      <h2 class="section__title">
        <i data-lucide="info" class="icon" aria-hidden="true"></i>
        Как считаем
      </h2>
      <ul class="method__list">
        <li><strong>Факт</strong> — сводки METAR аэропортов за последние ${report.windowHours} ч, по одной на час,
          не дальше 20 минут от начала часа. Ветер из узлов переводим в м/с, влажность считаем по точке росы.</li>
        <li><strong>Прогноз</strong> — архив Open-Meteo: для каждого часа берём прогноз той же модели,
          выпущенный за 1, 2 или 3 суток до него.</li>
        <li><strong>Ошибка</strong> = прогноз − факт. MAE — средняя абсолютная ошибка,
          RMSE сильнее штрафует редкие крупные промахи, смещение показывает, в какую сторону модель ошибается.</li>
      </ul>
      <p class="section__note">Расчёт от ${escape(generated)}, обновляется раз в час.</p>
    </section>`
}

function render() {
  tips = []
  root.innerHTML = `
    ${statsMarkup()}
    ${controlsMarkup()}
    ${heatmapMarkup()}
    ${rankingMarkup()}
    ${stationsMarkup()}
    ${methodMarkup()}`
  lucide.createIcons()
}

function showTip(target, x, y) {
  const item = tips[Number(target.dataset.tip)]
  if (!item) return
  const { model, region, cell, info, digits } = item
  tip.innerHTML = `
    <p class="viz-tip__title">${escape(model.name)} · ${escape(region)}</p>
    <dl class="viz-tip__grid">
      <dt>MAE</dt><dd class="tabular">${format(cell.mae, digits)} ${escape(info.unit)}</dd>
      <dt>RMSE</dt><dd class="tabular">${format(cell.rmse, digits)} ${escape(info.unit)}</dd>
      <dt>Смещение</dt><dd class="tabular">${signed(cell.bias, digits)} ${escape(info.unit)}</dd>
      <dt>Пар</dt><dd class="tabular">${numberRu(cell.samples)}</dd>
    </dl>`
  tip.hidden = false
  const box = tip.getBoundingClientRect()
  const left = Math.min(window.innerWidth - box.width - 12, x + 14)
  const top = y + box.height + 20 > window.innerHeight ? y - box.height - 14 : y + 14
  tip.style.left = `${Math.max(12, left)}px`
  tip.style.top = `${Math.max(12, top)}px`
}

function hideTip() {
  tip.hidden = true
}

root.addEventListener('pointermove', (event) => {
  const target = event.target.closest('[data-tip]')
  if (target) showTip(target, event.clientX, event.clientY)
  else hideTip()
})
root.addEventListener('pointerleave', hideTip)
root.addEventListener('focusin', (event) => {
  const target = event.target.closest('[data-tip]')
  if (!target) return
  const rect = target.getBoundingClientRect()
  showTip(target, rect.left + rect.width / 2, rect.bottom)
})
root.addEventListener('focusout', hideTip)

root.addEventListener('click', (event) => {
  const button = event.target.closest('[data-variable], [data-horizon]')
  if (!button) return
  if (button.dataset.variable) variable = button.dataset.variable
  if (button.dataset.horizon) horizon = Number(button.dataset.horizon)
  hideTip()
  render()
  // После перерисовки фокус должен остаться на нажатой кнопке.
  const selector = button.dataset.variable
    ? `[data-variable="${button.dataset.variable}"]`
    : `[data-horizon="${button.dataset.horizon}"]`
  root.querySelector(selector)?.focus()
})

async function load() {
  renderSkeleton()
  try {
    const response = await fetch('/api/audit')
    const payload = await response.json()
    if (!response.ok) throw new Error(payload.error ?? 'Не удалось получить данные аудита')
    report = payload
    render()
  } catch (cause) {
    root.innerHTML = `
      <p class="search__error" role="alert">
        <i data-lucide="circle-alert" class="icon" aria-hidden="true"></i>
        <span>${escape(cause.message)}</span>
      </p>`
    lucide.createIcons()
  }
}

load()
